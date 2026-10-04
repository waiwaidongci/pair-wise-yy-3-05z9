# 岩芯库班次账（样本 · 切片批次 · 制片步骤 · 交付台账）

把样本、切片批次、制片步骤和交付台账接到同一张"班次账"上，解决换班后切片工/观察员
同时改动互相推翻的问题。无第三方依赖，纯 Node.js。

## 运行

```bash
npm start          # http://localhost:3025
npm test           # 11 个端到端规则测试（临时数据目录 + 真实 HTTP）
```

首次启动会把旧的 `data/core-slices.json` 按**最早步骤日志的创建日期**补成"待接管"批次
（批次号 `BF-YYYY-MM-DD-样本号`），原文件归档为 `core-slices.imported-*.json`，之后以
`data/journal.log`（append-only 事件账）+ `data/snapshot.json`（快照，tmp+rename 原子写）运行。

## 业务规则如何落地

1. **同一台切片机先到者开工，后到内容留冲突。** 每个写操作串行处理并带到达时间；机台
   （`CUT-01/02`）被别的开放班次占用时，后到请求不覆盖任何数据，返回 `409 machine_busy`
   并在冲突区留一条完整记录（提交班次、动作、载荷、占用方）。机台空出后可在冲突区
   "应用"（原载荷重放）或"作废"。观察员记步骤、改参数、交付不占机台；追加切片等机台动作
   才竞争机台。

2. **切割角度、厚度或染色方法一改，未完成切片、步骤顺序和交付结论失效重算；已完成步骤仍可追溯。**
   `POST /api/samples/:id/params` 产生 `PARAMS_CHANGED` 事件：
   - 未完成切片：已完成步骤保留（改染色时，已完成的"染色"步也打回，切割前的步骤保留），
     其余步骤标记 `invalid`（附失效原因与时间）并按标准顺序重建 `pending`，步骤顺序即重算结果；
   - 已全部完成的切片保持原样，可追溯；
   - 已交付批次的台账结论置为无效（`LEDGER_VOIDED`，留原因），批次回到"已完成"，可重新交付。

3. **写盘失败按班次单恢复到最后确认步骤，重试不重复生成切片或步骤。** 事件先追加
   journal（并 fsync）才算"已确认"，然后才 fold 进内存、写 snapshot。journal 失败 =
   未确认（内存不动，返回 `503 write_unconfirmed`）；snapshot 失败不影响已确认数据
   （响应带 `X-Recovery-Pending: 1`）。所有变更建议带 `Idempotency-Key`，回执也进 journal，
   重启后同键直接回放旧结果。`POST /api/recovery` 从 journal 重放到最后确认事件并重写快照，
   不执行新命令，因此不会重复生成切片/步骤；`GET /api/recovery` 按班次单汇总每片的最后确认步骤。
   步骤接口强制顺序（跳步 `step_order_violation`、重复完成 `step_already_completed`）。
   页面"模拟下一次写盘失败"按钮（或 `POST /api/fault`）可演练该流程。

4. **跨班接管登记交接人和覆盖范围，越权直接拒绝。** 除开班外的写操作必须带班次单
   （`X-Shift-Id`）。`POST /api/handovers` 登记交出班次、接管班次、覆盖范围（样本/批次/机台），
   立即生效；不在自有范围、也没有覆盖该样本/批次的有效交接单时，直接 `403 out_of_scope`
   （注意与机台竞争 `409` 区分：越权不留冲突，竞争才留冲突）。机台动作还要求交接范围包含该机台。
   老批次接管 `POST /api/batches/:id/takeover` 会自动生成 `legacy → 当前班` 的交接单并占机台。

5. **没有班次单的老样本按创建日期补成待接管批次。** 见首次启动迁移；也可对运行期新出现的
   无批次样本调用 `POST /api/samples/backfill`。待接管批次在接管前拒绝任何步骤/追加/交付操作。

## API 速览

| 方法 路径 | 说明 |
| --- | --- |
| `POST /api/shifts` / `POST /api/shifts/:id/close` | 开班（班次号、角色、姓名）/ 收班（释放机台） |
| `POST /api/samples` | 建样本并提交首个切片批次（`machineId` + `sliceId` + 角度/厚度/染色），先到占机 |
| `POST /api/samples/:id/batches` | 对样本新开切片批次（上一批次须已结束） |
| `POST /api/samples/:id/params` | 改角度/厚度/染色 → 失效重算 |
| `POST /api/samples/backfill` | 老样本补待接管批次 |
| `POST /api/batches/:id/slices` | 追加切片（机台动作，竞争+授权） |
| `POST /api/batches/:id/steps` | 按顺序记录制片步骤（`sliceId`、`step`、`note`） |
| `POST /api/batches/:id/deliver` | 全部切片完成后写入交付台账 |
| `POST /api/batches/:id/takeover` | 接管待接管批次（自动交接登记 + 占机） |
| `POST /api/handovers` | 跨班交接：`fromShiftId/toShiftId/scope{sampleIds,batchIds,machineIds}` |
| `GET/POST /api/conflicts`、`POST /api/conflicts/:id/resolve` | 冲突区与处置（`apply`/`discard`） |
| `GET /api/ledger`、`GET /api/state`、`GET/POST /api/recovery` | 台账 / 全量视图 / 恢复 |

代码分层：`src/domain.js`（纯领域：命令→事件、fold、失效重算、授权）、`src/store.js`
（journal/snapshot、串行化、幂等、故障注入）、`src/page.js`（零依赖控制台页面）、
`server.js`（HTTP 路由与老库迁移）、`test/shift-ledger.test.js`（规则测试）。
