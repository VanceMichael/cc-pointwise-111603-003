# 访客预约登记台

Node.js 本地数据接入与门户自动化项目。来源服务、业务存储与门户为独立状态：来源变化不会自动刷新本地集合，门户事实以业务标识（reference）核实。本地导入以 sourceId 保存最新观察；门户自动化把每位访客停在分步表单的哪一步持久化到独立工作流文件，重启任务后可完整说明交接状态。

## 运行

需要 Node.js 22，无第三方包、远程服务或账户凭据。`npm test` 运行全部行为与本地接口测试；`npm run demo` 演示既有来源读取与业务查询；`npm run portal-demo` 演示门户多步表单、断连核实、重启恢复与撤销对齐，通常两秒内完成。`npm run acceptance` 在临时目录验证完整生命周期，结束自动清理。演示数据不访问生产站点。

## 命令

`npm start` 或 `npm start -- --help` 查看命令。

- `ingest [文件]`：从 JSON 文件导入待办到 `var/records.json`（默认 `fixtures/records.json`）。
- `query [来源]`：读取本地业务集合。
- `automate [门户地址]`：以本地待办同步工作流并跑一轮门户自动化。门户地址也可用 `PORTAL_URL` 提供，仅允许 127.0.0.1 回环来源，默认 `http://127.0.0.1:8080`。
- `status`：离线查看每位访客的工作流步骤、缺失资料与回执。
- `rearm <访客业务标识>`：人工处理完留待事项后把条目重新排入队列；已预约、已撤销等终态拒绝重置。
- `cancel <访客业务标识> [门户地址]`：先核实门户记录再撤销，状态与门户对齐。

## 门户自动化规则

门户把原本一次提交拆成草稿页（reference/name/slot）与证件类型确认页（documentType）。自动化按页面识别所需资料：

1. **资料不足不发请求**：草稿页缺 reference/name/slot 任一项，或确认页要求而本地没有合规证件类型（passport/identity-card），条目进入 `waiting-materials` 留待处理，并记录缺哪些字段；补齐资料后下一次 `automate` 自动重新排入队列。
2. **拿到回执才算已预约**：只有门户 201 返回（或经门户核实存在）的预约编号与回执落库后，业务读取才显示“已预约”和 booking 信息。
3. **时段冲突留待**：门户 409 容量变化映射为 `slot-full`，不自动反复撞容量；来源观察里的 slot 改期后自动重新排入，容量释放等场景可用 `rearm` 手动排入。
4. **断连先核实，绝不重复预约**：确认提交是写请求，连接在响应前中断时结果未知，条目进入 `confirm-unknown`，随后用 reference 调 `GET /portal/bookings` 核实——已落单则采纳门户回执，确认门户无记录才允许重新提交。
5. **撤销与门户状态对上**：撤销前先查门户事实；撤销响应丢失进入 `cancelling-unknown`，重启后凭门户事实判定撤销是否生效；重复撤销幂等，门户无记录时不假装成功。
6. **会话失效可恢复**：门户 403 后自动新建会话；草稿绑定会话，重启后从第一步安全重放。所有步骤原子写入 `var/workflow.json`，`status` 与业务读取随时可说明每位访客停在哪一步。

## 组件和数据

`source/server.js` 读取 `fixtures/source.json` 并监听随机回环端口，`startSource()` 返回 url、publish(stage)、failNext(path,status) 和 close()。`source/portal.js` 是独立门户模拟，`startPortal()` 另支持 capacity/requireDocument 选项与 loseNextReceipt/loseNextCancel/loseNextBookings/expireSessions 故障钩子。`src/source-client.js` 只接受同一回环来源；`src/adapter.js` 解析来源页面；`src/portal-client.js` 封装门户会话、CSRF、两步表单与类型化错误（SessionExpiredError、SlotFullError、MissingMaterialError、AmbiguousOutcome）。`src/workflow.js` 定义可恢复步骤与资料规则；`src/automation.js` 是编排状态机；`src/repository.js` 与 `src/booking-repository.js` 分别持久化业务集合与工作流状态；`src/operations.js` 在保留原行结构的同时附加门户工作流与回执。来源协议见 [CONTRACT.md](CONTRACT.md)。

状态目录 `var/` 属于运行产物。测试可直接使用随机端口来源与门户，不需要等待真实时间或接入外网。
