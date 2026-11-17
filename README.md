# 访客预约登记台

Node.js 本地数据接入与门户自动化项目。来源服务、门户与业务存储相互独立：来源变化不会自动刷新本地集合，门户状态以业务标识（reference）为唯一核实依据。本地先完成一次来源读取与结构化导入，再由门户自动化按两步表单（草稿页 → 证件类型确认页）完成预约，并把每位访客停在哪一步持久化到本地状态库，进程重启或会话失效后可续跑、可复述。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行全部行为与本地接口测试；`npm run demo` 启动临时来源与临时门户、读取首批并展示带门户步骤的业务查询，结束时自动关闭监听并清理临时数据，通常两秒内完成。`npm start -- ingest` 从 `fixtures/records.json` 导入，`npm start -- query` 读取本地 `var/records.json`。演示数据不访问生产站点。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口。`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()；publish 切换可观察来源版本而不修改业务仓库，failNext 可返回 503 或使用 disconnect 断开连接。`source/portal.js` 是独立的两步表单门户，`startPortal()` 返回 url、requests、loseNextReceipt()（回执写入成功后断开响应）、expireSessions()（会话失效）和 close()。

`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析首批页面并保留原始来源属性。`src/service.js` 与 `src/repository.js` 维护持久的待办集合。

门户自动化部分：

- `src/portal-client.js`：回环门户的 cookie/CSRF 会话客户端。`openSession()` 解析首页表单并报告所需字段，`submitDraft()` 提交第一步并返回证件确认页描述（是否需要 documentType、必填字段），`confirm()` 取得 201 回执，`lookup(reference)` 以业务标识查询门户事实，`cancel(receipt)` 撤销。明确区分 `PortalSessionExpired`（403）、`PortalHttpError`（409 时段满、422 资料不足等）与 `PortalConnectionLost`（连接中断）。
- `src/booking-state.js` 与 `var/bookings.json`：按 reference 持久化每位访客的步骤（imported / needs-material / draft-submitted / recovering / booked / slot-conflict / cancelling / cancelled / failed）、回执、门户版本与最近 20 条事件，原子写入。
- `src/booking-automation.js`：可恢复的状态机。提交前先以 reference 核实门户，已有预约只同步回执、绝不重复提交；资料不足或时段冲突的项目留待处理（冲突后只有时段/证件资料被修改才重试）；确认后若连接中断，状态停在 recovering，下次运行只做门户核实，查到记录才补登回执；撤销同样先核对门户事实，断线则停在 cancelling 续做。会话 403 时自动新建会话并重做当前步骤。
- `src/operations.js`：业务读取入口在原有 rows 上附带 `booking`（步骤、中文步骤说明、回执、详情），前台据此判断哪些真正已预约。

## 命令

`npm start` 或 `npm start -- --help` 查看全部命令：

- `ingest [文件]`：结构化导入待办到 `var/records.json`。
- `query [来源]`：查询本地待办集合。
- `portal-sync [门户URL]`：对全部待办跑一遍门户自动化；首次需传入门户 URL，之后 URL 会记录在状态库。
- `portal-status`：输出每位访客当前步骤、回执与事件轨迹。
- `portal-cancel <业务标识> [门户URL]`：与门户核对后撤销指定访客的预约。

状态目录 `var/` 属于运行产物。扩展导入时保留现有 CLI 与集合查询能力；新增状态独立组织于 `var/bookings.json`。测试直接使用随机端口的来源与门户，不需要等待真实时间或接入外网。`npm run acceptance` 在临时目录中验证本地来源读取、首批导入、重启回读、重放、业务查询，以及门户的资料留待、时段冲突、回执断线恢复、会话失效续跑与撤销对齐，完成后清理临时状态。
