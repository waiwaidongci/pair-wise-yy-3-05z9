// 班次账机制验证：回填、先到先得冲突、越权拒绝、参数失效重算、写盘失败恢复、幂等重试。
import { ShiftLedger, STEPS } from "./shift-ledger.js";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    console.log("  ✗", name, extra);
  }
}
// commit 结果取内层 result
const val = (x) => (x && x.result ? x.result : x);

function makeDb() {
  return {
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
}

// 内存 save + 可注入失败。只记录序列化结果，不替换内存对象（与真实写盘一致，保持引用一致）。
let saved;
function makeSave(db, failNext = { count: 0 }) {
  return async (next) => {
    if (failNext.count > 0) {
      failNext.count--;
      throw new Error("disk_full");
    }
    saved = JSON.parse(JSON.stringify(next));
  };
}

async function main() {
  // 1. 回填：老样本按创建日期补成待接管批次
  {
    console.log("\n[1] 回填老样本为待接管批次");
    const db = makeDb();
    const save = makeSave(db);
    const ledger = new ShiftLedger(db, { save });
    const r = val(await ledger.backfill());
    check("回填 1 个老样本", r.uncovered === 1, JSON.stringify(r.uncovered));
    check("生成 1 个待接管班次单", r.created.length === 1);
    const so = r.created[0].shiftOrder;
    check("班次单状态为待接管", so.status === "待接管");
    check("覆盖该老样本", so.scope.sampleIds.includes("CORE-001"));
    check("覆盖其切片", so.scope.sliceIds.includes("SL-001-A"));
    check("样本已挂班次单", db.samples[0].shiftOrderId === so.id);
    const r2 = val(await ledger.backfill());
    check("重复回填无新增", r2.uncovered === 0 && r2.created.length === 0);
  }

  // 2. 先到者开工，后到内容留冲突
  {
    console.log("\n[2] 切片机先到先得 + 冲突");
    const db = makeDb();
    const save = makeSave(db);
    const ledger = new ShiftLedger(db, { save });
    await ledger.backfill();
    const first = val(await ledger.startShift({ machineId: "M-01", shift: "白班", handoverFrom: "陆川", handoverTo: "王芳", scope: { sampleIds: ["CORE-001"] } }));
    check("先到开班成功", !first.machineBusy && first.shiftOrder.status === "进行中");
    const second = val(await ledger.startShift({ machineId: "M-01", shift: "夜班", handoverFrom: "王芳", handoverTo: "李强" }));
    check("后到内容留冲突", second.machineBusy && second.conflict.status === "open");
    check("冲突记录先到班次单", second.conflict.winningShiftOrderId === first.shiftOrder.id);
    check("后到未生成进行中班次单", db.shiftOrders.filter((s) => s.machineId === "M-01" && s.status === "进行中").length === 1);
  }

  // 3. 越权修改直接拒绝
  {
    console.log("\n[3] 越权 / 超范围拒绝");
    const db = makeDb();
    const save = makeSave(db);
    const ledger = new ShiftLedger(db, { save });
    await ledger.backfill();
    const so = val(await ledger.startShift({ machineId: "M-01", shift: "白班", handoverFrom: "陆川", handoverTo: "王芳", scope: { sampleIds: ["CORE-001"], sliceIds: ["SL-001-A"] } })).shiftOrder;
    let denied = false;
    try {
      await ledger.logStep({ shiftOrderId: so.id, operator: "冒名", sampleId: "CORE-001", sliceId: "SL-001-A", step: "研磨", idemKey: "a" });
    } catch (e) { denied = e.status === 403; }
    check("非接管人拒绝(403)", denied);
    // 构造一个待接管班次单，验证未接管不能开工
    db.shiftOrders.push({ id: "SHIFT-PENDING", machineId: "M-02", shift: "待接管", handoverFrom: "", handoverTo: "", scope: { sampleIds: ["CORE-001"], sliceIds: ["SL-001-A"], steps: [...STEPS] }, status: "待接管", backfill: true, createdAt: new Date().toISOString(), takenOverAt: null, confirmedAt: null });
    denied = false;
    try {
      await ledger.logStep({ shiftOrderId: "SHIFT-PENDING", operator: "谁", sampleId: "CORE-001", sliceId: "SL-001-A", step: "研磨", idemKey: "b" });
    } catch (e) { denied = e.status === 409; }
    check("待接管班次单拒绝(409)", denied);
    denied = false;
    try {
      await ledger.createSample({ shiftOrderId: so.id, operator: "王芳", project: "外项目", borehole: "X", coreBox: "Y", depth: "Z", owner: "王", method: "染色", sliceId: "SL-X", machineId: "M-02", idemKey: "c" });
    } catch (e) { denied = e.status === 403; }
    check("超范围样本拒绝(403)", denied);
  }

  // 4. 参数变更：未完成失效重算，已完成可追溯，交付结论失效
  {
    console.log("\n[4] 参数变更失效重算");
    const db = makeDb();
    const save = makeSave(db);
    const ledger = new ShiftLedger(db, { save });
    await ledger.backfill();
    const so = val(await ledger.startShift({ machineId: "M-01", shift: "白班", handoverFrom: "陆川", handoverTo: "王芳", scope: { sampleIds: ["CORE-001"], sliceIds: ["SL-001-A"] } })).shiftOrder;
    await ledger.deliver({ shiftOrderId: so.id, operator: "王芳", sampleId: "CORE-001", conclusion: "合格", idemKey: "d1" });
    check("已交付", db.samples[0].delivery === "已交付");
    const r = val(await ledger.changeParams({ shiftOrderId: so.id, operator: "王芳", sampleId: "CORE-001", method: "混合染色", idemKey: "p1" }));
    check("未完成切片被置失效重算", r.affectedSlices.includes("SL-001-A"));
    const slice = db.samples[0].slices[0];
    check("切片标记 needsRecalc", slice.needsRecalc === true);
    check("已完成步骤日志仍可追溯(取样+切割)", slice.logs.filter((l) => l.step === "取样" || l.step === "切割").length === 2);
    check("步骤顺序失效", db.samples[0].sequenceInvalid === true);
    check("交付结论失效回退", db.samples[0].delivery === "未交付" && db.samples[0].deliveryRecalc === true);
    check("交付台账置失效", db.deliveryLedger[0].status === "失效");
    let seqDenied = false;
    try {
      await ledger.logStep({ shiftOrderId: so.id, operator: "王芳", sampleId: "CORE-001", sliceId: "SL-001-A", step: "染色", idemKey: "s1" });
    } catch (e) { seqDenied = e.status === 409 && e.error === "sequence_recalc_mismatch"; }
    check("重算顺序错误拒绝并给出期望步骤", seqDenied);
    const ok = val(await ledger.logStep({ shiftOrderId: so.id, operator: "王芳", sampleId: "CORE-001", sliceId: "SL-001-A", step: "研磨", note: "重算后继续研磨", idemKey: "s2" }));
    check("重算后首步可记录且清除失效标记", ok.slice.needsRecalc === false && ok.slice.status === "研磨");
  }

  // 5. 写盘失败恢复 + 幂等重试不重复
  {
    console.log("\n[5] 写盘失败恢复与幂等重试");
    const db = makeDb();
    const failNext = { count: 0 };
    const save = makeSave(db, failNext);
    const ledger = new ShiftLedger(db, { save });
    await ledger.backfill();
    const so = val(await ledger.startShift({ machineId: "M-01", shift: "白班", handoverFrom: "陆川", handoverTo: "王芳", scope: { sampleIds: ["CORE-001"], sliceIds: ["SL-001-A"] } })).shiftOrder;
    failNext.count = 1; // 从下一步开始注入一次写盘失败
    const before = db.samples[0].slices[0].logs.length;
    let failed = false;
    try {
      await ledger.logStep({ shiftOrderId: so.id, operator: "王芳", sampleId: "CORE-001", sliceId: "SL-001-A", step: "研磨", note: "第一次", idemKey: "retry-1" });
    } catch (e) { failed = e.error === "write_failed_recovered"; }
    check("写盘失败抛出 recovered", failed);
    check("失败后内存已回滚（日志未增加）", db.samples[0].slices[0].logs.length === before);
    check("日志记为 failed", db.journal.find((j) => j.idemKey === "retry-1").status === "failed");
    const retry = val(await ledger.logStep({ shiftOrderId: so.id, operator: "王芳", sampleId: "CORE-001", sliceId: "SL-001-A", step: "研磨", note: "第一次", idemKey: "retry-1" }));
    check("重试成功", retry.slice.status === "研磨");
    check("重试未重复生成步骤（日志只多一条）", db.samples[0].slices[0].logs.length === before + 1);
    check("原 failed 记录保留，新记录 confirmed", db.journal.filter((j) => j.idemKey === "retry-1").length === 2);
    const rec = val(await ledger.recover());
    check("恢复处理残留", rec.rolledBack.length >= 1);
  }

  // 6. 跨班接管登记上一班
  {
    console.log("\n[6] 跨班接管登记");
    const db = makeDb();
    const save = makeSave(db);
    const ledger = new ShiftLedger(db, { save });
    await ledger.backfill();
    const s1 = val(await ledger.startShift({ machineId: "M-01", shift: "白班", handoverFrom: "陆川", handoverTo: "王芳", scope: { sampleIds: ["CORE-001"] } })).shiftOrder;
    await ledger.confirmShift({ shiftOrderId: s1.id, operator: "王芳", idemKey: "cf1" });
    check("白班已确认", s1.status === "已确认");
    const s2 = val(await ledger.startShift({ machineId: "M-01", shift: "夜班", handoverFrom: "王芳", handoverTo: "李强", priorShiftOrderId: s1.id, scope: { sampleIds: ["CORE-001"] } })).shiftOrder;
    check("夜班登记上一班次单", s2.priorShiftOrderId === s1.id);
    check("夜班可接管开工", s2.status === "进行中");
  }

  // 7. 接管待接管（回填）批次：登记交接人后转为进行中
  {
    console.log("\n[7] 接管待接管批次");
    const db = makeDb();
    const save = makeSave(db);
    const ledger = new ShiftLedger(db, { save });
    await ledger.backfill();
    const pendingBefore = db.shiftOrders.find((s) => s.status === "待接管" && s.backfill);
    check("存在待接管回填班次单", !!pendingBefore && pendingBefore.handoverTo === "");
    const r = val(await ledger.startShift({ machineId: "M-01", shift: "白班", handoverFrom: "陆川", handoverTo: "王芳", scope: { sampleIds: ["CORE-001"] } }));
    check("接管而非新开", r.tookOver === true && r.shiftOrder.id === pendingBefore.id);
    check("交接人已登记", r.shiftOrder.handoverFrom === "陆川" && r.shiftOrder.handoverTo === "王芳");
    check("状态转为进行中", r.shiftOrder.status === "进行中" && r.shiftOrder.takenOverAt);
    check("批次同步转为进行中", db.batches.find((b) => b.id === r.shiftOrder.batchId).status === "进行中");
    check("待接管班次单已消失", !db.shiftOrders.some((s) => s.status === "待接管" && s.backfill));
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
