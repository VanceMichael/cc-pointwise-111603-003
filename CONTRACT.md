# 来源与消费契约

## 来源

入口 `/requests`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

本地 requests 为前台待办导入来源；门户为独立状态。GET /portal 建立 cookie 会话并返回 draft 表单。POST /portal/draft 提交 csrf/reference/name/slot，200 仅为补充资料页；POST /portal/confirm 还需 documentType（passport 或 identity-card），201 才有 receipt。GET /portal/bookings?reference=... 查询门户事实；POST /portal/cancel 使用 csrf/receipt。会话过期返回 403，时段满返回 409。source/portal.js 可独立启动，loseNextReceipt 在写入成功后断开响应，loseNextCancel/loseNextBookings 分别在撤销写入后、查询时断开，expireSessions 使会话失效。写请求断连时门户可能已落单，调用方必须先以 reference 查询门户事实再决定下一步，不得凭本地无响应直接重约。

## 业务消费

`readOperations(repository, workflowRepository?)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes；提供工作流仓库时附加 workflow（step/stepLabel/missing/note/updatedAt）与 booking（receipt/status/slot/revision，仅在取得门户回执后出现）。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明；只有门户 201 回执或经门户核实的记录才构成已预约证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

工作流持久化在独立文件，条目以访客业务标识 reference 为键，步骤取值：pending、waiting-materials、awaiting-confirm、confirm-unknown、slot-full、booked、cancelling、cancelling-unknown、cancelled、failed。每次状态迁移原子写入；重启后新实例从该文件恢复并继续，留待处理（waiting-materials/slot-full）与终态（booked/cancelled）不会被自动跳过，补齐资料或人工改期后才重新进入可推进集合。
