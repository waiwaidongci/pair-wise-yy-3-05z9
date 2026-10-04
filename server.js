import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ShiftLedger, STEPS, MACHINES, SAMPLE_STATUSES } from "./shift-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-slices.json");
const port = Number(process.env.PORT || 3025);

const seed = {
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      machineId: "M-01",
      angle: "12°",
      thickness: "0.03mm",
      status: "制片中",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          angle: "12°",
          thickness: "0.03mm",
          observation: "",
          status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" },
          ],
        },
      ],
    },
  ],
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 兼容旧数据：补齐字段
  for (const s of db.samples || []) {
    s.createdAt ||= s.slices?.[0]?.logs?.[0]?.at || "2026-01-01T00:00:00.000Z";
    s.machineId ||= "M-01";
    s.angle ||= "";
    s.thickness ||= "";
    s.deliveryRecalc ||= false;
    s.sequenceInvalid ||= false;
    for (const sl of s.slices || []) {
      sl.angle ||= s.angle;
      sl.thickness ||= s.thickness;
      sl.needsRecalc ||= false;
      sl.traceable ||= false;
    }
  }
  return db;
}
async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室 · 班次账</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --warn:#a05a2c; --bad:#9c3b2e; --ok:#3f6b4a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:18px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; }
    h1 { margin:0; font-size:22px; } h2 { margin:0 0 12px; font-size:16px; }
    main { display:grid; grid-template-columns:380px 1fr; gap:18px; padding:18px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; } textarea { min-height:56px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px; }
    button.ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
    button.danger { background:var(--bad); } button.warn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:12px; } .stat strong { display:block; font-size:20px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:10px; } .card { display:grid; gap:6px; }
    .meta { color:var(--muted); font-size:12px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:11px; }
    .pill.ok { background:#e7efe6; color:var(--ok); border-color:#c3d4c1; } .pill.warn { background:#f6e8dc; color:var(--warn); border-color:#e6c9b0; } .pill.bad { background:#f3e0dc; color:var(--bad); border-color:#e0bdb6; }
    .slice { border-top:1px solid var(--line); padding-top:8px; } .toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; } .row > * { flex:1; }
    table { width:100%; border-collapse:collapse; font-size:12px; } th,td { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:600; }
    .banner { background:#f6e8dc; border:1px solid #e6c9b0; color:var(--warn); border-radius:6px; padding:8px 10px; font-size:12px; margin-bottom:10px; }
    .banner.bad { background:#f3e0dc; border-color:#e0bdb6; color:var(--bad); }
    .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; }
    @media (max-width:950px){ header{display:block;padding:14px 16px;} main{grid-template-columns:1fr;padding:14px;} .stats{grid-template-columns:repeat(2,1fr);} }
  </style>
</head>
<body>
  <header>
    <div><h1>岩芯样本切片实验室 · 班次账</h1><div class="meta">样本 · 切片批次 · 制片步骤 · 交付台账 统一接班次单</div></div>
    <div class="row" style="flex:unset;">
      <label style="margin:0;">操作员<input id="operator" placeholder="交接人姓名" style="width:130px;"></label>
      <label style="margin:0;">当前班次单<select id="shiftOrder" style="width:200px;"></select></label>
      <button id="reload" class="ghost">刷新</button>
    </div>
  </header>
  <main>
    <div style="display:grid;gap:14px;align-content:start;">
      <form id="form">
        <h2>创建岩芯样本</h2>
        <label>项目</label><input name="project" required>
        <label>钻孔编号</label><input name="borehole" required>
        <label>岩芯箱号</label><input name="coreBox" required>
        <label>取样深度</label><input name="depth" required>
        <label>负责人</label><input name="owner" required>
        <label>切片机</label>
        <select name="machineId">${MACHINES.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
        <label>切割角度</label><input name="angle" placeholder="如 12°">
        <label>厚度</label><input name="thickness" placeholder="如 0.03mm">
        <label>染色方法</label><input name="method" required>
        <label>初始切片编号</label><input name="sliceId" required>
        <button>保存样本</button>
      </form>

      <form id="shiftForm" class="panel">
        <h2>开班 / 跨班接管</h2>
        <label>切片机</label>
        <select name="machineId">${MACHINES.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
        <label>班次</label><input name="shift" placeholder="白班 / 夜班" required>
        <label>交出人</label><input name="handoverFrom" required>
        <label>接管人（当前操作员）</label><input name="handoverTo" required>
        <label>覆盖样本编号（逗号分隔，可空）</label><input name="scopeSampleIds" placeholder="CORE-...">
        <label>覆盖切片编号（逗号分隔，可空）</label><input name="scopeSliceIds" placeholder="SL-...">
        <label>上一班次单（跨班接管时填）</label><input name="priorShiftOrderId" placeholder="SHIFT-...">
        <button>开班 / 接管</button>
        <div id="shiftMsg" class="meta"></div>
      </form>

      <div class="panel">
        <h2>恢复与演练</h2>
        <div class="row">
          <button id="recover" class="warn">按班次单恢复</button>
          <button id="toggleFail" class="ghost">模拟写盘失败：关</button>
        </div>
        <div id="recoverMsg" class="meta"></div>
      </div>
    </div>

    <section style="display:grid;gap:14px;align-content:start;">
      <div class="stats" id="stats"></div>
      <div id="banners"></div>
      <div class="grid" id="samples"></div>

      <div class="panel">
        <h2>班次单</h2>
        <table id="shiftTable"><thead><tr><th>编号</th><th>切片机</th><th>班次</th><th>交接</th><th>覆盖范围</th><th>状态</th></tr></thead><tbody></tbody></table>
      </div>

      <div class="panel">
        <h2>冲突（先到者开工，后到内容留冲突）</h2>
        <table id="conflictTable"><thead><tr><th>编号</th><th>切片机</th><th>后到方</th><th>先到班次单</th><th>状态</th></tr></thead><tbody></tbody></table>
      </div>

      <div class="panel">
        <h2>切片批次</h2>
        <table id="batchTable"><thead><tr><th>编号</th><th>班次单</th><th>切片机</th><th>样本</th><th>切片</th><th>状态</th></tr></thead><tbody></tbody></table>
      </div>

      <div class="panel">
        <h2>交付台账</h2>
        <table id="ledgerTable"><thead><tr><th>编号</th><th>班次单</th><th>样本</th><th>结论</th><th>交付人</th><th>状态</th><th>时间</th></tr></thead><tbody></tbody></table>
      </div>

      <div class="panel">
        <h2>操作日志（幂等 / 恢复）</h2>
        <table id="journalTable"><thead><tr><th>编号</th><th>类型</th><th>班次单</th><th>幂等键</th><th>尝试</th><th>状态</th><th>时间</th></tr></thead><tbody></tbody></table>
      </div>
    </section>
  </main>
  <script>
    const steps = ${JSON.stringify(STEPS)};
    const statuses = ${JSON.stringify(SAMPLE_STATUSES)};
    const $ = (id) => document.querySelector(id);
    const state = { samples: [], shiftOrders: [], conflicts: [], batches: [], ledger: [], journal: [], failWrites: false };

    function idemKey() { return "idem-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
    function operator() { return $("#operator").value.trim(); }
    function shiftOrderId() { return $("#shiftOrder").value; }
    function authBody(extra) { return { ...extra, shiftOrderId: shiftOrderId(), operator: operator(), idemKey: idemKey() }; }

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    const pill = (s) => {
      const cls = s === "已确认" || s === "已完成" || s === "有效" || s === "已交付" ? "ok" : (s === "冲突" || s === "失效" || s === "failed" ? "bad" : (s === "待接管" || s === "rolled_back" ? "warn" : ""));
      return '<span class="pill ' + cls + '">' + s + '</span>';
    };

    function renderBanners() {
      const el = $("#banners");
      const pending = state.shiftOrders.filter((s) => s.status === "待接管").length;
      const openConflicts = state.conflicts.filter((c) => c.status === "open").length;
      const failed = state.journal.filter((j) => j.status === "failed" || j.status === "pending").length;
      el.innerHTML = (pending ? '<div class="banner">有 ' + pending + ' 个待接管班次单（老样本按创建日期补入），接管后才能开工。</div>' : "")
        + (openConflicts ? '<div class="banner bad">有 ' + openConflicts + ' 条冲突未处理：同一台切片机先到者已开工，后到内容留冲突。</div>' : "")
        + (failed ? '<div class="banner bad">有 ' + failed + ' 次写盘失败/未确认，可"按班次单恢复"到最后确认步骤。</div>' : "");
    }

    function renderShiftSelect() {
      const sel = $("#shiftOrder");
      const mine = state.shiftOrders.filter((s) => s.status === "进行中" && s.handoverTo === operator());
      const current = sel.value;
      sel.innerHTML = mine.map((s) => '<option value="' + s.id + '">' + s.id + ' · ' + s.machineId + ' · ' + s.shift + '</option>').join("");
      if (current && mine.some((s) => s.id === current)) sel.value = current;
      if (!mine.length) sel.innerHTML = '<option value="">（无进行中的班次单）</option>';
    }

    function render() {
      $("#stats").innerHTML = statuses.map((s) => '<div class="stat"><span>' + s + '</span><strong>' + state.samples.filter((it) => it.status === s).length + '</strong></div>').join("");
      renderBanners();
      renderShiftSelect();
      $("#samples").innerHTML = state.samples.map((sample) => {
        const so = state.shiftOrders.find((s) => s.id === sample.shiftOrderId);
        return '<article class="card"><h3>' + sample.project + '</h3>'
          + '<div class="meta">' + sample.borehole + ' · ' + sample.coreBox + ' · ' + sample.depth + ' · ' + sample.owner + '</div>'
          + '<div class="row"><span class="pill">' + sample.status + '</span>'
          + '<span class="pill ' + (sample.delivery === "已交付" ? "ok" : "") + '">' + sample.delivery + '</span>'
          + (sample.deliveryRecalc ? '<span class="pill bad">交付结论失效重算</span>' : "")
          + (sample.sequenceInvalid ? '<span class="pill warn">步骤顺序失效</span>' : "")
 + '<span class="pill">' + (sample.machineId || "") + '</span></div>'
          + '<div class="meta">角度 ' + (sample.angle || "-") + ' · 厚度 ' + (sample.thickness || "-") + ' · 染色 ' + (sample.method || "-") + '</div>'
          + '<div class="meta">班次单：' + (so ? so.id + "（" + so.status + "）" : "无") + '</div>'
          + '<div class="row"><input data-new-slice="' + sample.id + '" placeholder="切片编号"><input data-method="' + sample.id + '" placeholder="染色方法"></div>'
          + '<button data-add="' + sample.id + '">添加切片</button>'
          + sample.slices.map((slice) => '<div class="slice"><b>' + slice.id + '</b> '
            + (slice.needsRecalc ? '<span class="pill warn">未完成·失效重算</span>' : "")
            + (slice.traceable ? '<span class="pill ok">已完成·可追溯</span>' : "")
            + '<div class="meta">' + slice.method + ' · 当前步骤 ' + slice.status + ' · ' + (slice.angle || "-") + ' / ' + (slice.thickness || "-") + '</div>'
            + '<select data-step="' + sample.id + '|' + slice.id + '">' + steps.map((s) => '<option>' + s + '</option>').join("") + '</select>'
            + '<textarea data-note="' + sample.id + '|' + slice.id + '" placeholder="步骤备注或观察结果"></textarea>'
            + '<button data-log="' + sample.id + '|' + slice.id + '">记录步骤</button>'
            + '<div class="meta">' + slice.logs.map((l) => l.step + "：" + l.note).join(" / ") + '</div></div>').join("")
          + '<div class="row"><input data-angle="' + sample.id + '" placeholder="新角度"><input data-thickness="' + sample.id + '" placeholder="新厚度"><input data-method2="' + sample.id + '" placeholder="新染色方法"></div>'
          + '<button data-params="' + sample.id + '" class="warn">变更参数（失效重算）</button>'
          + '<button data-deliver="' + sample.id + '" class="ghost">标记交付</button></article>';
      }).join("");

      document.querySelectorAll("[data-step]").forEach((sel) => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const sl = state.samples.find((s) => s.id === sampleId)?.slices.find((x) => x.id === sliceId);
        if (sl) sel.value = sl.status;
      });
      document.querySelectorAll("[data-add]").forEach((btn) => btn.onclick = async () => {
        await api("/api/samples/" + btn.dataset.add + "/slices", { method: "POST", body: JSON.stringify(authBody({ id: document.querySelector('[data-new-slice="' + btn.dataset.add + '"]').value, method: document.querySelector('[data-method="' + btn.dataset.add + '"]').value || "未指定" })) });
        await load();
      });
      document.querySelectorAll("[data-log]").forEach((btn) => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        await api("/api/samples/" + sampleId + "/slices/" + sliceId + "/logs", { method: "POST", body: JSON.stringify(authBody({ step: document.querySelector('[data-step="' + sampleId + '|' + sliceId + '"]').value, note: document.querySelector('[data-note="' + sampleId + '|' + sliceId + '"]').value || "步骤完成" })) });
        await load();
      });
      document.querySelectorAll("[data-params]").forEach((btn) => btn.onclick = async () => {
        const id = btn.dataset.params;
        await api("/api/samples/" + id + "/params", { method: "POST", body: JSON.stringify(authBody({ angle: document.querySelector('[data-angle="' + id + '"]').value || undefined, thickness: document.querySelector('[data-thickness="' + id + '"]').value || undefined, method: document.querySelector('[data-method2="' + id + '"]').value || undefined })) });
        await load();
      });
      document.querySelectorAll("[data-deliver]").forEach((btn) => btn.onclick = async () => {
        await api("/api/samples/" + btn.dataset.deliver + "/deliver", { method: "POST", body: JSON.stringify(authBody({ conclusion: "符合交付要求" })) });
        await load();
      });

      $("#shiftTable").querySelector("tbody").innerHTML = state.shiftOrders.map((s) => {
        const scope = (s.scope.sampleIds.length ? s.scope.sampleIds.join(", ") : "") + (s.scope.sliceIds.length ? " / " + s.scope.sliceIds.join(", ") : "");
        return "<tr><td class='mono'>" + s.id + "</td><td>" + s.machineId + "</td><td>" + s.shift + "</td><td>" + s.handoverFrom + " → " + s.handoverTo + "</td><td class='mono'>" + (scope || "-") + "</td><td>" + pill(s.status) + "</td></tr>";
      }).join("");
      $("#conflictTable").querySelector("tbody").innerHTML = state.conflicts.map((c) => "<tr><td class='mono'>" + c.id + "</td><td>" + c.machineId + "</td><td>" + c.contending.handoverTo + "（" + c.contending.shift + "）</td><td class='mono'>" + c.winningShiftOrderId + "</td><td>" + pill(c.status) + "</td></tr>").join("");
      $("#batchTable").querySelector("tbody").innerHTML = state.batches.map((b) => "<tr><td class='mono'>" + b.id + "</td><td class='mono'>" + b.shiftOrderId + "</td><td>" + b.machineId + "</td><td>" + b.sampleIds.length + "</td><td>" + b.sliceIds.length + "</td><td>" + pill(b.status) + "</td></tr>").join("");
      $("#ledgerTable").querySelector("tbody").innerHTML = state.ledger.map((l) => "<tr><td class='mono'>" + l.id + "</td><td class='mono'>" + l.shiftOrderId + "</td><td class='mono'>" + l.sampleId + "</td><td>" + l.conclusion + "</td><td>" + l.operator + "</td><td>" + pill(l.status) + "</td><td class='mono'>" + (l.deliveredAt || "").replace("T", " ").slice(0, 16) + "</td></tr>").join("");
      $("#journalTable").querySelector("tbody").innerHTML = state.journal.map((j) => "<tr><td class='mono'>" + j.id + "</td><td>" + j.type + "</td><td class='mono'>" + (j.shiftOrderId || "-") + "</td><td class='mono'>" + j.idemKey.slice(0, 18) + "</td><td>" + j.attempts + "</td><td>" + pill(j.status) + "</td><td class='mono'>" + (j.createdAt || "").replace("T", " ").slice(0, 16) + "</td></tr>").join("");
    }

    async function load() {
      const [samples, shiftOrders, conflicts, batches, ledger, journal] = await Promise.all([
        api("/api/samples"), api("/api/shift-orders"), api("/api/conflicts"), api("/api/batches"), api("/api/delivery-ledger"), api("/api/journal"),
      ]);
      state.samples = samples; state.shiftOrders = shiftOrders; state.conflicts = conflicts; state.batches = batches; state.ledger = ledger; state.journal = journal;
      render();
    }

    $("#operator").addEventListener("input", () => { localStorage.setItem("operator", operator()); renderShiftSelect(); });
    $("#reload").onclick = load;
    $("#toggleFail").onclick = async () => {
      state.failWrites = !state.failWrites;
      await api("/api/admin/fail-writes", { method: "POST", body: JSON.stringify({ on: state.failWrites }) });
      $("#toggleFail").textContent = "模拟写盘失败：" + (state.failWrites ? "开" : "关");
    };
    $("#recover").onclick = async () => {
      const r = await api("/api/recover", { method: "POST", body: "{}" });
      $("#recoverMsg").textContent = "已恢复 " + r.rolledBack.length + " 条到最后确认步骤" + (r.inFlight.length ? "，" + r.inFlight.length + " 条进行中未动" : "");
      await load();
    };

    form.onsubmit = async (event) => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData(form).entries());
      await api("/api/samples", { method: "POST", body: JSON.stringify(authBody(f)) });
      form.reset(); await load();
    };
    $("#shiftForm").onsubmit = async (event) => {
      event.preventDefault();
      const f = Object.fromEntries(new FormData($("#shiftForm")).entries());
      const body = { machineId: f.machineId, shift: f.shift, handoverFrom: f.handoverFrom, handoverTo: f.handoverTo, priorShiftOrderId: f.priorShiftOrderId || undefined, scope: { sampleIds: f.scopeSampleIds ? f.scopeSampleIds.split(",").map((s) => s.trim()).filter(Boolean) : [], sliceIds: f.scopeSliceIds ? f.scopeSliceIds.split(",").map((s) => s.trim()).filter(Boolean) : [] } };
      const r = await api("/api/shift-orders/start", { method: "POST", body: JSON.stringify({ ...body, idemKey: idemKey() }) });
      $("#shiftMsg").textContent = r.machineBusy ? "冲突：切片机 " + f.machineId + " 已被先到班次单占用，后到内容已留冲突（" + r.conflict.id + "）" : (r.tookOver ? "已接管待接管批次：" + r.shiftOrder.id : "已开班：" + r.shiftOrder.id);
      $("#shiftMsg").style.color = r.machineBusy ? "var(--bad)" : "var(--ok)";
      $("#operator").value = f.handoverTo; localStorage.setItem("operator", f.handoverTo);
      $("#shiftForm").reset(); await load();
    };

    const saved = localStorage.getItem("operator");
    if (saved) $("#operator").value = saved;
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const ledger = new ShiftLedger(db, {
      save: saveDb,
      failWrites: server._failWrites ? 1 : 0,
    });
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/samples") return sendJson(res, 200, db.samples);
    if (req.method === "GET" && url.pathname === "/api/shift-orders") return sendJson(res, 200, ledger.listShiftOrders());
    if (req.method === "GET" && url.pathname === "/api/conflicts") return sendJson(res, 200, ledger.listConflicts());
    if (req.method === "GET" && url.pathname === "/api/batches") return sendJson(res, 200, ledger.listBatches());
    if (req.method === "GET" && url.pathname === "/api/delivery-ledger") return sendJson(res, 200, ledger.listDeliveryLedger());
    if (req.method === "GET" && url.pathname === "/api/journal") return sendJson(res, 200, ledger.listJournal());

    if (req.method === "POST" && url.pathname === "/api/samples") {
      const result = await ledger.createSample(await body(req));
      return sendJson(res, 201, result);
    }
    const addSlice = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSlice && req.method === "POST") {
      const result = await ledger.addSlice({ ...(await body(req)), sampleId: addSlice[1] });
      return sendJson(res, 201, result);
    }
    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const result = await ledger.logStep({ ...(await body(req)), sampleId: logMatch[1], sliceId: logMatch[2] });
      return sendJson(res, 200, result);
    }
    const paramsMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/params$/);
    if (paramsMatch && req.method === "POST") {
      const result = await ledger.changeParams({ ...(await body(req)), sampleId: paramsMatch[1] });
      return sendJson(res, 200, result);
    }
    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const result = await ledger.deliver({ ...(await body(req)), sampleId: deliverMatch[1] });
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/shift-orders/start") {
      const result = await ledger.startShift(await body(req));
      return sendJson(res, 201, result);
    }
    if (req.method === "POST" && url.pathname === "/api/shift-orders/confirm") {
      const result = await ledger.confirmShift(await body(req));
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/backfill") {
      const result = await ledger.backfill();
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/recover") {
      const result = await ledger.recover();
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/admin/fail-writes") {
      const input = await body(req);
      server._failWrites = !!input.on;
      return sendJson(res, 200, { failWrites: server._failWrites });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const status = error.status || 500;
    sendJson(res, status, { error: error.error || error.message, ...(error.cause ? { cause: error.cause } : {}) });
  }
});

server.listen(port, async () => {
  // 启动时回填无班次单的老样本
  try {
    const db = await loadDb();
    const ledger = new ShiftLedger(db, { save: saveDb });
    const r = await ledger.backfill();
    const res = r.result || r;
    if (res.created.length) console.log(`回填 ${res.uncovered} 个老样本为 ${res.created.length} 个待接管批次`);
  } catch (e) {
    console.error("回填失败:", e.message);
  }
  console.log(`Core slice lab app listening on http://localhost:${port}`);
});
