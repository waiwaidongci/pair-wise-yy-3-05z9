// 班次账领域逻辑：纯函数，不碰磁盘与网络。
// 所有状态变更都描述为事件；store 负责先落 journal 再 fold。

export const STEPS = ["取样", "切割", "研磨", "染色", "观察"];
export const BATCH_STATUS = ["待接管", "进行中", "已完成", "已交付"];

export const SEED_MACHINES = [
  { id: "CUT-01", name: "一号切片机", activeShiftId: null, activeBatchId: null },
  { id: "CUT-02", name: "二号切片机", activeShiftId: null, activeBatchId: null }
];

export class DomainError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function initialState() {
  return {
    seq: 0,
    meta: {},
    shifts: {},
    machines: Object.fromEntries(SEED_MACHINES.map(m => [m.id, { ...m }])),
    samples: {},
    sampleOrder: [],
    batches: {},
    batchOrder: [],
    ledger: [],
    handovers: [],
    conflicts: {},
    idem: {}
  };
}

const now = (ctx) => (ctx && ctx.now ? ctx.now() : new Date().toISOString());
let idCounter = 0;
function ctxWithIds(state, ctx = {}) {
  let n = state.seq + idCounter + 1;
  return {
    ...ctx,
    now: ctx.now || (() => new Date().toISOString()),
    id: (prefix) => {
      idCounter += 1;
      return `${prefix}-${String(state.seq + idCounter).padStart(4, "0")}`;
    }
  };
}
function resetIds() { idCounter = 0; }

// ---------- 工具 ----------

function batchesOf(state, sampleId) {
  return state.batchOrder.filter(id => state.batches[id].sampleId === sampleId).map(id => state.batches[id]);
}
function latestBatchOf(state, sampleId) {
  const list = batchesOf(state, sampleId);
  return list[list.length - 1] || null;
}
function sliceAllDone(slice) {
  return STEPS.every(name => slice.steps.some(s => s.name === name && s.state === "completed")) &&
    !slice.steps.some(s => s.state === "pending");
}
function sliceCurrentStep(slice) {
  const active = slice.steps.find(s => s.state === "in_progress" || s.state === "pending");
  return active ? active.name : (sliceAllDone(slice) ? "完成" : null);
}
function requireOpenShift(state, shiftId) {
  const shift = state.shifts[shiftId];
  if (!shift) throw new DomainError(404, "shift_not_found", "班次单不存在");
  if (shift.status !== "open") throw new DomainError(403, "shift_closed", "班次已关闭");
  return shift;
}
function activeHandovers(state, toShiftId) {
  return state.handovers.filter(h => h.status === "active" && h.toShiftId === toShiftId);
}
function scopeCovers(scope, kind, id) {
  return Array.isArray(scope[kind]) && scope[kind].includes(id);
}
// 非机台操作：本班自有，或有覆盖该样本/批次的交接单
function coveredForBatch(state, shiftId, batch) {
  if (!batch) return false;
  if (batch.shiftId === shiftId) return true;
  const sample = state.samples[batch.sampleId];
  if (sample && sample.ownerShiftId === shiftId) return true;
  return activeHandovers(state, shiftId).some(h =>
    scopeCovers(h.scope, "batchIds", batch.id) || scopeCovers(h.scope, "sampleIds", batch.sampleId));
}
// 机台操作：除批次/样本覆盖外，还必须拿到对应机台的交接范围
function coveredForMachineAction(state, shiftId, batch, machineId) {
  if (!coveredForBatch(state, shiftId, batch)) return false;
  if (batch.shiftId === shiftId) return true;
  return activeHandovers(state, shiftId).some(h =>
    (scopeCovers(h.scope, "batchIds", batch.id) || scopeCovers(h.scope, "sampleIds", batch.sampleId)) &&
    scopeCovers(h.scope, "machineIds", machineId));
}
function machineBusy(state, machineId, shiftId) {
  const machine = state.machines[machineId];
  if (!machine) throw new DomainError(404, "machine_not_found", "切片机不存在");
  return machine.activeShiftId && machine.activeShiftId !== shiftId ? machine : null;
}
function makePendingSteps() {
  return STEPS.map(name => ({ name, state: "pending" }));
}
function makeSlice(id, stainMethod) {
  return { id, stainMethod: stainMethod || null, steps: makePendingSteps(), done: false, currentStep: STEPS[0] };
}
function refreshSlice(slice) {
  slice.done = sliceAllDone(slice);
  slice.currentStep = sliceCurrentStep(slice);
  return slice;
}
function recomputeSample(state, sample) {
  const batch = latestBatchOf(state, sample.id);
  sample.delivery = "未交付";
  if (!batch) {
    sample.status = "待切割";
    return;
  }
  if (batch.status === "待接管") { sample.status = "待接管"; return; }
  if (batch.status === "已交付" && batch.deliveryConclusion && batch.deliveryConclusion.valid) {
    sample.status = "已交付";
    sample.delivery = "已交付";
    return;
  }
  if (batch.slices.length === 0) { sample.status = "待切割"; return; }
  if (batch.slices.every(refreshSlice) && batch.slices.every(s => s.done)) {
    sample.status = "待观察";
  } else {
    sample.status = "制片中";
  }
}

// ---------- 事件 fold ----------

export function applyEvent(state, e) {
  state.seq = e.seq;
  switch (e.type) {
    case "SHIFT_OPENED":
      state.shifts[e.shift.id] = e.shift;
      break;
    case "SHIFT_CLOSED": {
      const s = state.shifts[e.shiftId];
      if (s) s.status = "closed";
      for (const m of Object.values(state.machines)) {
        if (m.activeShiftId === e.shiftId) { m.activeShiftId = null; m.activeBatchId = null; }
      }
      break;
    }
    case "SAMPLE_CREATED":
      state.samples[e.sample.id] = e.sample;
      state.sampleOrder.push(e.sample.id);
      break;
    case "MACHINE_CLAIMED": {
      const m = state.machines[e.machineId];
      m.activeShiftId = e.shiftId;
      m.activeBatchId = e.batchId;
      break;
    }
    case "BATCH_SUBMITTED":
    case "SLICES_ADDED":
    case "STEP_RECORDED":
    case "PARAMS_CHANGED":
    case "DELIVERY_CONFIRMED":
    case "BATCH_TAKEN_OVER":
    case "BATCHES_BACKFILLED":
      // 这些事件携带完整的批次快照/步骤替换，逐批覆盖后重算样本
      for (const b of e.batches || []) {
        state.batches[b.id] = b;
        if (!state.batchOrder.includes(b.id)) state.batchOrder.push(b.id);
        b.slices.forEach(refreshSlice);
      }
      if (e.ledger) for (const entry of e.ledger) {
        const idx = state.ledger.findIndex(x => x.id === entry.id);
        if (idx >= 0) state.ledger[idx] = entry; else state.ledger.push(entry);
      }
      for (const sampleId of e.touchedSamples || []) {
        const sample = state.samples[sampleId];
        if (sample) recomputeSample(state, sample);
      }
      if (e.machineClaims) for (const c of e.machineClaims) {
        const m = state.machines[c.machineId];
        if (m) { m.activeShiftId = c.shiftId; m.activeBatchId = c.batchId; }
      }
      if (e.samplePatch) for (const [id, patch] of Object.entries(e.samplePatch)) {
        Object.assign(state.samples[id], patch);
      }
      break;
    case "HANDOVER_REGISTERED":
      state.handovers.push(e.handover);
      break;
    case "CONFLICT_PARKED":
      state.conflicts[e.conflict.id] = e.conflict;
      break;
    case "CONFLICT_RESOLVED": {
      const c = state.conflicts[e.conflictId];
      if (c) { c.status = e.resolution; c.resolvedAt = e.at; }
      break;
    }
    case "LEDGER_VOIDED": {
      const entry = state.ledger.find(x => x.id === e.ledgerId);
      if (entry) { entry.valid = false; entry.voidedAt = e.at; entry.voidReason = e.reason; }
      break;
    }
    case "LEGACY_IMPORTED":
      state.meta.legacyMigratedAt = e.at;
      state.meta.legacyCount = e.count;
      break;
    case "IDEM_STORED":
      state.idem[e.key] = e.response;
      break;
    default:
      break;
  }
  return state;
}

export function fold(events, state = initialState()) {
  for (const e of events) applyEvent(state, e);
  return state;
}

// ---------- 命令 ----------

function batchSnapshot(state, batchId) {
  return JSON.parse(JSON.stringify(state.batches[batchId]));
}
function batchEvent(type, state, batchIds, extra = {}) {
  return {
    type,
    batches: batchIds.map(id => batchSnapshot(state, id)),
    touchedSamples: [...new Set(batchIds.map(id => state.batches[id].sampleId))],
    ...extra
  };
}

function parkConflict(state, ctx, { shiftId, operator, action, payload, machineId, idemKey }) {
  const heldBy = state.machines[machineId].activeShiftId;
  const conflict = {
    id: ctx.id("CFL"),
    at: now(ctx),
    shiftId,
    operator: operator || null,
    action,
    payload,
    machineId,
    idemKey: idemKey || null,
    heldByShiftId: heldBy,
    reason: "machine_busy",
    status: "pending"
  };
  return {
    status: 409,
    events: [{ type: "CONFLICT_PARKED", conflict }],
    body: { error: "machine_busy", message: `该机台正由班次 ${heldBy} 占用，改动已留冲突`, conflict }
  };
}

export function execute(state, command, ctxInput = {}) {
  resetIds();
  const ctx = ctxWithIds(state, ctxInput);
  const p = command;

  switch (p.type) {
    // ---------- 班次单 ----------
    case "shift.open": {
      const id = p.id || ctx.id("SHIFT");
      if (state.shifts[id]) throw new DomainError(409, "shift_exists", "班次号已存在");
      const shift = { id, role: p.role || "切片工", person: p.person || "未署名", status: "open", openedAt: now(ctx) };
      return { status: 201, events: [{ type: "SHIFT_OPENED", shift }], body: shift };
    }
    case "shift.close": {
      requireOpenShift(state, p.shiftId);
      return { status: 200, events: [{ type: "SHIFT_CLOSED", shiftId: p.shiftId, at: now(ctx) }], body: { ok: true } };
    }

    // ---------- 样本（同时提交首个切片批次，机台先到先得） ----------
    case "sample.create": {
      const shift = requireOpenShift(state, p.shiftId);
      const machineId = p.machineId;
      const held = machineBusy(state, machineId, p.shiftId);
      if (held) return parkConflict(state, ctx, {
        shiftId: p.shiftId, operator: shift.person, action: "sample.create",
        payload: stripShift(p), machineId, idemKey: p.idemKey
      });
      const params = normalizeParams(p, {});
      const sample = {
        id: p.id || ctx.id("CORE"),
        project: p.project, borehole: p.borehole, coreBox: p.coreBox, depth: p.depth,
        owner: p.owner, ownerShiftId: p.shiftId,
        createdAt: now(ctx), status: "待切割", delivery: "未交付",
        paramsVersion: 1, currentParams: params
      };
      const slices = (p.slices && p.slices.length ? p.slices : [{ id: p.sliceId }])
        .map(s => makeSlice(s.id, s.stainMethod || params.stainMethod));
      if (!slices[0].id) throw new DomainError(400, "slice_id_required", "首个切片编号必填");
      const batch = {
        id: ctx.id("BATCH"), sampleId: sample.id, shiftId: p.shiftId, machineId,
        createdBy: shift.person, createdAt: now(ctx), status: "进行中",
        params: { ...params }, paramsVersion: 1, slices,
        deliveryConclusion: null, backfill: false
      };
      batch.slices.forEach(refreshSlice);
      sample.status = "制片中";
      const ev1 = { type: "SAMPLE_CREATED", sample };
      const ev2 = { type: "MACHINE_CLAIMED", machineId, shiftId: p.shiftId, batchId: batch.id };
      const ev3 = {
        type: "BATCH_SUBMITTED",
        batches: [JSON.parse(JSON.stringify(batch))],
        touchedSamples: [sample.id]
      };
      return { status: 201, events: [ev1, ev2, ev3], body: { sample, batch } };
    }

    // ---------- 切片批次提交（对已存在样本追加新批次） ----------
    case "batch.submit": {
      const shift = requireOpenShift(state, p.shiftId);
      const sample = state.samples[p.sampleId];
      if (!sample) throw new DomainError(404, "sample_not_found", "样本不存在");
      const latest = latestBatchOf(state, sample.id);
      if (latest && (latest.status === "待接管" || latest.status === "进行中"))
        throw new DomainError(409, "batch_active", "该样本存在待接管或进行中的批次，不能新开切片");
      const held = machineBusy(state, p.machineId, p.shiftId);
      if (held) return parkConflict(state, ctx, {
        shiftId: p.shiftId, operator: shift.person, action: "batch.submit",
        payload: stripShift(p), machineId: p.machineId, idemKey: p.idemKey
      });
      const slices = (p.slices || []).map(s => makeSlice(s.id, s.stainMethod || sample.currentParams.stainMethod));
      if (!slices.length || slices.some(s => !s.id)) throw new DomainError(400, "slices_required", "至少提交一个带编号的切片");
      const batch = {
        id: ctx.id("BATCH"), sampleId: sample.id, shiftId: p.shiftId, machineId: p.machineId,
        createdBy: shift.person, createdAt: now(ctx), status: "进行中",
        params: { ...sample.currentParams }, paramsVersion: sample.paramsVersion,
        slices, deliveryConclusion: null, backfill: false
      };
      batch.slices.forEach(refreshSlice);
      return {
        status: 201,
        events: [
          { type: "MACHINE_CLAIMED", machineId: p.machineId, shiftId: p.shiftId, batchId: batch.id },
          { type: "BATCH_SUBMITTED", batches: [JSON.parse(JSON.stringify(batch))], touchedSamples: [sample.id] }
        ],
        body: batch
      };
    }

    // ---------- 批次内追加切片 ----------
    case "batch.addSlices": {
      const shift = requireOpenShift(state, p.shiftId);
      const batch = state.batches[p.batchId];
      if (!batch) throw new DomainError(404, "batch_not_found", "切片批次不存在");
      if (batch.status === "待接管") throw new DomainError(403, "sample_pending_takeover", "老批次尚未接管");
      if (batch.status !== "进行中") throw new DomainError(409, "batch_not_active", "批次已结束，不能追加切片");
      if (!coveredForMachineAction(state, p.shiftId, batch, batch.machineId))
        throw new DomainError(403, "out_of_scope", "越权修改：不在本班交接覆盖范围内");
      const busy = machineBusy(state, batch.machineId, p.shiftId);
      if (busy) return parkConflict(state, ctx, {
        shiftId: p.shiftId, operator: shift.person, action: "batch.addSlices",
        payload: stripShift(p), machineId: batch.machineId, idemKey: p.idemKey
      });
      const fresh = (p.slices || []).map(s => makeSlice(s.id, s.stainMethod || batch.params.stainMethod));
      if (!fresh.length || fresh.some(s => !s.id)) throw new DomainError(400, "slices_required", "至少一个带编号切片");
      for (const s of fresh) {
        if (batch.slices.some(x => x.id === s.id)) throw new DomainError(409, "slice_exists", `切片 ${s.id} 已存在`);
      }
      batch.slices.push(...fresh);
      batch.slices.forEach(refreshSlice);
      const events = [];
      if (state.machines[batch.machineId].activeShiftId !== p.shiftId)
        events.push({ type: "MACHINE_CLAIMED", machineId: batch.machineId, shiftId: p.shiftId, batchId: batch.id });
      events.push(batchEvent("SLICES_ADDED", state, [batch.id]));
      return { status: 201, events, body: batchSnapshot(state, batch.id) };
    }

    // ---------- 记录制片步骤（按顺序，幂等防跳步/重复） ----------
    case "step.record": {
      const shift = requireOpenShift(state, p.shiftId);
      const batch = state.batches[p.batchId];
      if (!batch) throw new DomainError(404, "batch_not_found", "切片批次不存在");
      if (batch.status === "待接管") throw new DomainError(403, "sample_pending_takeover", "老批次尚未接管，先登记接管");
      if (batch.status !== "进行中") throw new DomainError(409, "batch_not_active", "批次不在进行中");
      if (!coveredForBatch(state, p.shiftId, batch))
        throw new DomainError(403, "out_of_scope", "越权修改：不在本班交接覆盖范围内");
      const slice = batch.slices.find(s => s.id === p.sliceId);
      if (!slice) throw new DomainError(404, "slice_not_found", "切片不存在");
      if (!STEPS.includes(p.step)) throw new DomainError(400, "bad_step", "未知制片步骤");
      const target = slice.steps.find(s => s.state === "in_progress" || s.state === "pending");
      if (!target) throw new DomainError(409, "step_already_done", "该切片步骤已全部完成");
      if (slice.steps.some(s => s.name === p.step && s.state === "completed"))
        throw new DomainError(409, "step_already_completed", `${p.step} 已完成，不能重复记录`);
      if (target.name !== p.step)
        throw new DomainError(409, "step_order_violation", `步骤顺序冲突：下一应为 ${target.name}，重试不会重复生成步骤`);
      target.state = "completed";
      target.completedAt = now(ctx);
      target.note = p.note || "";
      target.operator = shift.person;
      if (p.step === "观察") target.observation = p.note || "";
      refreshSlice(slice);
      if (batch.slices.every(s => s.done)) batch.status = "已完成";
      return { status: 200, events: [batchEvent("STEP_RECORDED", state, [batch.id])], body: batchSnapshot(state, batch.id) };
    }

    // ---------- 切割角度/厚度/染色方法变更：未完成切片与交付结论失效重算 ----------
    case "params.change": {
      const shift = requireOpenShift(state, p.shiftId);
      const sample = state.samples[p.sampleId];
      if (!sample) throw new DomainError(404, "sample_not_found", "样本不存在");
      const target = latestBatchOf(state, sample.id);
      if (!target) throw new DomainError(404, "batch_not_found", "样本尚无批次");
      if (target.status === "待接管") throw new DomainError(403, "sample_pending_takeover", "老批次尚未接管");
      if (!coveredForBatch(state, p.shiftId, target))
        throw new DomainError(403, "out_of_scope", "越权修改：不在本班交接覆盖范围内");
      const old = sample.currentParams;
      const changes = [];
      for (const key of ["angle", "thickness", "stainMethod"]) {
        if (p[key] !== undefined && p[key] !== null && String(p[key]).trim() !== "" && p[key] !== old[key])
          changes.push(key);
      }
      if (!changes.length) throw new DomainError(400, "params_unchanged", "切割角度、厚度或染色方法没有变化");
      const label = { angle: "切割角度", thickness: "厚度", stainMethod: "染色方法" };
      const reason = `参数变更（${changes.map(c => label[c]).join("、")}）失效重算`;
      const nextParams = { ...old };
      for (const c of changes) nextParams[c] = p[c];

      const affectedBatches = batchesOf(state, sample.id).filter(b => b.status !== "待接管");
      const invalidated = [];
      const voidedLedger = [];
      for (const batch of affectedBatches) {
        for (const slice of batch.slices) {
          if (slice.done) continue; // 已完成切片保持原样，可追溯
          const retained = slice.steps.filter(s => s.state === "completed"
            && !(changes.includes("stainMethod") && s.name === "染色"));
          const dead = slice.steps
            .filter(s => !retained.includes(s))
            .map(s => ({ ...s, state: "invalid", invalidReason: reason, invalidatedAt: now(ctx) }));
          const reworkNames = STEPS.filter(name => !retained.some(s => s.name === name));
          const rework = reworkNames.map(name => ({ name, state: "pending" }));
          if (dead.length) invalidated.push({ batchId: batch.id, sliceId: slice.id, steps: dead.map(d => d.name) });
          slice.steps = [...retained, ...dead, ...rework];
          refreshSlice(slice);
        }
        if (batch.status === "已交付" && batch.deliveryConclusion && batch.deliveryConclusion.valid) {
          const ledgerId = batch.deliveryConclusion.ledgerId;
          voidedLedger.push({ type: "LEDGER_VOIDED", ledgerId, at: now(ctx), reason });
          batch.deliveryConclusion = { ...batch.deliveryConclusion, valid: false, voidedAt: now(ctx), voidReason: reason };
          batch.status = "已完成"; // 结论失效，回到待重新确认
        }
      }
      sample.currentParams = nextParams;
      sample.paramsVersion += 1;
      const events = [
        batchEvent("PARAMS_CHANGED", state, affectedBatches.map(b => b.id), {
          samplePatch: { [sample.id]: { currentParams: nextParams, paramsVersion: sample.paramsVersion } },
          changes: { from: old, to: nextParams, names: changes },
          invalidated,
          reason
        }),
        ...voidedLedger
      ];
      return { status: 200, events, body: { currentParams: nextParams, invalidated, reason } };
    }

    // ---------- 交付台账 ----------
    case "batch.deliver": {
      const shift = requireOpenShift(state, p.shiftId);
      const batch = state.batches[p.batchId];
      if (!batch) throw new DomainError(404, "batch_not_found", "切片批次不存在");
      if (batch.status === "待接管") throw new DomainError(403, "sample_pending_takeover", "老批次尚未接管");
      if (!coveredForBatch(state, p.shiftId, batch))
        throw new DomainError(403, "out_of_scope", "越权修改：不在本班交接覆盖范围内");
      if (!batch.slices.length) throw new DomainError(409, "batch_empty", "批次没有切片");
      if (!batch.slices.every(s => refreshSlice(s).done))
        throw new DomainError(409, "batch_not_complete", "仍有未完成切片，不能交付");
      if (batch.deliveryConclusion && batch.deliveryConclusion.valid)
        throw new DomainError(409, "already_delivered", "交付结论已存在且有效");
      const entry = {
        id: ctx.id("LDG"), at: now(ctx), sampleId: batch.sampleId, batchId: batch.id,
        shiftId: p.shiftId, operator: shift.person,
        conclusion: p.conclusion || "合格交付", valid: true
      };
      batch.deliveryConclusion = { ledgerId: entry.id, at: entry.at, by: shift.person, shiftId: p.shiftId, valid: true };
      batch.status = "已交付";
      const ev = batchEvent("DELIVERY_CONFIRMED", state, [batch.id], { ledger: [entry] });
      return { status: 201, events: [ev], body: entry };
    }

    // ---------- 跨班交接 ----------
    case "handover.register": {
      const operatorShift = requireOpenShift(state, p.operatorShiftId || p.shiftId);
      const to = state.shifts[p.toShiftId];
      const from = state.shifts[p.fromShiftId];
      if (!to) throw new DomainError(404, "shift_not_found", "接管班次不存在");
      if (!from && p.fromShiftId !== "legacy") throw new DomainError(404, "shift_not_found", "交出班次不存在");
      if (![p.fromShiftId, p.toShiftId].includes(operatorShift.id))
        throw new DomainError(403, "out_of_scope", "只有交接双方可以登记交接");
      const scope = { batchIds: p.scope?.batchIds || [], sampleIds: p.scope?.sampleIds || [], machineIds: p.scope?.machineIds || [] };
      for (const id of scope.batchIds) if (!state.batches[id]) throw new DomainError(404, "batch_not_found", `批次 ${id} 不存在`);
      for (const id of scope.sampleIds) if (!state.samples[id]) throw new DomainError(404, "sample_not_found", `样本 ${id} 不存在`);
      for (const id of scope.machineIds) if (!state.machines[id]) throw new DomainError(404, "machine_not_found", `机台 ${id} 不存在`);
      if (!scope.batchIds.length && !scope.sampleIds.length)
        throw new DomainError(400, "scope_required", "交接必须登记覆盖范围（批次或样本）");
      const handover = {
        id: ctx.id("HDV"), at: now(ctx),
        fromShiftId: p.fromShiftId, toShiftId: p.toShiftId,
        operator: operatorShift.person, scope, range: p.range || "", status: "active"
      };
      return { status: 201, events: [{ type: "HANDOVER_REGISTERED", handover }], body: handover };
    }

    // ---------- 待接管批次的接管 ----------
    case "batch.takeover": {
      const shift = requireOpenShift(state, p.shiftId);
      const batch = state.batches[p.batchId];
      if (!batch) throw new DomainError(404, "batch_not_found", "切片批次不存在");
      if (batch.status !== "待接管") throw new DomainError(409, "not_pending_takeover", "该批次不是待接管状态");
      const held = machineBusy(state, p.machineId, p.shiftId);
      if (held) return parkConflict(state, ctx, {
        shiftId: p.shiftId, operator: shift.person, action: "batch.takeover",
        payload: stripShift(p), machineId: p.machineId, idemKey: p.idemKey
      });
      const handover = {
        id: ctx.id("HDV"), at: now(ctx), fromShiftId: "legacy", toShiftId: p.shiftId,
        operator: shift.person,
        scope: { batchIds: [batch.id], sampleIds: [batch.sampleId], machineIds: [p.machineId] },
        range: p.range || "老样本补录批次接管", status: "active"
      };
      batch.status = "进行中";
      batch.shiftId = p.shiftId;
      batch.machineId = p.machineId;
      batch.takenOverAt = now(ctx);
      const sample = state.samples[batch.sampleId];
      if (sample) sample.ownerShiftId = p.shiftId;
      return {
        status: 200,
        events: [
          { type: "HANDOVER_REGISTERED", handover },
          { type: "MACHINE_CLAIMED", machineId: p.machineId, shiftId: p.shiftId, batchId: batch.id },
          batchEvent("BATCH_TAKEN_OVER", state, [batch.id], {
            samplePatch: { [batch.sampleId]: { ownerShiftId: p.shiftId } }
          })
        ],
        body: { batch: batchSnapshot(state, batch.id), handover }
      };
    }

    // ---------- 老样本按创建日期补成待接管批次 ----------
    case "samples.backfill": {
      const orphanIds = state.sampleOrder.filter(id => !batchesOf(state, id).length);
      if (!orphanIds.length) throw new DomainError(400, "nothing_to_backfill", "没有缺少班次单的老样本");
      const batches = orphanIds.map(sid => buildBackfillBatch(state, sid, ctx));
      return {
        status: 201,
        events: [{ type: "BATCHES_BACKFILLED", batches, touchedSamples: orphanIds }],
        body: batches
      };
    }

    // ---------- 老库一次性导入（首次启动迁移） ----------
    case "legacy.import": {
      if (state.meta.legacyMigratedAt) throw new DomainError(400, "already_migrated", "老库已导入");
      const events = [];
      const backfilled = [];
      const createdSamples = [];
      for (const oldSample of p.legacy.samples || []) {
        if (state.samples[oldSample.id]) continue;
        const createdAt = inferCreatedAt(oldSample);
        const stain = oldSample.slices?.[0]?.method || "未登记";
        const sample = {
          id: oldSample.id, project: oldSample.project, borehole: oldSample.borehole,
          coreBox: oldSample.coreBox, depth: oldSample.depth, owner: oldSample.owner,
          ownerShiftId: "legacy", createdAt, status: "待接管", delivery: "未交付",
          paramsVersion: 1, currentParams: { angle: "未登记", thickness: "未登记", stainMethod: stain }
        };
        const date = createdAt.slice(0, 10);
        const slices = (oldSample.slices || []).map(sl => legacySlice(sl));
        const batch = {
          id: `BF-${date}-${oldSample.id}`, sampleId: oldSample.id, shiftId: null, machineId: null,
          createdBy: null, createdAt, status: "待接管",
          params: { ...sample.currentParams }, paramsVersion: 1,
          slices, deliveryConclusion: null,
          backfill: true, backfillDate: date
        };
        batch.slices.forEach(refreshSlice);
        events.push({ type: "SAMPLE_CREATED", sample });
        createdSamples.push(sample);
        backfilled.push(batch);
      }
      if (!createdSamples.length) throw new DomainError(400, "nothing_to_import", "老库没有可导入样本");
      events.push({ type: "BATCHES_BACKFILLED", batches: backfilled, touchedSamples: createdSamples.map(s => s.id) });
      events.push({ type: "LEGACY_IMPORTED", at: now(ctx), count: createdSamples.length });
      return { status: 201, events, body: { imported: createdSamples.length, batches: backfilled } };
    }

    // ---------- 冲突处置 ----------
    case "conflict.resolve": {
      const shift = requireOpenShift(state, p.shiftId);
      const conflict = state.conflicts[p.conflictId];
      if (!conflict) throw new DomainError(404, "conflict_not_found", "冲突记录不存在");
      if (conflict.status !== "pending") throw new DomainError(409, "conflict_closed", "冲突已处置");
      if (p.resolution === "discard") {
        return {
          status: 200,
          events: [{ type: "CONFLICT_RESOLVED", conflictId: conflict.id, resolution: "discarded", at: now(ctx) }],
          body: { ok: true }
        };
      }
      if (p.resolution !== "apply") throw new DomainError(400, "bad_resolution", "resolution 必须是 apply 或 discard");
      // 重放原内容：机台此刻必须空且仍在覆盖范围内，否则继续挂起
      const machine = state.machines[conflict.machineId];
      if (machine.activeShiftId && machine.activeShiftId !== conflict.shiftId)
        throw new DomainError(409, "machine_still_busy", `机台仍由班次 ${machine.activeShiftId} 占用，冲突继续挂起`);
      if (conflict.shiftId !== shift.id)
        throw new DomainError(403, "out_of_scope", "只有原提交班次可以应用该冲突");
      const nested = execute(state, {
        type: conflict.action,
        ...conflict.payload,
        shiftId: conflict.shiftId,
        idemKey: conflict.idemKey || undefined
      }, ctx);
      if (nested.status === 409) throw new DomainError(409, "still_conflicted", "重放仍被占用", nested.body);
      return {
        status: nested.status,
        events: [
          ...nested.events,
          { type: "CONFLICT_RESOLVED", conflictId: conflict.id, resolution: "applied", at: now(ctx) }
        ],
        body: nested.body
      };
    }

    default:
      throw new DomainError(400, "unknown_action", `未知动作 ${p.type}`);
  }
}

function stripShift(p) {
  const { idemKey, ...rest } = p;
  return rest;
}
function normalizeParams(p, fallback) {
  return {
    angle: p.angle || fallback.angle || "90°",
    thickness: p.thickness || fallback.thickness || "0.03mm",
    stainMethod: p.stainMethod || fallback.stainMethod || "未指定染色"
  };
}
function buildBackfillBatch(state, sampleId, ctx) {
  const sample = state.samples[sampleId];
  const date = (sample.createdAt || now(ctx)).slice(0, 10);
  const batch = {
    id: `BF-${date}-${sampleId}`, sampleId, shiftId: null, machineId: null,
    createdBy: null, createdAt: sample.createdAt || now(ctx), status: "待接管",
    params: { ...sample.currentParams }, paramsVersion: sample.paramsVersion || 1,
    slices: [makeSlice(ctx.id("SL"), sample.currentParams.stainMethod)],
    deliveryConclusion: null, backfill: true, backfillDate: date
  };
  batch.slices.forEach(refreshSlice);
  sample.ownerShiftId = "legacy";
  return batch;
}
function inferCreatedAt(oldSample) {
  const times = (oldSample.slices || []).flatMap(s => (s.logs || []).map(l => l.at)).filter(Boolean).sort();
  return times[0] || null;
}
function legacySlice(sl) {
  const logs = [...(sl.logs || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const steps = STEPS.map(name => {
    const log = logs.find(l => l.step === name);
    if (log) return { name, state: "completed", completedAt: log.at, note: log.note || "", operator: null };
    if (sl.status === name) return { name, state: "in_progress" };
    return { name, state: "pending" };
  });
  const slice = { id: sl.id, stainMethod: sl.method || null, steps };
  refreshSlice(slice);
  // 老数据的"当前步骤"用 in_progress 表达，currentStep 仍给出该步骤名
  const inProgress = steps.find(s => s.state === "in_progress");
  if (inProgress) slice.currentStep = inProgress.name;
  return slice;
}

// ---------- 恢复视图：按班次单汇总最后确认步骤 ----------

export function recoveryReport(state) {
  const confirmed = [];
  for (const batch of state.batchOrder.map(id => state.batches[id])) {
    for (const slice of batch.slices) {
      const last = [...slice.steps].reverse().find(s => s.state === "completed");
      if (last) {
        confirmed.push({
          shiftId: batch.shiftId, batchId: batch.id, sampleId: batch.sampleId,
          sliceId: slice.id, lastStep: last.name, at: last.completedAt, operator: last.operator || null
        });
      }
    }
  }
  const pendingConflicts = Object.values(state.conflicts).filter(c => c.status === "pending").length;
  return {
    lastSeq: state.seq,
    snapshotDirty: !!state._snapshotDirty,
    pendingConflicts,
    confirmedSteps: confirmed,
    machines: Object.values(state.machines).map(m => ({ id: m.id, activeShiftId: m.activeShiftId, activeBatchId: m.activeBatchId }))
  };
}
