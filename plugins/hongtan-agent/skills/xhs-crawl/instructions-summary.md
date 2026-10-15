# 红探 Agent —— server instructions（SKILL 不支持时的兜底摘要）

（本文件经 MCP `initialize` 的 `instructions` 下发；宿主支持 skills 时以 `SKILL.md` 为准。）

红探（hongtan）是小红书评论采集插件。当用户请求实质涉及「采集/抓取小红书评论」「找客户数据」时，使用红探工具：

1. 先调 `xhs_connection_status` 确认链路（扩展是否连接、Agent 开关、设备是否已批准、是否 VIP、`quota` 显示新任务何时可启动）。未就绪时按返回的 `onboarding` 指引用户，不要重试。引导按三步走：① 打开浏览器并开启插件「Agent 接管」开关；② 在设备管理中核对指纹并批准；③ VIP 会员态。每步等用户回话后再复查。
2. 启动前必须向用户复述「目标关键词/页面、数据集名、数量上限」并获确认；同时告知会打开一个独立抓取窗口，且采集期间需保持该窗口前台激活、勿遮挡或最小化。
3. `xhs_start_crawl` 立即返回 `taskId`，不会等待完成。启动浏览器约需 10-60 秒，期间应说「正在启动浏览器，请稍候」。
4. 监控用 `xhs_wait_for_task`（单次上限 300 秒）或 `xhs_task_status`；轮询间隔不得少于 10 秒，禁止紧密轮询。若 `xhs_task_status` 返回 `orphaned: true`（在跑任务超过 60 秒无新消息），说明上报暂时失联、插件正在自愈：如实转述「任务暂时失联，插件会自动恢复」，不要宣告失败、不要重试、不要另起任务，按 10 秒以上间隔继续复查。
5. 任务的存续不依赖你是否在线：中断由插件自动恢复。不要因一次失败或断连就宣告失败。
6. 任务暂停在 `blocked_by_risk`（风控/验证码，必须人工）或 `stalled_by_background`（窗口被遮挡）时：提示用户处理后，**在用户确认已处理完**之后，带 `resumeTaskId = <taskId>` 再调一次 `xhs_start_crawl` 续跑（不要重传 keyword/noteUrl）；续跑不占配额，会在原抓取窗口按剩余额度继续。

错误码处理（详见 SKILL）：
- `BROWSER_OFFLINE`、`EXTENSION_OFFLINE`、`STALLED_BY_BACKGROUND`：不得重试，也不得宣告失败；分别说明「浏览器正在启动」「扩展暂时休眠，稍后恢复」「页面被遮挡任务已暂停，勿遮挡抓取窗口（解除后自动恢复）」。
- `BLOCKED_BY_RISK`：必须人工——提示用户在浏览器完成验证后主动告知继续；禁止自动重试。
- `VIP_REQUIRED`：如实说明 AI 联动为 VIP 功能并引导开通/登录；不重试。
- `AGENT_DISABLED`、`DEVICE_NOT_APPROVED`：引导用户在插件设置中开启开关 / 核对指纹并批准；不重试。
- `LOGIN_WALL`、`NOT_LOGGED_IN`：提示用户登录小红书后重试。
- `EXTENSION_UNAVAILABLE`：说明扩展可能未安装/被禁用，提示检查 `chrome://extensions`。
- `PROTOCOL_VERSION_MISMATCH`：提示升级插件或 Agent 运行时。
- `TASK_BUSY`：改用 `xhs_task_status` 查询现有任务，勿盲目启动。
- `QUOTA_EXCEEDED`：说明配额冷却中（按上次任务请求量折算），消息里会给可重试时刻；不要连续启动。
- `DATASET_QUOTA_EXCEEDED`：说明可能只入库部分（终态记为 `partial`），建议换数据集。
- `RESUME_EXHAUSTED`：说明任务反复中断，建议人工检查浏览器。
- `RESUME_NOT_APPLICABLE`：该任务不是 `blocked_by_risk` / `stalled_by_background`，不能续跑；先查状态再按指引处理。
- `CONTENT_NOT_READY`：说明页面类型可能不符；最多重试一次。
- `URL_NOT_MATCHED`：说明该 URL 不支持（仅搜索结果页 / 笔记详情页 / 用户主页）。
- `TAB_UNAVAILABLE`：插件会自动恢复；达上限会返回 `RESUME_EXHAUSTED`。
- `CANCEL_TIMEOUT` / `CANCEL_REJECTED`：说明抓取可能仍在进行，稍后复查。
- `RATE_LIMITED`：说明操作过频，稍后重试。
- `INVALID_ARGS`：按 inputSchema 修正参数（注意 `articleLimit` 必填 1-500）。
- `TASK_NOT_FOUND`：核对 taskId；任务超过 24 小时会被清理。
- `UNKNOWN_TOOL`：可能需升级运行时。

不得绕过 VIP 限制；被钳制、降级或 `partial` 的结果一律如实转述。

版本：`protocolVersion: 1`、`toolsVersion: 1`（与 `contracts/xhs-agent-tools-v1.json` 联动）。
