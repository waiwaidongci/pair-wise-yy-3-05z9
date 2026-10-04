// 班次账领域模块：把样本、切片批次、制片步骤、交付台账接成班次账。
// 核心机制：
//   1. 同一台切片机先到者开工，后到内容留冲突（机器级互斥）。
//   2. 切割角度/厚度/染色方法变更 -> 未完成切片、步骤顺序、交付结论失效重算，已完成步骤可追溯。
//   3. 写盘失败按班次单恢复到最后确认步骤；重试靠幂等键不重复生成切片/步骤。
//   4. 跨班接管登记交接人与覆盖范围；越权修改直接拒绝。
//   5. 无班次单的老样本按创建日期补成待接管批次。

import { randomUUID } from "node:crypto";

export const STEPS = ["取样", "切割", "研磨", "染色", "观察"];
export const MACHINES = ["M-01", "M-02", "M-03"];
export const SAMPLE_STATUSES = ["待切割", "制片中", "待观察", "已交付"];

export const uid = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

export function httpError(status, error, extra = {}) {
  return Object.assign(new Error(error), { status, error, rejected: true, ...extra });
}

function naturalKey(input, type, parts) {
  return input.idemKey || `${type}:${parts.filter(Boolean).join(":")}`;
}

function ensureArrays(db) {
  db.samples ??= [];
  db.shiftOrders ??= [];
  db.conflicts ??= [];
  db.journal ??= [];
  db.batches ??= [];
  db.deliveryLedger ??= [];
  db.paramChanges ??= [];
  return db;
}

export class ShiftLedger {
  // save: async (db) => Promise<void>；failWrites: 0~1 概率或 () => boolean，用于演示写盘失败。
  constructor(db, { save, now = () => new Date().toISOString(), failWrites = 0 } = {}) {
    this.db = ensureArrays(db);
    this.save = save;
    this.now = now;
    this.failWrites = failWrites;
    this._inflight = new Map();
  }

  _shouldFail() {
    if (typeof this.failWrites === "function") return !!this.failWrites();
    return Math.random() < this.failWrites;
  }

  // ---- 日志 / 幂等 / 恢复 ----
  async _commit(op) {
    if (this._inflight.has(op.idemKey)) return this._inflight.get(op.idemKey);
    const p = this._commitInner(op);
    this._inflight.set(op.idemKey, p);
    try {
      return await p;
    } finally {
      this._inflight.delete(op.idemKey);
    }
  }

  async _commitInner(op) {
    const existing = this.db.journal.find((j) => j.idemKey === op.idemKey);
    if (existing && existing.status === "confirmed") {
      return { idempotent: true, op: existing, result: existing.result };
    }
    const entry = {
      id: uid("OP"),
      idemKey: op.idemKey,
      shiftOrderId: op.shiftOrderId || null,
      type: op.type,
      payload: op.payload,
      status: "pending",
      attempts: existing ? existing.attempts + 1 : 1,
      result: null,
      error: null,
      createdAt: this.now(),
      confirmedAt: null,
    };
    this.db.journal.push(entry);
    const snapshot = structuredClone(this.db);
    try {
      const result = op.apply(this.db);
      if (this._shouldFail()) throw new Error("write_failed_disk");
      await this.save(this.db);
      entry.status = "confirmed";
      entry.result = result;
      entry.confirmedAt = this.now();
      await this.save(this.db);
      return { idempotent: false, op: entry, result };
    } catch (err) {
      this._restore(snapshot);
      if (err && err.rejected) throw err; // 校验/越权拒绝：未改动数据，直接抛出
      const failed = this.db.journal.find((j) => j.id === entry.id);
      if (failed) {
        failed.status = "failed";
        failed.error = err.message;
      }
      try {
        await this.save(this.db);
      } catch {
        /* 尽力而为 */
      }
      throw Object.assign(new Error("write_failed_recovered"), {
        status: 500,
        error: "write_failed_recovered",
        cause: err.message,
        opId: entry.id,
      });
    }
  }

  _restore(snapshot) {
    for (const key of Object.keys(this.db)) delete this.db[key];
    Object.assign(this.db, structuredClone(snapshot));
  }

  // ---- 查询 ----
  listShiftOrders() {
    return this.db.shiftOrders;
  }
  listConflicts() {
    return this.db.conflicts;
  }
  listJournal() {
    return this.db.journal;
  }
  listBatches() {
    return this.db.batches;
  }
  listDeliveryLedger() {
    return this.db.deliveryLedger;
  }
  listParamChanges() {
    return this.db.paramChanges;
  }
  activeShiftForMachine(machineId) {
    return this.db.shiftOrders.find((s) => s.machineId === machineId && s.status === "进行中");
  }

  // ---- 越权 / 范围校验 ----
  _requireShift(shiftOrderId, operator, { sampleId, sliceId } = {}) {
    if (!shiftOrderId) throw httpError(400, "shift_order_required");
    const so = this.db.shiftOrders.find((s) => s.id === shiftOrderId);
    if (!so) throw httpError(404, "shift_order_not_found");
    if (so.status === "待接管") throw httpError(409, "shift_pending_takeover");
    if (so.status === "已确认") throw httpError(409, "shift_already_confirmed");
    if (so.handoverTo !== operator) throw httpError(403, "unauthorized_operator");
    if (sampleId && !so.scope.sampleIds.includes(sampleId))
      throw httpError(403, "out_of_scope_sample");
    if (sliceId && !so.scope.sliceIds.includes(sliceId))
      throw httpError(403, "out_of_scope_slice");
    return so;
  }

  _updateSampleStatus(sample) {
    const sliceStatuses = sample.slices.map((s) => s.status);
    if (sample.delivery === "已交付") sample.status = "已交付";
    else if (sliceStatuses.length && sliceStatuses.every((step) => step === "观察"))
      sample.status = "待观察";
    else if (sliceStatuses.some((step) => ["取样", "切割", "研磨", "染色"].includes(step)))
      sample.status = "制片中";
    else sample.status = "待切割";
  }

  // ---- 开班 / 跨班接管（先到者开工，后到内容留冲突）----
  async startShift(input) {
    const idemKey = naturalKey(input, "start", [
      input.machineId,
      input.handoverTo,
      input.shift,
      input.priorShiftOrderId,
    ]);
    return this._commit({
      idemKey,
      shiftOrderId: null,
      type: "start_shift",
      payload: input,
      apply: (db) => {
        const machineId = input.machineId;
        if (!MACHINES.includes(machineId))
          throw httpError(400, "unknown_machine", { rejected: true });
        if (!input.handoverFrom || !input.handoverTo)
          throw httpError(400, "handover_required", { rejected: true });
        const active = db.shiftOrders.find(
          (s) => s.machineId === machineId && s.status === "进行中"
        );
        if (active) {
          // 后到内容留冲突，不开工
          const conflict = {
            id: uid("CONF"),
            machineId,
            contending: {
              shift: input.shift,
              handoverFrom: input.handoverFrom,
              handoverTo: input.handoverTo,
              scope: input.scope || { sampleIds: [], sliceIds: [], steps: [...STEPS] },
              priorShiftOrderId: input.priorShiftOrderId || null,
            },
            winningShiftOrderId: active.id,
            reason: "machine_busy",
            status: "open",
            createdAt: this.now(),
          };
          db.conflicts.push(conflict);
          return { conflict, machineBusy: true };
        }
        // 接管待接管（回填）批次：登记交接人与覆盖范围，转为进行中。
        const pending = db.shiftOrders.find(
          (s) => s.machineId === machineId && s.status === "待接管" && s.backfill
        );
        if (pending) {
          pending.handoverFrom = input.handoverFrom;
          pending.handoverTo = input.handoverTo;
          pending.shift = input.shift;
          if (input.priorShiftOrderId) pending.priorShiftOrderId = input.priorShiftOrderId;
          if (input.scope?.sampleIds)
            for (const id of input.scope.sampleIds)
              if (!pending.scope.sampleIds.includes(id)) pending.scope.sampleIds.push(id);
          if (input.scope?.sliceIds)
            for (const id of input.scope.sliceIds)
              if (!pending.scope.sliceIds.includes(id)) pending.scope.sliceIds.push(id);
          pending.status = "进行中";
          pending.takenOverAt = this.now();
          const batch = db.batches.find((b) => b.id === pending.batchId);
          if (batch) batch.status = "进行中";
          return { shiftOrder: pending, batch, machineBusy: false, tookOver: true };
        }
        const shiftOrder = {
          id: uid("SHIFT"),
          machineId,
          shift: input.shift,
          handoverFrom: input.handoverFrom,
          handoverTo: input.handoverTo,
          scope: {
            sampleIds: input.scope?.sampleIds ? [...input.scope.sampleIds] : [],
            sliceIds: input.scope?.sliceIds ? [...input.scope.sliceIds] : [],
            steps: input.scope?.steps ? [...input.scope.steps] : [...STEPS],
          },
          status: "进行中",
          priorShiftOrderId: input.priorShiftOrderId || null,
          backfill: false,
          createdAt: this.now(),
          takenOverAt: this.now(),
          confirmedAt: null,
        };
        db.shiftOrders.push(shiftOrder);
        const batch = {
          id: uid("BATCH"),
          shiftOrderId: shiftOrder.id,
          machineId,
          sampleIds: [...shiftOrder.scope.sampleIds],
          sliceIds: [...shiftOrder.scope.sliceIds],
          status: "进行中",
          createdAt: this.now(),
        };
        db.batches.push(batch);
        shiftOrder.batchId = batch.id;
        return { shiftOrder, batch, machineBusy: false };
      },
    });
  }

  // ---- 创建样本 ----
  async createSample(input) {
    const idemKey = naturalKey(input, "sample", [
      input.shiftOrderId,
      input.project,
      input.borehole,
      input.coreBox,
      input.depth,
      input.owner,
    ]);
    return this._commit({
      idemKey,
      shiftOrderId: input.shiftOrderId,
      type: "create_sample",
      payload: input,
      apply: (db) => {
        const so = this._requireShift(input.shiftOrderId, input.operator);
        if (input.machineId && input.machineId !== so.machineId)
          throw httpError(403, "out_of_scope_machine", { rejected: true });
        const sample = {
          id: input.id || uid("CORE"),
          project: input.project,
          borehole: input.borehole,
          coreBox: input.coreBox,
          depth: input.depth,
          owner: input.owner,
          machineId: input.machineId || so.machineId,
          angle: input.angle || "",
          thickness: input.thickness || "",
          status: "待切割",
          delivery: "未交付",
          deliveryRecalc: false,
          sequenceInvalid: false,
          createdAt: this.now(),
          shiftOrderId: so.id,
          slices: [],
        };
        const slice = {
          id: input.sliceId || uid("SL"),
          method: input.method || "未指定",
          angle: sample.angle,
          thickness: sample.thickness,
          observation: "",
          status: "取样",
          needsRecalc: false,
          traceable: false,
          logs: [
            {
              at: this.now(),
              step: "取样",
              note: "创建初始切片任务",
              shiftOrderId: so.id,
            },
          ],
        };
        sample.slices.push(slice);
        so.scope.sampleIds.push(sample.id);
        so.scope.sliceIds.push(slice.id);
        const batch = db.batches.find((b) => b.id === so.batchId);
        if (batch) {
          batch.sampleIds.push(sample.id);
          batch.sliceIds.push(slice.id);
        }
        this._updateSampleStatus(sample);
        db.samples.unshift(sample);
        return { sample };
      },
    });
  }

  // ---- 新增切片 ----
  async addSlice(input) {
    const idemKey = naturalKey(input, "add_slice", [
      input.shiftOrderId,
      input.sampleId,
      input.id,
    ]);
    return this._commit({
      idemKey,
      shiftOrderId: input.shiftOrderId,
      type: "add_slice",
      payload: input,
      apply: (db) => {
        const so = this._requireShift(input.shiftOrderId, input.operator, {
          sampleId: input.sampleId,
        });
        const sample = db.samples.find((s) => s.id === input.sampleId);
        if (!sample) throw httpError(404, "sample_not_found", { rejected: true });
        if (input.id && sample.slices.some((s) => s.id === input.id))
          throw httpError(409, "slice_exists", { rejected: true });
        const slice = {
          id: input.id || uid("SL"),
          method: input.method || sample.method || "未指定",
          angle: sample.angle,
          thickness: sample.thickness,
          observation: "",
          status: "取样",
          needsRecalc: false,
          traceable: false,
          logs: [
            {
              at: this.now(),
              step: "取样",
              note: "新增切片任务",
              shiftOrderId: so.id,
            },
          ],
        };
        sample.slices.push(slice);
        so.scope.sliceIds.push(slice.id);
        const batch = db.batches.find((b) => b.id === so.batchId);
        if (batch) batch.sliceIds.push(slice.id);
        this._updateSampleStatus(sample);
        return { sample, slice };
      },
    });
  }

  // ---- 记录制片步骤（步骤顺序失效重算）----
  async logStep(input) {
    const idemKey = naturalKey(input, "step", [
      input.shiftOrderId,
      input.sampleId,
      input.sliceId,
      input.step,
      input.note,
    ]);
    return this._commit({
      idemKey,
      shiftOrderId: input.shiftOrderId,
      type: "log_step",
      payload: input,
      apply: (db) => {
        const so = this._requireShift(input.shiftOrderId, input.operator, {
          sampleId: input.sampleId,
          sliceId: input.sliceId,
        });
        const sample = db.samples.find((s) => s.id === input.sampleId);
        if (!sample) throw httpError(404, "sample_not_found", { rejected: true });
        const slice = sample.slices.find((s) => s.id === input.sliceId);
        if (!slice) throw httpError(404, "slice_not_found", { rejected: true });
        // 步骤顺序失效重算：已完成步骤可追溯，未完成部分按新参数重排。
        if (slice.needsRecalc) {
          const completed = new Set(slice.logs.map((l) => l.step));
          const expected = STEPS.find((s) => !completed.has(s));
          if (input.step !== expected) {
            throw httpError(409, "sequence_recalc_mismatch", {
              rejected: true,
              expected,
              got: input.step,
            });
          }
        }
        slice.status = input.step;
        if (input.step === "观察") slice.observation = input.note || slice.observation;
        slice.logs.push({
          at: this.now(),
          step: input.step,
          note: input.note || "步骤完成",
          shiftOrderId: so.id,
        });
        slice.needsRecalc = false;
        sample.sequenceInvalid = false;
        this._updateSampleStatus(sample);
        return { sample, slice };
      },
    });
  }

  // ---- 参数变更：未完成切片、步骤顺序、交付结论失效重算 ----
  async changeParams(input) {
    const idemKey = naturalKey(input, "params", [
      input.shiftOrderId,
      input.sampleId,
      input.angle,
      input.thickness,
      input.method,
    ]);
    return this._commit({
      idemKey,
      shiftOrderId: input.shiftOrderId,
      type: "change_params",
      payload: input,
      apply: (db) => {
        const so = this._requireShift(input.shiftOrderId, input.operator, {
          sampleId: input.sampleId,
        });
        const sample = db.samples.find((s) => s.id === input.sampleId);
        if (!sample) throw httpError(404, "sample_not_found", { rejected: true });
        const before = {
          angle: sample.angle,
          thickness: sample.thickness,
          method: sample.method,
        };
        if (input.angle !== undefined) sample.angle = input.angle;
        if (input.thickness !== undefined) sample.thickness = input.thickness;
        if (input.method !== undefined) sample.method = input.method;
        const changed =
          before.angle !== sample.angle ||
          before.thickness !== sample.thickness ||
          before.method !== sample.method;
        if (!changed)
          throw httpError(400, "params_unchanged", { rejected: true });

        const affected = [];
        for (const slice of sample.slices) {
          if (slice.status === "观察") {
            // 已完成步骤仍可追溯，不失效。
            slice.traceable = true;
            continue;
          }
          // 未完成切片失效重算：已完成步骤保留在日志中可追溯。
          slice.needsRecalc = true;
          slice.status = "取样";
          slice.angle = sample.angle;
          slice.thickness = sample.thickness;
          slice.method = sample.method;
          slice.logs.push({
            at: this.now(),
            step: "参数变更",
            note: `参数变更（角度 ${before.angle || "-"}→${sample.angle || "-"}，厚度 ${before.thickness || "-"}→${sample.thickness || "-"}，染色 ${before.method || "-"}→${sample.method || "-"}）；已完成步骤可追溯，未完成部分重算`,
            shiftOrderId: so.id,
          });
          affected.push(slice.id);
        }
        // 步骤顺序失效
        sample.sequenceInvalid = true;
        // 交付结论失效
        let deliveryReverted = false;
        if (sample.delivery === "已交付") {
          sample.delivery = "未交付";
          sample.deliveryRecalc = true;
          sample.deliveryRecalcReason = "参数变更导致交付结论失效";
          deliveryReverted = true;
          for (const led of db.deliveryLedger) {
            if (led.sampleId === sample.id && led.status === "有效") {
              led.status = "失效";
              led.invalidatedAt = this.now();
              led.invalidatedBy = so.id;
              led.reason = "参数变更";
            }
          }
        }
        db.paramChanges.push({
          id: uid("PC"),
          shiftOrderId: so.id,
          sampleId: sample.id,
          before,
          after: { angle: sample.angle, thickness: sample.thickness, method: sample.method },
          affectedSlices: affected,
          deliveryReverted,
          at: this.now(),
        });
        this._updateSampleStatus(sample);
        return { sample, affectedSlices: affected, deliveryReverted };
      },
    });
  }

  // ---- 交付（交付台账）----
  async deliver(input) {
    const idemKey = naturalKey(input, "deliver", [input.shiftOrderId, input.sampleId]);
    return this._commit({
      idemKey,
      shiftOrderId: input.shiftOrderId,
      type: "deliver",
      payload: input,
      apply: (db) => {
        const so = this._requireShift(input.shiftOrderId, input.operator, {
          sampleId: input.sampleId,
        });
        const sample = db.samples.find((s) => s.id === input.sampleId);
        if (!sample) throw httpError(404, "sample_not_found", { rejected: true });
        if (sample.delivery === "已交付")
          throw httpError(409, "already_delivered", { rejected: true });
        sample.delivery = "已交付";
        sample.deliveryRecalc = false;
        const ledger = {
          id: uid("DL"),
          shiftOrderId: so.id,
          sampleId: sample.id,
          batchId: so.batchId,
          conclusion: input.conclusion || "符合交付要求",
          operator: input.operator,
          status: "有效",
          deliveredAt: this.now(),
        };
        db.deliveryLedger.push(ledger);
        this._updateSampleStatus(sample);
        return { sample, ledger };
      },
    });
  }

  // ---- 确认班次单（收尾）----
  async confirmShift(input) {
    const idemKey = naturalKey(input, "confirm", [input.shiftOrderId]);
    return this._commit({
      idemKey,
      shiftOrderId: input.shiftOrderId,
      type: "confirm_shift",
      payload: input,
      apply: (db) => {
        const so = db.shiftOrders.find((s) => s.id === input.shiftOrderId);
        if (!so) throw httpError(404, "shift_order_not_found", { rejected: true });
        if (so.status !== "进行中")
          throw httpError(409, "shift_not_active", { rejected: true });
        if (so.handoverTo !== input.operator)
          throw httpError(403, "unauthorized_operator", { rejected: true });
        so.status = "已确认";
        so.confirmedAt = this.now();
        const batch = db.batches.find((b) => b.id === so.batchId);
        if (batch) batch.status = "已完成";
        return { shiftOrder: so };
      },
    });
  }

  // ---- 恢复：按班次单恢复到最后确认步骤 ----
  async recover() {
    const result = { rolledBack: [], inFlight: [] };
    for (const j of this.db.journal) {
      if (this._inflight.has(j.idemKey)) {
        result.inFlight.push(j.id);
        continue;
      }
      if (j.status === "pending" || j.status === "failed") {
        j.status = "rolled_back";
        result.rolledBack.push(j.id);
      }
    }
    await this.save(this.db);
    return result;
  }

  // 某班次单最后一次确认的操作（恢复锚点）
  lastConfirmed(shiftOrderId) {
    const confirmed = this.db.journal
      .filter((j) => j.shiftOrderId === shiftOrderId && j.status === "confirmed")
      .sort((a, b) => new Date(b.confirmedAt) - new Date(a.confirmedAt));
    return confirmed[0] || null;
  }

  // ---- 回填：无班次单的老样本按创建日期补成待接管批次 ----
  async backfill() {
    const covered = new Set();
    for (const so of this.db.shiftOrders)
      for (const id of so.scope.sampleIds) covered.add(id);
    const uncovered = this.db.samples.filter((s) => !covered.has(s.id));
    if (!uncovered.length) return { created: [], uncovered: 0 };
    const idemKey = `backfill:${uncovered.map((s) => s.id).sort().join(",")}`;
    return this._commit({
      idemKey,
      shiftOrderId: null,
      type: "backfill",
      payload: { ids: uncovered.map((s) => s.id) },
      apply: (db) => {
        const created = [];
        const sorted = [...uncovered].sort((a, b) => {
          const ta = new Date(a.createdAt || a.logs?.[0]?.at || 0).getTime();
          const tb = new Date(b.createdAt || b.logs?.[0]?.at || 0).getTime();
          return ta - tb;
        });
        for (const sample of sorted) {
          const machineId = sample.machineId || "M-01";
          let so = db.shiftOrders.find(
            (s) => s.status === "待接管" && s.machineId === machineId && s.backfill
          );
          if (!so) {
            so = {
              id: uid("SHIFT"),
              machineId,
              shift: "待接管",
              handoverFrom: "",
              handoverTo: "",
              scope: { sampleIds: [], sliceIds: [], steps: [...STEPS] },
              status: "待接管",
              priorShiftOrderId: null,
              backfill: true,
              createdAt: this.now(),
              takenOverAt: null,
              confirmedAt: null,
            };
            db.shiftOrders.push(so);
            const batch = {
              id: uid("BATCH"),
              shiftOrderId: so.id,
              machineId,
              sampleIds: [],
              sliceIds: [],
              status: "待接管",
              createdAt: this.now(),
            };
            db.batches.push(batch);
            so.batchId = batch.id;
            created.push({ shiftOrder: so, batch });
          }
          so.scope.sampleIds.push(sample.id);
          for (const sl of sample.slices) so.scope.sliceIds.push(sl.id);
          const batch = db.batches.find((b) => b.id === so.batchId);
          batch.sampleIds.push(sample.id);
          for (const sl of sample.slices) batch.sliceIds.push(sl.id);
          sample.shiftOrderId = so.id;
        }
        return { created, uncovered: sorted.length };
      },
    });
  }
}
