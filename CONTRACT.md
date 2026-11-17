# 来源与消费契约

## 来源

入口 `/requests`，JSON items 为本页项目，next 是后续相对路径或 null。`fixtures/source.json` 的 opening 与 updated 是两个可切换的来源观察，不代表业务库必须得出某个预设结论；可添加新的来源观察验证行为。

本地 requests 为前台待办导入来源；门户为独立状态。GET /portal 建立 cookie 会话并返回 draft 表单。POST /portal/draft 提交 csrf/reference/name/slot，200 仅为补充资料页；POST /portal/confirm 还需 documentType（passport 或 identity-card），201 才有 receipt。GET /portal/bookings?reference=... 查询门户事实；POST /portal/cancel 使用 csrf/receipt。会话过期返回 403，时段满返回 409。source/portal.js 可独立启动，loseNextReceipt 在写入成功后断开响应，expireSessions 使会话失效。

## 业务消费

`readOperations(recordRepository, bookingRepository?)` 当前返回 product 和 rows，每行带 sourceId/source/observedAt/attributes；提供预约状态库时额外附带 `booking`（step、stepLabel、receipt、detail、updatedAt）。现有 CLI 和结构化导入用于本地运维；门户自动化结果通过同一业务读取入口呈现一致状态。原始来源身份与 observedAt 不是通用的业务版本、完整性或成功证明；只有门户 201 回执（或经 reference 核实到的门户记录）才是已预约的依据，本地未收到响应不构成失败或成功结论。来源接口契约是兼容边界，采集、状态管理和新业务表达由实现决定。

## 门户自动化状态约定

每位访客以来源 `reference` 作为持久化身份，步骤语义如下：`imported`（已导入待登记）、`needs-material`（资料不足，缺 reference/name/slot/documentType 之一，留待补充）、`draft-submitted`（第一步草稿已提交，停在证件确认页）、`recovering`（确认后连接中断，本地无回执，下次运行只核实不重约）、`booked`（门户已确认并持有回执）、`slot-conflict`（门户 409，时段满，资料未调整前不重试）、`cancelling`（撤销请求结果未知，待门户核实）、`cancelled`（门户已撤销或核实无预约）、`failed`（需人工介入）。任何提交前都先 `GET /portal/bookings?reference=...` 核实；会话 403 自动重建会话，状态库保证重启后续跑同一访客时能说明其停留步骤。
