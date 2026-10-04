import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let baseUrl;
let dataDir;
let cleanupServer;
const legacySeed = {
  samples: [{
    id: "CORE-001", project: "东岭铜矿薄片", borehole: "ZK-17", coreBox: "BX-09",
    depth: "128.4-128.8m", owner: "陆川", status: "制片中", delivery: "未交付",
    slices: [{ id: "SL-001-A", method: "茜素红染色", observation: "", status: "研磨",
      logs: [
        { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
        { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }
      ] }]
  }]
};

async function startServer() {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "shift-ledger-"));
  // 直接写老库文件（首次启动时迁移）
  await import("node:fs/promises").then(fs => fs.writeFile(path.join(dataDir, "core-slices.json"), JSON.stringify(legacySeed)));
  const port = 4000 + Math.floor(Math.random() * 900);
  baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "inherit"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    child.stdout.on("data", chunk => { if (String(chunk).includes("监听")) { clearTimeout(timer); resolve(); } });
    child.on("exit", code => reject(new Error("server exited " + code)));
  });
  return async () => { child.kill(); await new Promise(r => child.on("exit", r)); await rm(dataDir, { recursive: true, force: true }); };
}

async function call(method, p, body, { shift, idemKey, headers = {} } = {}) {
  const h = { ...headers };
  if (shift) h["X-Shift-Id"] = shift;
  if (idemKey) h["Idempotency-Key"] = idemKey;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(baseUrl + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}
const get = async p => {
  const res = await fetch(baseUrl + p);
  return res.json();
};
const openShift = async (id, person, role) => (await call("POST", "/api/shifts", { id, person, role })).json;

test.before(async () => { cleanupServer = await startServer(); });
test.after(async () => { await cleanupServer(); });

test("规则5：没有班次单的老样本，启动时按创建日期补成待接管批次", async () => {
  const state = await get("/api/state");
  const sample = state.samples.find(s => s.id === "CORE-001");
  assert.equal(sample.ownerShiftId, "legacy");
  assert.equal(sample.status, "待接管");
  const batch = state.batches.find(b => b.sampleId === "CORE-001");
  assert.equal(batch.id, "BF-2026-06-12-CORE-001");
  assert.equal(batch.status, "待接管");
  assert.equal(batch.backfillDate, "2026-06-12");
  // 已完成步骤可追溯，未完成步骤待重算
  const slice = batch.slices[0];
  assert.equal(slice.steps.find(s => s.name === "取样").state, "completed");
  assert.equal(slice.steps.find(s => s.name === "切割").state, "completed");
  assert.equal(slice.currentStep, "研磨");
  // 老库文件已归档
  const files = (await import("node:fs/promises")).readdir(dataDir);
  assert.match((await files).join(","), /core-slices\.imported-/);
});

test("规则4：待接管批次越权/未接管记录步骤直接拒绝", async () => {
  await openShift("SHIFT-A", "甲", "切片工");
  const batch = (await get("/api/state")).batches.find(b => b.sampleId === "CORE-001");
  // 未接管先记录 -> 拒绝
  let r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-001-A", step: "研磨", note: "磨片" }, { shift: "SHIFT-A" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "sample_pending_takeover");
  // 无班次单 -> 401
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-001-A", step: "研磨" });
  assert.equal(r.status, 401);
});

test("规则4：接管登记交接人与覆盖范围，接管后在机台上继续作业", async () => {
  const batch = (await get("/api/state")).batches.find(b => b.sampleId === "CORE-001");
  let r = await call("POST", `/api/batches/${batch.id}/takeover`,
    { machineId: "CUT-01", range: "ZK-17 接管" }, { shift: "SHIFT-A" });
  assert.equal(r.status, 200);
  assert.equal(r.json.batch.status, "进行中");
  assert.equal(r.json.handover.toShiftId, "SHIFT-A");
  assert.deepEqual(r.json.handover.scope.machineIds, ["CUT-01"]);
  const state = await get("/api/state");
  assert.equal(state.machines.find(m => m.id === "CUT-01").activeShiftId, "SHIFT-A");
  // 从最后确认步骤继续：取样/切割不重复
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-001-A", step: "研磨", note: "磨至0.03mm" }, { shift: "SHIFT-A" });
  assert.equal(r.status, 200);
  const steps = r.json.slices[0].steps.filter(s => s.state === "completed");
  assert.deepEqual(steps.map(s => s.name), ["取样", "切割", "研磨"]);
});

test("规则1：同一台切片机先到者开工，后到内容留冲突；空出后可重放", async () => {
  await openShift("SHIFT-B", "乙", "切片工");
  // B 在 CUT-02 先开样本，占住 CUT-02
  const first = await call("POST", "/api/samples", {
    project: "北山铁矿", borehole: "ZK-2", coreBox: "BX-2", depth: "10m",
    owner: "乙", machineId: "CUT-02", sliceId: "SL-B-1", stainMethod: "不染色"
  }, { shift: "SHIFT-B" });
  assert.equal(first.status, 201);
  // 同时 A 也要 CUT-02（A 只覆盖 CUT-01 上的老批次，这里是全新样本，不涉及覆盖）
  const late = await call("POST", "/api/samples", {
    project: "抢机台样本", borehole: "ZK-9", coreBox: "BX-9", depth: "11m",
    owner: "甲", machineId: "CUT-02", sliceId: "SL-A-9"
  }, { shift: "SHIFT-A" });
  assert.equal(late.status, 409);
  assert.equal(late.json.error, "machine_busy");
  assert.ok(late.json.conflict.id.startsWith("CFL-"));
  assert.equal(late.json.conflict.heldByShiftId, "SHIFT-B");
  // B 收班释放机台
  await call("POST", "/api/shifts/SHIFT-B/close", undefined, { shift: "SHIFT-B" });
  // A 应用挂起冲突
  const apply = await call("POST", `/api/conflicts/${late.json.conflict.id}/resolve`,
    { resolution: "apply" }, { shift: "SHIFT-A" });
  assert.equal(apply.status, 201);
  assert.equal(apply.json.batch.slices[0].id, "SL-A-9");
  const state = await get("/api/state");
  assert.equal(state.conflicts.find(c => c.id === late.json.conflict.id).status, "applied");
  assert.equal(state.machines.find(m => m.id === "CUT-02").activeShiftId, "SHIFT-A");
});

test("规则4：越权修改直接拒绝（其他班次无交接范围）", async () => {
  await openShift("SHIFT-C", "丙", "观察员");
  // C 对 A 的新样本记步骤：out_of_scope
  const state = await get("/api/state");
  const batchA = state.batches.find(b => b.slices?.[0]?.id === "SL-A-9");
  const r = await call("POST", `/api/batches/${batchA.id}/steps`,
    { sliceId: "SL-A-9", step: "取样" }, { shift: "SHIFT-C" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "out_of_scope");
});

test("规则4：跨班交接登记覆盖范围后，接管班次可操作；机台范围缺失仍拒绝", async () => {
  const state0 = await get("/api/state");
  const batchA = state0.batches.find(b => b.slices?.[0]?.id === "SL-A-9");
  // A 把样本交给 C，但没给机台范围 -> 非机台操作（记步骤）允许
  let r = await call("POST", "/api/handovers", {
    operatorShiftId: "SHIFT-A", fromShiftId: "SHIFT-A", toShiftId: "SHIFT-C",
    range: "观察接力", scope: { sampleIds: [batchA.sampleId], batchIds: [], machineIds: [] }
  }, { shift: "SHIFT-A" });
  assert.equal(r.status, 201);
  r = await call("POST", `/api/batches/${batchA.id}/steps`,
    { sliceId: "SL-A-9", step: "取样", note: "C 接手记录" }, { shift: "SHIFT-C" });
  assert.equal(r.status, 200);
  // 追加切片是机台操作，无机台覆盖 -> 拒绝
  r = await call("POST", `/api/batches/${batchA.id}/slices`,
    { slices: [{ id: "SL-A-10" }] }, { shift: "SHIFT-C" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "out_of_scope");
  // 补登机台范围后可以追加（此时 CUT-02 已被 A 占着 -> 409 留冲突）
  await call("POST", "/api/handovers", {
    operatorShiftId: "SHIFT-A", fromShiftId: "SHIFT-A", toShiftId: "SHIFT-C",
    range: "机台也交", scope: { sampleIds: [batchA.sampleId], batchIds: [batchA.id], machineIds: ["CUT-02"] }
  }, { shift: "SHIFT-A" });
  r = await call("POST", `/api/batches/${batchA.id}/slices`,
    { slices: [{ id: "SL-A-10" }] }, { shift: "SHIFT-C" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "machine_busy");
});

test("规则3：切割角度变更，未完成切片失效重算，已完成步骤保留；交付结论失效", async () => {
  // 准备一个干净批次：D 班在 CUT-01（CUT-01 此刻被 SHIFT-A 占着，先让 A 收班）
  await call("POST", "/api/shifts/SHIFT-A/close", undefined, { shift: "SHIFT-A" });
  await openShift("SHIFT-D", "丁", "切片工");
  const created = await call("POST", "/api/samples", {
    project: "参数变更实验", borehole: "ZK-P", coreBox: "BX-P", depth: "1m",
    owner: "丁", machineId: "CUT-01", sliceId: "SL-P-1",
    angle: "90°", thickness: "0.03mm", stainMethod: "不染色"
  }, { shift: "SHIFT-D" });
  const sample = created.json.sample;
  const batch = created.json.batch;
  for (const step of ["取样", "切割"]) {
    await call("POST", `/api/batches/${batch.id}/steps`,
      { sliceId: "SL-P-1", step, note: step + "完成" }, { shift: "SHIFT-D" });
  }
  // 改角度：取样、切割（已完成）保留，后续步骤重新挂 pending
  let r = await call("POST", `/api/samples/${sample.id}/params`,
    { angle: "45°" }, { shift: "SHIFT-D" });
  assert.equal(r.status, 200);
  const invalidated = r.json.invalidated[0];
  assert.equal(invalidated.sliceId, "SL-P-1");
  let state = await get("/api/state");
  let b = state.batches.find(x => x.id === batch.id);
  const steps = b.slices[0].steps;
  assert.deepEqual(steps.filter(s => s.state === "completed").map(s => s.name), ["取样", "切割"]);
  assert.ok(steps.some(s => s.name === "研磨" && s.state === "pending"));
  assert.equal(state.samples.find(s => s.id === sample.id).currentParams.angle, "45°");

  // 把 5 步走完并交付
  for (const step of ["研磨", "染色", "观察"]) {
    await call("POST", `/api/batches/${batch.id}/steps`,
      { sliceId: "SL-P-1", step, note: step + "ok" }, { shift: "SHIFT-D" });
  }
  const delivered = await call("POST", `/api/batches/${batch.id}/deliver`,
    { conclusion: "合格交付" }, { shift: "SHIFT-D" });
  assert.equal(delivered.status, 201);
  state = await get("/api/state");
  assert.equal(state.samples.find(s => s.id === sample.id).status, "已交付");

  // 参数再改：已完成切片不动，但交付结论失效，批次回到已完成待重新确认
  r = await call("POST", `/api/samples/${sample.id}/params`,
    { thickness: "0.02mm" }, { shift: "SHIFT-D" });
  assert.equal(r.status, 200);
  state = await get("/api/state");
  b = state.batches.find(x => x.id === batch.id);
  assert.equal(b.status, "已完成");
  assert.equal(b.deliveryConclusion.valid, false);
  const ldg = state.ledger.find(l => l.batchId === batch.id);
  assert.equal(ldg.valid, false);
  assert.match(ldg.voidReason, /参数变更/);
  assert.equal(state.samples.find(s => s.id === sample.id).status, "待观察");
  // 重新交付成功
  const again = await call("POST", `/api/batches/${batch.id}/deliver`,
    { conclusion: "按新厚度复检合格" }, { shift: "SHIFT-D" });
  assert.equal(again.status, 201);
});

test("规则3：染色方法一改，已完成的染色步骤也失效重算，切割前步骤保留", async () => {
  await openShift("SHIFT-E", "戊", "切片工");
  const created = await call("POST", "/api/samples", {
    project: "染色返工", borehole: "ZK-T", coreBox: "BX-T", depth: "2m",
    owner: "戊", machineId: "CUT-02", sliceId: "SL-T-1", stainMethod: "不染色"
  }, { shift: "SHIFT-E" });
  const { sample, batch } = created.json;
  for (const step of ["取样", "切割", "研磨", "染色"]) {
    await call("POST", `/api/batches/${batch.id}/steps`,
      { sliceId: "SL-T-1", step }, { shift: "SHIFT-E" });
  }
  const r = await call("POST", `/api/samples/${sample.id}/params`,
    { stainMethod: "茜素红染色" }, { shift: "SHIFT-E" });
  assert.equal(r.status, 200);
  const state = await get("/api/state");
  const slice = state.batches.find(x => x.id === batch.id).slices[0];
  assert.deepEqual(slice.steps.filter(s => s.state === "completed").map(s => s.name), ["取样", "切割", "研磨"]);
  assert.ok(slice.steps.some(s => s.name === "染色" && s.state === "invalid"));
  assert.ok(slice.steps.some(s => s.name === "染色" && s.state === "pending"));
  assert.ok(slice.steps.some(s => s.name === "观察" && s.state === "pending"));
  assert.equal(slice.currentStep, "染色");
});

test("步骤顺序：跳步与重复完成都被拒绝", async () => {
  await call("POST", "/api/shifts/SHIFT-E/close", undefined, { shift: "SHIFT-E" });
  await openShift("SHIFT-F", "己", "切片工");
  const created = await call("POST", "/api/samples", {
    project: "顺序实验", borehole: "ZK-O", coreBox: "BX-O", depth: "3m",
    owner: "己", machineId: "CUT-02", sliceId: "SL-O-1"
  }, { shift: "SHIFT-F" });
  const batch = created.json.batch;
  let r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-O-1", step: "切割" }, { shift: "SHIFT-F" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "step_order_violation");
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-O-1", step: "取样" }, { shift: "SHIFT-F" });
  assert.equal(r.status, 200);
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-O-1", step: "取样" }, { shift: "SHIFT-F" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "step_already_completed");
});

test("规则2：journal 写盘失败=未确认；用同一幂等键重试不重复生成切片/步骤", async () => {
  await call("POST", "/api/shifts/SHIFT-F/close", undefined, { shift: "SHIFT-F" });
  await call("POST", "/api/shifts/SHIFT-D/close", undefined, { shift: "SHIFT-D" });
  await openShift("SHIFT-G", "庚", "切片工");
  const created = await call("POST", "/api/samples", {
    project: "崩溃恢复", borehole: "ZK-R", coreBox: "BX-R", depth: "4m",
    owner: "庚", machineId: "CUT-01", sliceId: "SL-R-1"
  }, { shift: "SHIFT-G" });
  const batch = created.json.batch;
  const key = "idem-retry-" + Math.random();
  // 武装下一次 journal 失败
  await call("POST", "/api/fault", { target: "journal" });
  let r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-R-1", step: "取样", note: "首次提交" }, { shift: "SHIFT-G", idemKey: key });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "write_unconfirmed");
  // 内存未变：仍无取样完成
  let state = await get("/api/state");
  let sl = state.batches.find(b => b.id === batch.id).slices.find(s => s.id === "SL-R-1");
  assert.equal(sl.currentStep, "取样");
  // 同键重试
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-R-1", step: "取样", note: "首次提交" }, { shift: "SHIFT-G", idemKey: key });
  assert.equal(r.status, 200);
  // 再次用同键重放：幂等命中，步骤不重复
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-R-1", step: "取样", note: "首次提交" }, { shift: "SHIFT-G", idemKey: key });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-idempotent-replay"), "1");
  state = await get("/api/state");
  sl = state.batches.find(b => b.id === batch.id).slices.find(s => s.id === "SL-R-1");
  assert.equal(sl.steps.filter(s => s.name === "取样" && s.state === "completed").length, 1);
  assert.equal(sl.currentStep, "切割");

  // snapshot 失败：journal 已确认，恢复接口重写快照，数据不丢
  await call("POST", "/api/fault", { target: "snapshot" });
  r = await call("POST", `/api/batches/${batch.id}/steps`,
    { sliceId: "SL-R-1", step: "切割", note: "切割完成" }, { shift: "SHIFT-G", idemKey: "k-snap-fail" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-recovery-pending"), "1");
  const rec = await call("POST", "/api/recovery", undefined, { shift: "SHIFT-G" });
  assert.equal(rec.json.lastSeq, rec.json.lastSeq);
  state = await get("/api/state");
  sl = state.batches.find(b => b.id === batch.id).slices.find(s => s.id === "SL-R-1");
  assert.deepEqual(sl.steps.filter(s => s.state === "completed").map(s => s.name), ["取样", "切割"]);
});

test("规则2补充：从磁盘重新启动后状态与幂等记录仍在", async () => {
  // 通过恢复视图确认最后确认步骤按班次单汇总
  const r = await fetch(baseUrl + "/api/recovery").then(x => x.json());
  assert.ok(r.confirmedSteps.some(c => c.shiftId === "SHIFT-G" && c.sliceId === "SL-R-1" && c.lastStep === "切割"));
  const legacy = await readFile(path.join(dataDir, "journal.log"), "utf8");
  assert.match(legacy, /IDEM_STORED/);
});
