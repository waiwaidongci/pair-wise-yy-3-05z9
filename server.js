import http from "node:http";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, JournalWriteError, SnapshotWriteError } from "./src/store.js";
import { DomainError, recoveryReport } from "./src/domain.js";
import { renderPage } from "./src/page.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const legacyPath = path.join(dataDir, "core-slices.json");
const port = Number(process.env.PORT || 3025);

function clock() { return new Date().toISOString(); }

const store = new Store(dataDir, { now: clock });

async function migrateLegacy() {
  if (!existsSync(legacyPath) || store.state.meta.legacyMigratedAt) return;
  const legacy = JSON.parse(await fs.readFile(legacyPath, "utf8"));
  if (!legacy.samples?.length) {
    await store.handle({ type: "legacy.import", legacy: { samples: [] } });
    return;
  }
  try {
    await store.handle({ type: "legacy.import", legacy });
    const archived = legacyPath.replace(/\.json$/, `.imported-${Date.now()}.json`);
    await fs.rename(legacyPath, archived);
    console.log(`老库已导入并归档：${archived}`);
  } catch (error) {
    console.warn("老库导入跳过：", error.message);
  }
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new DomainError(400, "bad_json", "请求体不是合法 JSON"); }
}
function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data, null, 2));
}
function shiftIdFrom(req, input) {
  return input.shiftId || req.headers["x-shift-id"] || null;
}

// 命令路由：[method, pathRegex, 构造命令]
const routes = [
  ["POST", /^\/api\/shifts$/, (input) => ({ type: "shift.open", id: input.id, role: input.role, person: input.person })],
  ["POST", /^\/api\/shifts\/([^/]+)\/close$/, (_i, m) => ({ type: "shift.close", shiftId: m[1] })],

  ["POST", /^\/api\/samples$/, (input) => ({
    type: "sample.create",
    project: input.project, borehole: input.borehole, coreBox: input.coreBox, depth: input.depth,
    owner: input.owner, machineId: input.machineId,
    angle: input.angle, thickness: input.thickness, stainMethod: input.stainMethod,
    sliceId: input.sliceId,
    slices: input.slices
  })],
  ["POST", /^\/api\/samples\/([^/]+)\/batches$/, (input, m) => ({
    type: "batch.submit", sampleId: m[1], machineId: input.machineId, slices: input.slices
  })],
  ["POST", /^\/api\/samples\/([^/]+)\/params$/, (input, m) => ({
    type: "params.change", sampleId: m[1],
    angle: input.angle, thickness: input.thickness, stainMethod: input.stainMethod
  })],
  ["POST", /^\/api\/samples\/backfill$/, () => ({ type: "samples.backfill" })],

  ["POST", /^\/api\/batches\/([^/]+)\/slices$/, (input, m) => ({
    type: "batch.addSlices", batchId: m[1], slices: input.slices
  })],
  ["POST", /^\/api\/batches\/([^/]+)\/steps$/, (input, m) => ({
    type: "step.record", batchId: m[1], sliceId: input.sliceId, step: input.step, note: input.note
  })],
  ["POST", /^\/api\/batches\/([^/]+)\/deliver$/, (input, m) => ({
    type: "batch.deliver", batchId: m[1], conclusion: input.conclusion
  })],
  ["POST", /^\/api\/batches\/([^/]+)\/takeover$/, (input, m) => ({
    type: "batch.takeover", batchId: m[1], machineId: input.machineId, range: input.range
  })],

  ["POST", /^\/api\/handovers$/, (input) => ({
    type: "handover.register",
    operatorShiftId: input.operatorShiftId,
    fromShiftId: input.fromShiftId, toShiftId: input.toShiftId, range: input.range, scope: input.scope
  })],

  ["POST", /^\/api\/conflicts\/([^/]+)\/resolve$/, (input, m) => ({
    type: "conflict.resolve", conflictId: m[1], resolution: input.resolution
  })]
];

function stateView() {
  const s = store.state;
  return {
    shifts: Object.values(s.shifts),
    machines: Object.values(s.machines),
    samples: s.sampleOrder.map(id => s.samples[id]),
    batches: s.batchOrder.map(id => s.batches[id]),
    handovers: s.handovers,
    conflicts: Object.values(s.conflicts),
    ledger: s.ledger
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, stateView());
    if (req.method === "GET" && url.pathname === "/api/ledger") return send(res, 200, store.state.ledger);
    if (req.method === "GET" && url.pathname === "/api/conflicts") return send(res, 200, Object.values(store.state.conflicts));
    if (req.method === "GET" && url.pathname === "/api/recovery") {
      return send(res, 200, { ...recoveryReport(store.state), dataDir });
    }
    if (req.method === "POST" && url.pathname === "/api/recovery") {
      await store.recover();
      return send(res, 200, recoveryReport(store.state));
    }
    if (req.method === "POST" && url.pathname === "/api/fault") {
      const input = await body(req);
      store.nextWriteFail = input.target === "snapshot" ? "snapshot" : "journal";
      return send(res, 200, { ok: true, armed: input.target });
    }

    for (const [method, re, build] of routes) {
      const match = url.pathname.match(re);
      if (match && req.method === method) {
        const input = await body(req);
        const shiftId = shiftIdFrom(req, input);
        const command = build(input, match);
        if (needsShift(command.type)) {
          if (!shiftId) throw new DomainError(401, "shift_required", "缺少班次单（X-Shift-Id 或 shiftId）");
          command.shiftId = shiftId;
        }
        const fault = store.nextWriteFail; // 本次请求内消耗，无论成功失败都只生效一次
        let result;
        try {
          result = await store.handle(command, { idemKey: req.headers["idempotency-key"] || command.idemKey || null });
        } finally {
          if (fault) store.nextWriteFail = null;
        }
        const headers = {};
        if (result.replayed) headers["X-Idempotent-Replay"] = "1";
        if (result.snapshotError) headers["X-Recovery-Pending"] = "1";
        return send(res, result.status, result.body, headers);
      }
    }
    return send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof DomainError) return send(res, error.status, { error: error.code, message: error.message, ...error.extra });
    if (error instanceof JournalWriteError) {
      // 未确认：内存与 snapshot 未动，客户端按同一 Idempotency-Key 重试即可
      return send(res, 503, { error: "write_unconfirmed", message: "写盘失败：改动未确认，请按班次单重试", retry: true });
    }
    if (error instanceof SnapshotWriteError) {
      return send(res, 503, { error: "snapshot_failed", message: "快照失败，journal 已确认，可恢复", recovery: true });
    }
    send(res, 500, { error: "internal_error", message: error.message });
  }
});

function needsShift(type) {
  return !["shift.open"].includes(type);
}

store.init().then(async () => {
  await migrateLegacy();
  server.listen(port, () => console.log(`岩芯班次账监听 http://localhost:${port}（数据目录 ${dataDir}）`));
}).catch(error => {
  console.error("启动失败：", error);
  process.exit(1);
});

export { server };
