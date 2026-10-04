# 岩芯样本切片实验室 · 班次账

把**样本、切片批次、制片步骤、交付台账**接成班次账。所有写操作都必须挂在一张**班次单**下，按交接人与覆盖范围授权，并通过操作日志（journal）保证写盘失败可恢复、重试不重复。

运行：

```bash
npm start
```

访问 `http://localhost:3025`。

## 班次账机制

| 机制 | 说明 |
| --- | --- |
| 先到者开工，后到内容留冲突 | 同一台切片机（`M-01/M-02/M-03`）同一时刻只能有一张进行中的班次单；后到的开班/接管请求不开工，内容写入 `conflicts`，先到班次单继续有效。 |
| 参数变更失效重算 | 切割角度、厚度或染色方法一改：**未完成切片**置 `needsRecalc`、状态回退重算；**步骤顺序**置 `sequenceInvalid`，下一步必须按已完成步骤推导，顺序不符直接拒绝；**交付结论**回退并把交付台账置为失效。**已完成步骤**保留在日志中，可追溯。 |
| 写盘失败恢复 | 每次写操作先写 journal（`pending`）再落盘；落盘失败则回滚内存到上一确认点、journal 记 `failed`。`POST /api/recover` 把残留 `pending/failed` 置 `rolled_back`，恢复到最后确认步骤。 |
| 幂等重试 | 每次写操作带 `idemKey`。同 `idemKey` 的重试直接返回已确认结果，不重复生成切片或步骤。 |
| 跨班接管授权 | 开班/接管登记 `handoverFrom`（交出人）、`handoverTo`（接管人）与覆盖范围（`scope`：样本/切片/步骤）。操作人必须是该班次单的接管人，且目标在覆盖范围内，否则直接 `403`；待接管班次单不能开工（`409`）。 |
| 老样本补待接管批次 | 启动时自动把没有班次单的老样本按创建日期补成 `待接管` 批次（`backfill`），接管后才能开工。 |

## 数据模型

- `samples`：样本，含 `machineId/angle/thickness/method/delivery/sequenceInvalid/deliveryRecalc`。
- `shiftOrders`：班次单，含 `machineId/shift/handoverFrom/handoverTo/scope/status/priorShiftOrderId`。状态：`待接管 → 进行中 → 已确认`。
- `batches`：切片批次，挂在班次单下。
- `conflicts`：后到内容留冲突，记录先到班次单。
- `journal`：操作日志，含 `idemKey/type/payload/status/attempts/result`。状态：`pending → confirmed`，失败为 `failed/rolled_back`。
- `deliveryLedger`：交付台账，参数变更会把有效台账置为失效。
- `paramChanges`：参数变更审计。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/samples` | 样本列表 |
| POST | `/api/samples` | 创建样本（需班次单） |
| POST | `/api/samples/:id/slices` | 新增切片（需班次单） |
| POST | `/api/samples/:id/slices/:sid/logs` | 记录制片步骤（需班次单，步骤顺序失效重算） |
| POST | `/api/samples/:id/params` | 变更角度/厚度/染色（失效重算） |
| POST | `/api/samples/:id/deliver` | 标记交付（写交付台账） |
| GET | `/api/shift-orders` | 班次单列表 |
| POST | `/api/shift-orders/start` | 开班 / 跨班接管（先到先得，后到留冲突） |
| POST | `/api/shift-orders/confirm` | 确认班次单（收尾） |
| GET | `/api/conflicts` | 冲突列表 |
| GET | `/api/batches` | 切片批次列表 |
| GET | `/api/delivery-ledger` | 交付台账 |
| GET | `/api/journal` | 操作日志 |
| POST | `/api/backfill` | 补待接管批次 |
| POST | `/api/recover` | 按班次单恢复到最后确认步骤 |
| POST | `/api/admin/fail-writes` | 演练：开关写盘失败 |

所有写操作请求体需带 `shiftOrderId`、`operator`（接管人）和 `idemKey`（幂等键）。

## 测试

```bash
node test-ledger.js
```

覆盖：回填、先到先得冲突、越权/超范围拒绝、参数失效重算、写盘失败恢复与幂等重试、跨班接管登记，共 39 项断言。
