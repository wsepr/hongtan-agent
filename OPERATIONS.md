# 红探 Agent —— 运维手册（OPERATIONS.md）

设计依据见《AI Agent 接管插件控制设计方案》§10.6（手动降级）与 §11（审计与可观测性）。

## 1. 组件与端口

| 组件 | 形式 | 说明 |
|---|---|---|
| Adapter | stdio MCP 进程（每宿主一个） | 由宿主经 `scripts/launch-agent.cmd/.sh` 拉起；工具调用转发给 Broker |
| Broker | 单例常驻进程 | loopback `127.0.0.1:17373`；HTTP `/health`、`POST /v1/mcp`；WS `/extension` |
| 状态目录 | `%APPDATA%\红探 Agent\`（可用 `HONGTAN_AGENT_STATE_DIR` 覆盖） | `device-identity.json`（0600）、`browser.json`、`tasks.json`（24h 账本）、`audit.jsonl`、`runtime.manifest.json` + `runtime/`（受管运行时，见 §1.1） |

## 1.1 运行时解析与自动安装（S13）

launcher 分两条入口（`launch-agent.cmd` / `.sh`）：**有 Node ≥ 22** 走 `runtime-launch.mjs`（先试受管运行时，否则用本机 Node 跑同一份源码）；**无 Node** 走 `bootstrap-runtime.ps1` / `bootstrap-runtime.sh`（纯 PowerShell / curl，不依赖 Node）。两条入口共用同一份清单与同一套校验语义：

1. **`HONGTAN_AGENT_RUNTIME`**（运维显式指定）：直接执行该可执行文件，绕过清单。用于排障或私有部署。
2. **受管运行时**：读 `<状态目录>/runtime.manifest.json`
   ```json
   { "version": "0.1.0",
     "platforms": { "win32-x64": { "url": "https://…/hongtan-agent.exe", "sha256": "<hex>", "executable": "hongtan-agent.exe" } } }
   ```
   平台键为 `<platform>-<arch>`（`win32-x64` / `darwin-arm64` / `linux-x64` …）。
   状态目录无清单时，按接入包版本从版本钉死的发布地址自动获取并缓存（`HONGTAN_AGENT_MANIFEST_SEED_URL` 可覆盖，用于测试隔离或私有部署；失败不阻断，走系统 Node 回退）。
   已安装且 **SHA-256 匹配** → 复用；缺失 → 下载到 `runtime/<exe>.part` → 校验 → 原子 rename 落地并置可执行位；**校验失败即删除临时文件并拒绝安装**（不会执行未经校验的字节）。
   已安装但哈希不匹配（被篡改/损坏）→ 删除并重新下载。
3. **系统 Node**：有 Node 但无清单/清单无当前平台条目时，用本机 Node ≥ 22 执行同一份源码。

引导脚本退出码：`0` 成功；`1` 无清单 / 清单无当前平台条目；`2` 下载失败或 SHA-256 校验失败。

常见运维动作：

| 现象 | 处理 |
|---|---|
| 启动日志出现「运行时自动安装失败：… SHA-256 校验失败」 | 下载源被污染或清单过期。核对 `runtime.manifest.json` 的 `sha256` 与发布产物；两者不一致时**不要**放宽校验，联系发布方更新清单 |
| 需要临时用本机某份运行时排障 | 设 `HONGTAN_AGENT_RUNTIME=<可执行文件绝对路径>`（该路径不再校验哈希，属运维显式信任） |
| 需要预装但不启动运行时 | `bootstrap-runtime.ps1 -InstallOnly` / `bootstrap-runtime.sh --install-only` |
| 未装 Node 的机器 | 已支持：引导脚本自动获取运行时清单（按接入包版本钉死的发布地址）→ 下载 + 校验 + 执行受管运行时；清单获取失败时如实报错（不断言本机 Node 状态），可检查网络或手动放置清单 |
| bash 引导报「缺少 JSON 解析工具」 | 需 `jq` 或 `python3` 之一（仅用于读清单；免 Node 场景下用它替代 Node 解析 JSON） |

## 2. 启动与自愈

1. **Adapter 自启 Broker**：Adapter 启动时探测 `/health`，未运行则 `spawn detached` 拉起单例。
2. **Broker 单例**：启动前探测 `/health`，已有实例则直接退出（避免多实例争抢扩展连接）；`EADDRINUSE` 亦退出。
3. **开机自启**：Broker 启动时幂等注册 HKCU Run（`HongtanAgent`）。若被安全软件拦截，日志会记录 `[autostart] 开机自启注册失败`，需手动放行或改用任务计划程序。
4. **阻止系统休眠**：任务进入 running 时由 Broker 派生 PowerShell 宿主执行 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`，终态释放。

> 物理上限（如实声明）：机器处于关机/休眠时，本方案不提供任何恢复能力；恢复只能在机器与 Broker 重新上线后由冷启动对账接管。

## 3. 健康检查

```bash
curl http://127.0.0.1:17373/health
```

返回关键字段：

- `extension.connected` / `extension.lastSeenAt`：扩展是否在线及最近心跳时间
- `tasks.active` / `tasks.total` / `activeTaskId`
- `browser.launchCount` / `browser.lastLaunchAt` / `browser.config`
- `keepAwakeHeld`
- `recentTasks`：最近 5 个任务摘要
- `version` / `uptimeSec`：Broker 版本与运行时长

> 上述字段在 v2.6 之前**实际拿不到**：`websocket-server.mjs` 曾在 HTTP 分发开头直接应答 `GET /health`（极简 `{ok, service, websocketPath}`），把 Broker 的扩展响应短路了；因单例复用探测与 adapter 都只看 `ok`，一直无人察觉。现已改为「宿主回调优先、内置响应降级为兜底」，若你在返回体里看到 `service` 字段，说明拿到的是内置兜底响应（异常，应检查 Broker 是否启动正常）。

**排障入口**：用户回来后问「我不在的时候发生了什么」→ 用 `xhs_task_list` 复盘，或直接读 `tasks.json` 与 `audit.jsonl`。任务若长时间无进展，`xhs_task_status` 会给出 `orphaned: true`（在跑且 60s 无新消息）——按 SKILL 口径如实告知「任务暂时失联、插件会自动恢复」，不要据此宣告失败。

## 4. 审计日志

`audit.jsonl` 为 append-only JSONL，一行一事件（`{ts, event, ...}`）。关键事件：

> **已知限制**：审计日志只增不改，**无轮转与容量上限**（设计文档未承诺轮转）。长时间无人值守运行会持续增长，需要时请自行归档/清理（建议先停 Broker 再处理文件，避免写入交错）。

| event | 含义 |
|---|---|
| `broker_start` / `hello_ok` / `ws_close` / `extension_disconnected` | 生命周期 |
| `kicked_old` | 单扩展连接策略触发（连接风暴告警项） |
| `session_proof_error` / `hello_reject` | 认证失败与版本拒绝 |
| `task_created` / `task_dispatched` / `task_result` / `task_intermediate` / `task_resumed_running` / `task_recovered` / `task_readopted` / `task_cancel_*` | 任务全生命周期（`task_intermediate` 落中间态、`task_resumed_running` 表示插件报回 running 后账本同步回在跑、`task_readopted` 表示 Broker 重启的 `failed(BROKER_RESTARTED)` 占位被插件重播推翻） |
| `browser_recorded` / `browser_resolved` / `browser_resolve_pending` / `browser_profile_resolved` / `browser_launch` / `browser_launch_skipped` / `browser_launch_escalated` / `browser_launch_escalation_skipped` / `browser_spawn_error` / `browser_launch_error` | 浏览器拉起留痕（§10.7 安全边界；`browser_launch_skipped` = 吻痕/进程探测命中跳过（`reason: recent-contact \| process-running`），`browser_launch_escalated` = skip 30s 后强制拉起一次（每任务封顶），`browser_launch_escalation_skipped` = 到期已回连（`reason: contact-refreshed`）或无等待任务（`no-pending-task`）而不升级，见《常驻工作区设计方案》§5.2） |
| `adapter_registered` / `adapter_register_rejected` | Adapter 设备签名握手 |
| `tool_call` | 工具调用（不含敏感参数） |
| `quota_rejected` / `rate_limited` | 配额**预检**拒绝（Broker 按插件上报的快照拦截，带 `readyAt`/`reason`；判定与结算在插件侧，§10.5）/ action 级限流 |
| `alert` | **告警事件**（`kind` 见下；已实现，落审计便于事后复盘） |
| `task_resumed` | 用户确认后的显式续接（`xhs_start_crawl { resumeTaskId }`） |
| `task_cancel_forced` | 插件明确「本机没有该任务」（`NO_ACTIVE_TASK` / `TASK_ID_MISMATCH`）→ 账本强制收敛为 `canceled`（脏状态清理） |

`task_result` 现在带 `errorCode` / `resumeCount` / `durationMs` / `datasetId` / `hostKey` / `deviceId` / `summary`（§11.1 可归因）；`task_created` 带 `tool`。

**告警（§11.6，`event: "alert"` + `kind`）**：

| kind | 触发条件 | 建议动作 |
|---|---|---|
| `extension_offline` | 扩展连续离线 ≥10 分钟 | 检查浏览器是否仍在运行、插件开关是否被关；必要时重开浏览器 |
| `task_heartbeat_stall` | 在跑任务 ≥5 分钟无进度更新 | 多为遮挡/挂起；看 `/health` 的 `activeTaskId` 与插件侧抓取窗口状态 |
| `resume_exhausted` | 任务终态错误码为 `RESUME_EXHAUSTED` | 人工检查浏览器环境（反复中断已达 3 次上限） |
| `connection_storm` | 60 秒内 `kicked_old` ≥5 次 | 典型原因是多 profile 同时连同一 Broker → 按 `SECURITY.md §6.1` 拆分独立状态目录与端口 |
| （Broker 掉线） | 由 **adapter** 侧观察：**每次工具调用**都会先探测 `/health`（命中健康缓存 5s 内不重复探测），未运行则 spawn detached 拉起并在宿主 stderr 告警「Broker 未运行 / Broker 已就绪 / Broker 拉起失败（15s 内 /health 不可达）」；**拉起失败或掉线都不被缓存**，下一次调用会重新探测 + 重试 | 查看该进程输出；Broker 自身无法为自己死亡告警 |

阈值默认值见 `agent/plugins/hongtan-agent/scripts/broker/alerts.mjs`（`extensionOfflineMs` / `taskStallMs` / `kickedOldWindowMs` / `kickedOldCount`），可按部署注入覆盖。

## 5. 手动降级步骤

按顺序执行即可完全回到手工抓取（既有路径不受影响）：

1. **停 Broker** —— 结束常驻进程；移除开机自启（`reg delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v HongtanAgent /f`）。
2. **关闭插件开关** —— 红探插件设置 →「Agent 接管」→ 关闭。效果：立即断开 WS + 清除 `chrome.alarms` + 拒绝新命令 + 在途任务转 `aborted_by_user`（页面爬虫按现有逻辑继续跑完，但不再上报、不再自动恢复）。
3. **撤销设备批准** —— 同一设置页 → 设备管理 → 逐个「撤销」（撤销即断开该设备连接）。
4. **卸载 Adapter / launcher** —— 从宿主移除 MCP 注册与插件包即可。

## 6. 常见故障

| 现象 | 排查 |
|---|---|
| 工具返回 `BROWSER_OFFLINE` | 本机服务正在拉起浏览器；若持续不回，确认浏览器可执行文件路径未漂移（查看 `browser.config`） |
| 工具返回 `EXTENSION_OFFLINE` | 浏览器在跑但扩展未连。检查插件「Agent 接管」开关是否开启；SW 由 `alarms`（0.5 分钟）自愈重连，等一轮再查 |
| 工具返回 `EXTENSION_UNAVAILABLE` | 拉起浏览器 90s 后仍无连接。检查扩展是否安装/启用、设备是否已批准 |
| 任务反复中断 | 看审计里 `task_recovered` 频次；自动恢复上限为 **3 次**，达上限转 `failed(RESUME_EXHAUSTED)`，需人工检查浏览器环境 |
| 任务停在 `blocked_by_risk` | 风控/验证码/未登录，**不自动重试**。用户在浏览器处理完并确认后，带 `resumeTaskId` 再调一次 `xhs_start_crawl` 即可续跑（审计记 `task_resumed`） |
| 任务进度长时间不动 | 多为抓取窗口被遮挡/最小化（`stalled_by_background`）。恢复窗口可见即自动继续；v2.12 起不再自动还原/抢焦点。用户在场时先征询再调 `xhs_activate_window` 拉回前台；也可经确认后用 `resumeTaskId` 续跑 |
| 终态是 `partial` 且带 `DATASET_QUOTA_EXCEEDED` | 运行中数据集写入被 SW 防线拒绝（已达 500 篇上限）。结果如实汇报为部分完成；换一个数据集重跑 |
| 工具返回 `RATE_LIMITED` | action 级限流触发（默认 60 次/分钟/工具）。等提示的秒数后重试；轮询间隔应 ≥10 秒 |
| 工具返回 `BROKER_UNREACHABLE` / `BROKER_ERROR` | Broker 进程被杀或崩溃。adapter 会**自动重新拉起并重发该次调用**（连接类失败才重发，超时类不重发以免工具被执行两次）；若反复出现，按宿主 stderr 告警指引手动启动 `node scripts/broker-server.mjs` 并查看其输出 |
| 扩展重载后旧页面无响应 | 扩展重载会使已存在页面的 content script 成为孤儿上下文。该场景由心跳超时/恢复流程覆盖（优先复用原 tab，不可用则重开抓取窗口并重下发） |
| 多 profile 下连接反复断开 | 单 Broker 只接受一个扩展连接（新连接踢旧）。见 SECURITY.md §6.1：为每份 profile 使用独立的 `HONGTAN_AGENT_STATE_DIR` 与端口 |
| 开机后任务没续跑 | 检查开机自启是否注册成功；整机重启续跑属验收项（见执行计划 S14） |
