# 来源与消费契约

## 来源

入口 `/requests`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

本地 requests 为前台待办导入来源；门户为独立状态。GET /portal 建立 cookie 会话并返回 draft 表单。POST /portal/draft 提交 csrf/reference/name/slot，200 仅为补充资料页；POST /portal/confirm 还需 documentType（passport 或 identity-card），201 才有 receipt。GET /portal/bookings?reference=... 查询门户事实；POST /portal/cancel 使用 csrf/receipt。会话过期返回 403，时段满返回 409。source/portal.js 可独立启动，loseNextReceipt 在写入成功后断开响应，expireSessions 使会话失效。

## 业务消费

`readOperations(repository)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes。现有 CLI 和结构化导入用于本地运维；新增采集结果也需要让业务读取入口看到一致状态，必要的解释信息可扩展返回。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。
