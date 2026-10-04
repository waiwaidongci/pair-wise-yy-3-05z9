// 前端页面（零依赖，服务端直接返回）
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>岩芯班次账</title>
<style>
  :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#9a6a2b; --bad:#8a3b32; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; font-size:14px; }
  header { padding:16px 24px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { margin:0; font-size:22px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0 0 6px; font-size:15px; }
  main { padding:18px 24px; display:grid; gap:16px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
  .panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
  label { display:block; margin:8px 0 4px; color:var(--muted); font-size:12px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px; }
  button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
  button.danger { background:var(--bad); }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; margin:2px 4px 2px 0; }
  .pill.open { background:#e8f0e2; } .pill.closed { background:#ececea; color:var(--muted); }
  .pill.warn { background:#f6ead7; color:var(--warn); } .pill.bad { background:#f4e1de; color:var(--bad); }
  .meta { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; } td,th { border-bottom:1px solid var(--line); padding:6px 8px; text-align:left; vertical-align:top; }
  .slice { border-top:1px dashed var(--line); margin-top:8px; padding-top:8px; }
  .step { display:inline-block; padding:2px 7px; margin:2px 3px 0 0; border-radius:5px; font-size:12px; border:1px solid var(--line); }
  .step.completed { background:#e8f0e2; } .step.in_progress { background:#f6ead7; } .step.invalid { background:#f4e1de; color:var(--bad); text-decoration:line-through; }
  .hidden { display:none; }
  #toast { position:fixed; right:18px; bottom:18px; max-width:420px; background:#2b3325; color:#fff; padding:10px 14px; border-radius:8px; display:none; white-space:pre-wrap; }
</style>
</head>
<body>
<header>
  <div><h1>岩芯库班次账</h1><div class="meta">先到者开台 · 后到留冲突 · 参数变更失效重算 · 交接可追溯</div></div>
  <div class="row">
    <div><label>当前班次单</label><select id="shiftSelect" style="min-width:220px"></select></div>
    <button class="ghost" id="reload">刷新</button>
    <button class="ghost" id="recover">写盘恢复</button>
  </div>
</header>
<main>
  <section class="row">
    <div class="panel" style="flex:1;min-width:300px">
      <h2>开班次单</h2>
      <div class="row">
        <div><label>班次号</label><input id="openShiftId" placeholder="SHIFT-A"></div>
        <div><label>角色</label><select id="openRole"><option>切片工</option><option>观察员</option></select></div>
        <div><label>姓名</label><input id="openPerson" placeholder="交班人姓名"></div>
        <button id="openShift">开班</button>
      </div>
    </div>
    <div class="panel" style="flex:1;min-width:300px">
      <h2>机台占用</h2>
      <div id="machines"></div>
      <div class="meta">同一台切片机先到者开工；晚到记录进入冲突区。<button class="ghost" id="armFault">模拟下一次写盘失败</button></div>
    </div>
  </section>

  <section class="panel">
    <h2>创建样本并开切（首个切片批次，自动占机台）</h2>
    <div class="row">
      <div><label>项目</label><input id="sProject" value="东岭铜矿薄片"></div>
      <div><label>钻孔</label><input id="sBorehole" placeholder="ZK-18"></div>
      <div><label>岩芯箱</label><input id="sBox" placeholder="BX-10"></div>
      <div><label>深度</label><input id="sDepth" placeholder="130.0-130.4m"></div>
      <div><label>负责人</label><input id="sOwner"></div>
      <div><label>机台</label><select id="sMachine"></select></div>
      <div><label>切割角度</label><input id="sAngle" value="90°"></div>
      <div><label>厚度</label><input id="sThickness" value="0.03mm"></div>
      <div><label>染色方法</label><input id="sStain" value="茜素红染色"></div>
      <div><label>首切片号</label><input id="sSlice" placeholder="SL-002-A"></div>
      <button id="createSample">保存并开切</button>
    </div>
  </section>

  <section class="panel">
    <h2>跨班交接登记</h2>
    <div class="row">
      <div><label>交出班次</label><input id="hvFrom" placeholder="SHIFT-A / legacy"></div>
      <div><label>接管班次</label><input id="hvTo" placeholder="SHIFT-B"></div>
      <div><label>覆盖范围说明</label><input id="hvRange" placeholder="如：ZK-17 全部批次"></div>
      <div><label>样本ID（逗号分隔）</label><input id="hvSamples" placeholder="CORE-0001"></div>
      <div><label>批次ID（逗号分隔）</label><input id="hvBatches"></div>
      <div><label>机台ID（逗号分隔，机台操作必填）</label><input id="hvMachines" placeholder="CUT-01"></div>
      <button id="registerHandover">登记交接</button>
    </div>
    <div id="handovers" style="margin-top:8px"></div>
  </section>

  <section class="panel">
    <h2>冲突区（晚到记录）</h2>
    <div id="conflicts" class="meta">暂无挂起冲突</div>
  </section>

  <section>
    <h2>样本与切片批次</h2>
    <div id="samples" class="grid"></div>
  </section>

  <section class="panel">
    <h2>交付台账</h2>
    <table><thead><tr><th>时间</th><th>批次</th><th>样本</th><th>班次</th><th>结论</th><th>状态</th></tr></thead><tbody id="ledger"></tbody></table>
  </section>
</main>
<div id="toast"></div>

<script>
let state = { shifts: [], machines: [], samples: [], batches: [], handovers: [], conflicts: [], ledger: [] };
let currentShift = localStorage.getItem("shift") || "";
let faultArmed = false;
function idem() {
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return "k-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}
async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (currentShift) headers["X-Shift-Id"] = currentShift;
  if (options.body) headers["Content-Type"] = "application/json";
  if (!headers["Idempotency-Key"] && options.body) headers["Idempotency-Key"] = idem();
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || "请求失败"), { status: res.status, data });
  return data;
}
function toast(msg, bad) {
  const el = document.querySelector("#toast");
  el.style.background = bad ? "#7a2f28" : "#2b3325";
  el.textContent = msg; el.style.display = "block";
  clearTimeout(el._t); el._t = setTimeout(() => el.style.display = "none", 4200);
}
function esc(v) { return String(v ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
function shiftPill(id) {
  const sh = state.shifts.find(s => s.id === id);
  if (id === "legacy" || id === null) return '<span class="pill closed">老批次/无班次</span>';
  if (!sh) return '<span class="pill bad">'+esc(id)+'</span>';
  return '<span class="pill '+sh.status+'">'+esc(sh.id)+' · '+esc(sh.person)+' · '+esc(sh.role)+(sh.status === "closed" ? " · 已关闭" : "")+'</span>';
}
function batchOfSample(sampleId) {
  return state.batches.filter(b => b.sampleId === sampleId).slice(-1)[0];
}
function allBatchesOf(sampleId) { return state.batches.filter(b => b.sampleId === sampleId); }

async function load() {
  state = await api("/api/state");
  render();
}
function render() {
  const sel = document.querySelector("#shiftSelect");
  sel.innerHTML = '<option value="">（未选择班次）</option>' + state.shifts.map(s =>
    '<option value="'+esc(s.id)+'"'+(s.id === currentShift ? " selected" : "")+'>'+esc(s.id)+' · '+esc(s.person)+'（'+esc(s.role)+'，'+s.status+'）</option>').join("");
  document.querySelector("#machines").innerHTML = state.machines.map(m =>
    '<div style="margin:4px 0"><b>'+esc(m.id)+' '+esc(m.name)+'</b> ' +
    (m.activeShiftId ? '<span class="pill warn">占用中：'+esc(m.activeShiftId)+(m.activeBatchId ? " / "+esc(m.activeBatchId) : "")+'</span>' : '<span class="pill open">空闲</span>') + '</div>').join("");
  document.querySelector("#sMachine").innerHTML = state.machines.map(m => '<option>'+esc(m.id)+'</option>').join("");
  document.querySelector("#conflicts").innerHTML = state.conflicts.filter(c => c.status === "pending").length
    ? '<table><thead><tr><th>时间</th><th>提交班次</th><th>动作</th><th>机台</th><th>占用方</th><th>内容</th><th>处置</th></tr></thead><tbody>' +
      state.conflicts.filter(c => c.status === "pending").map(c => '<tr><td>'+esc(c.at.slice(11,19))+'</td><td>'+esc(c.shiftId)+'</td><td>'+esc(c.action)+'</td><td>'+esc(c.machineId)+'</td><td>'+esc(c.heldByShiftId)+'</td><td><pre style="margin:0;white-space:pre-wrap">'+esc(JSON.stringify(c.payload))+'</pre></td><td><button data-apply="'+esc(c.id)+'">应用</button> <button class="danger" data-discard="'+esc(c.id)+'">作废</button></td></tr>').join("") + '</tbody></table>'
    : '<div class="meta">暂无挂起冲突</div>';
  document.querySelector("#handovers").innerHTML = state.handovers.map(h =>
    '<span class="pill '+(h.status === "active" ? "open" : "closed")+'">'+esc(h.id)+': '+esc(h.fromShiftId)+' → '+esc(h.toShiftId)+
    ' 范围['+esc(h.scope.sampleIds.concat(h.scope.batchIds).join(","))+'] 机台['+esc(h.scope.machineIds.join(","))+'] '+esc(h.range)+'</span>').join("");
  document.querySelector("#ledger").innerHTML = state.ledger.length ? state.ledger.map(l =>
    '<tr><td>'+esc(l.at)+'</td><td>'+esc(l.batchId)+'</td><td>'+esc(l.sampleId)+'</td><td>'+esc(l.shiftId)+'</td><td>'+esc(l.conclusion)+'</td><td>'+(l.valid ? '<span class="pill open">有效</span>' : '<span class="pill bad">已失效：'+esc(l.voidReason||"")+'</span>')+'</td></tr>').join("")
    : '<tr><td colspan="6" class="meta">暂无交付记录</td></tr>';
  renderSamples();
}
function renderSamples() {
  document.querySelector("#samples").innerHTML = state.samples.map(sample => {
    const batches = allBatchesOf(sample.id);
    return '<article class="card"><h3>'+esc(sample.id)+' · '+esc(sample.project)+'</h3>' +
      '<div><span class="pill '+({"已交付":"open","待接管":"warn"}[sample.status]||"")+'">'+esc(sample.status)+'</span><span class="pill">'+esc(sample.delivery)+'</span></div>' +
      '<div class="meta">'+esc(sample.borehole)+' · '+esc(sample.coreBox)+' · '+esc(sample.depth)+' · 负责人 '+esc(sample.owner)+'</div>' +
      '<div class="meta">当前参数 v'+sample.paramsVersion+'：角度 '+esc(sample.currentParams.angle)+' / 厚度 '+esc(sample.currentParams.thickness)+' / 染色 '+esc(sample.currentParams.stainMethod)+'</div>' +
      '<div class="row" style="margin-top:6px"><div style="flex:1"><label>新角度</label><input data-p-angle="'+sample.id+'"></div><div style="flex:1"><label>新厚度</label><input data-p-thick="'+sample.id+'"></div><div style="flex:1"><label>新染色</label><input data-p-stain="'+sample.id+'"></div><button data-params="'+sample.id+'">改参数（失效重算）</button></div>' +
      batches.map(batchCard).join("") +
      '<div class="row" style="margin-top:8px"><div style="flex:1"><label>追加切片号（逗号分隔）</label><input data-addslice="'+sample.id+'" placeholder="SL-x-B"></div><button data-add="'+sample.id+'">追加切片到当前批次</button></div>' +
      '</article>';
  }).join("");
  bindSampleActions();
}
function batchCard(b) {
  return '<div class="slice"><b>'+esc(b.id)+'</b> '+shiftPill(b.shiftId)+
    '<span class="pill '+(b.status==="进行中"?"open":b.status==="待接管"?"warn":"")+'">'+esc(b.status)+'</span>' +
    '<span class="pill">机台 '+esc(b.machineId||"未分配")+'</span>' +
    '<div class="meta">参数 v'+b.paramsVersion+'：'+esc(b.params.angle)+' / '+esc(b.params.thickness)+' / '+esc(b.params.stainMethod)+(b.backfill ? ' · 按创建日期 '+esc(b.backfillDate)+' 补录' : '')+'</div>' +
    (b.deliveryConclusion ? '<div class="meta">交付：'+(b.deliveryConclusion.valid ? '<span class="pill open">有效</span>' : '<span class="pill bad">已失效</span>')+'</div>' : '') +
    b.slices.map(sl => sliceCard(b, sl)).join("") +
    '<div style="margin-top:6px">' +
      (b.status === "待接管"
        ? '<div class="row"><div style="flex:1"><label>接管机台</label><select data-tvm="'+b.id+'">'+state.machines.map(m=>'<option>'+esc(m.id)+'</option>').join("")+'</select></div><button data-takeover="'+b.id+'">登记接管并开台</button></div>'
        : '<button data-deliver="'+b.id+'">确认交付</button>') +
    '</div></div>';
}
function sliceCard(b, sl) {
  return '<div style="margin-top:6px"><b>'+esc(sl.id)+'</b> ' +
    (sl.done ? '<span class="pill open">完成</span>' : '<span class="pill warn">当前：'+esc(sl.currentStep)+'</span>') +
    '<div>'+sl.steps.map(st => '<span class="step '+st.state+'" title="'+esc(st.note||"")+'">'+esc(st.name)+(st.state==="completed"?" ✓":st.state==="invalid"?" ✗":"")+'</span>').join("")+'</div>' +
    (b.status === "进行中" && !sl.done ? '<div class="row" style="margin-top:4px"><div style="flex:2"><label>步骤备注 / 观察结果</label><input data-note="'+b.id+'|'+esc(sl.id)+'"></div><button data-step="'+b.id+'|'+esc(sl.id)+'">完成：'+esc(sl.currentStep)+'</button></div>' : '') +
    '</div>';
}
function bindSampleActions() {
  document.querySelectorAll("[data-step]").forEach(btn => btn.onclick = async () => {
    const [batchId, sliceId] = btn.dataset.step.split("|");
    const note = document.querySelector('[data-note="'+batchId+'|'+sliceId+'"]')?.value || "";
    const batches = state.batches; const batch = batches.find(x=>x.id===batchId);
    const slice = batch.slices.find(x=>x.id===sliceId);
    try { await api("/api/batches/"+batchId+"/steps", { method:"POST", body: JSON.stringify({ sliceId, step: slice.currentStep, note }) }); await load(); }
    catch(e){ toast(e.message, true); }
  });
  document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => {
    try { await api("/api/batches/"+btn.dataset.deliver+"/deliver", { method:"POST", body: JSON.stringify({ conclusion:"合格交付" }) }); await load(); }
    catch(e){ toast(e.message, true); }
  });
  document.querySelectorAll("[data-takeover]").forEach(btn => btn.onclick = async () => {
    const machineId = document.querySelector('[data-tvm="'+btn.dataset.takeover+'"]').value;
    try { const r = await api("/api/batches/"+btn.dataset.takeover+"/takeover", { method:"POST", body: JSON.stringify({ machineId, range:"UI 接管" }) }); toast("已接管 "+r.batch.id+"，交接单 "+r.handover.id); await load(); }
    catch(e){ toast(e.message, true); }
  });
  document.querySelectorAll("[data-params]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.params;
    const payload = {};
    const a = document.querySelector('[data-p-angle="'+id+'"]').value;
    const t = document.querySelector('[data-p-thick="'+id+'"]').value;
    const st = document.querySelector('[data-p-stain="'+id+'"]').value;
    if (a) payload.angle = a; if (t) payload.thickness = t; if (st) payload.stainMethod = st;
    if (!Object.keys(payload).length) return toast("请至少填一个要改的参数");
    try { const r = await api("/api/samples/"+id+"/params", { method:"POST", body: JSON.stringify(payload) }); toast(r.reason+"\\n失效："+JSON.stringify(r.invalidated.map(x=>x.sliceId+":"+x.steps.join("→")))); await load(); }
    catch(e){ toast(e.message, true); }
  });
  document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
    const sid = btn.dataset.add;
    const raw = document.querySelector('[data-addslice="'+sid+'"]').value.trim();
    if (!raw) return toast("先填切片号");
    const batch = batchOfSample(sid);
    const slices = raw.split(/[,，]/).map(x => x.trim()).filter(Boolean).map(id => ({ id }));
    try { await api("/api/batches/"+batch.id+"/slices", { method:"POST", body: JSON.stringify({ slices }) }); await load(); }
    catch(e){ toast(e.message, true); }
  });
  document.querySelectorAll("[data-apply]").forEach(btn => btn.onclick = async () => {
    try { await api("/api/conflicts/"+btn.dataset.apply+"/resolve", { method:"POST", body: JSON.stringify({ resolution:"apply" }) }); await load(); toast("冲突内容已应用"); }
    catch(e){ toast(e.message, true); }
  });
  document.querySelectorAll("[data-discard]").forEach(btn => btn.onclick = async () => {
    try { await api("/api/conflicts/"+btn.dataset.discard+"/resolve", { method:"POST", body: JSON.stringify({ resolution:"discard" }) }); await load(); }
    catch(e){ toast(e.message, true); }
  });
}
document.querySelector("#shiftSelect").onchange = (e) => { currentShift = e.target.value; localStorage.setItem("shift", currentShift); };
document.querySelector("#reload").onclick = load;
document.querySelector("#recover").onclick = async () => {
  const r = await api("/api/recovery", { method:"POST", body: JSON.stringify({}) });
  toast("已恢复到最后确认事件 #"+r.lastSeq+"，确认步骤 "+r.confirmedSteps.length+" 条；未重复生成切片/步骤");
  await load();
};
document.querySelector("#armFault").onclick = async () => {
  await api("/api/fault", { method:"POST", body: JSON.stringify({ target:"journal" }) });
  toast("已武装：下一次写盘会失败（用同一操作验证重试不重复）");
};
document.querySelector("#openShift").onclick = async () => {
  try {
    const s = await api("/api/shifts", { method:"POST", body: JSON.stringify({
      id: document.querySelector("#openShiftId").value.trim(), role: document.querySelector("#openRole").value, person: document.querySelector("#openPerson").value.trim()
    }) });
    currentShift = s.id; localStorage.setItem("shift", s.id);
    await load();
  } catch(e){ toast(e.message, true); }
};
document.querySelector("#registerHandover").onclick = async () => {
  const list = v => v.split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  try {
    await api("/api/handovers", { method:"POST", body: JSON.stringify({
      operatorShiftId: currentShift,
      fromShiftId: document.querySelector("#hvFrom").value.trim(),
      toShiftId: document.querySelector("#hvTo").value.trim(),
      range: document.querySelector("#hvRange").value.trim(),
      scope: { sampleIds: list(document.querySelector("#hvSamples").value), batchIds: list(document.querySelector("#hvBatches").value), machineIds: list(document.querySelector("#hvMachines").value) }
    }) });
    await load(); toast("交接已登记");
  } catch(e){ toast(e.message, true); }
};
document.querySelector("#createSample").onclick = async () => {
  try {
    const r = await api("/api/samples", { method:"POST", body: JSON.stringify({
      project: document.querySelector("#sProject").value, borehole: document.querySelector("#sBorehole").value,
      coreBox: document.querySelector("#sBox").value, depth: document.querySelector("#sDepth").value,
      owner: document.querySelector("#sOwner").value, machineId: document.querySelector("#sMachine").value,
      angle: document.querySelector("#sAngle").value, thickness: document.querySelector("#sThickness").value,
      stainMethod: document.querySelector("#sStain").value, sliceId: document.querySelector("#sSlice").value
    }) });
    toast("样本 "+r.sample.id+" 已创建，批次 "+r.batch.id);
    await load();
  } catch(e){ toast(e.status === 409 ? e.message+"（已进入冲突区）" : e.message, e.status >= 500); }
};
load();
</script>
</body>
</html>`;
}
