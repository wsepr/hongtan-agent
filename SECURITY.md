# 红探 Agent —— 安全边界（SECURITY.md）

本文逐条列出本方案**主动接受的本机攻击面**，以及为压低每一面所采取的约束。设计依据见《AI Agent 接管插件控制设计方案》§7 与 §10.7。

## 1. 进程拓扑与信任边界

| 组件 | 权限 | 约束 |
|---|---|---|
| Adapter（每宿主一个 stdio 薄进程） | 可读写 Broker 的 loopback HTTP | 仅经 `/v1/mcp` 与 `/v1/adapters/register` 通信；不持有扩展连接 |
| Broker（单例常驻） | **可启动浏览器**（OS 级能力）、可读写本机状态目录 | 见 §4 与 §5 的边界约束 |
| 插件 SW（AgentBridge） | 可执行抓取、可读写本机 WebSocket | 入站命令白名单；能力放行由插件侧设置决定 |

**扩展拥有授权与执行**：Broker 只做转发与编排，是否放行由插件侧的「Agent 接管」开关与设备批准列表决定。

## 2. 接受的本机攻击面（逐条）

1. **任意本机进程可访问 loopback 端口**（127.0.0.1:17373）。接受，因为：
   - 仅绑定 `127.0.0.1`，不监听外网；
   - `/v1/adapters/register` 要求 **ed25519 设备签名 + ±60s 时间窗**，防止未持钥进程冒充 Adapter；
   - `GET /health` 仅暴露连接在线状态、任务计数与版本，不含任务内容、不含凭证。
2. **扩展身份认证为「插件批准 deviceId，Broker 持钥签名」**（D1 落地形态）。
   - Broker 在 `%APPDATA%\红探 Agent\device-identity.json`（权限 0600）持有 ed25519 私钥；路径**不按宿主分目录**——多宿主共享同一份设备身份（同一 deviceId）是既定取舍：真正的门禁在插件侧的设备批准列表，共享身份意味着批准一次即可授权所有宿主；需要按宿主隔离时用 `HONGTAN_AGENT_STATE_DIR` 拆分状态目录；
   - 插件下发 `session.challenge`（nonce + 过期），Broker 签名应答，插件用 WebCrypto 验签；
   - 仅验签通过 **且 deviceId 在插件侧批准列表** 的设备，其 `task.start` / `sync.request` 才被接受。
3. **WebSocket 连接可能来自非扩展来源**。接受并约束：
   - Origin 白名单：仅接受空 Origin 或 `chrome-extension://`（其他一律在 upgrade 阶段 `destroy`）；
   - 单帧 ≤ 1MB、消息速率 ≤ 180 条/分钟（超限以 1008 关闭）；
   - `protocolVersion` 不匹配以 4002 关闭；
   - 5 秒内未收到 `extension.hello` 以 4001 关闭。
4. **Broker 具备「拉起浏览器」的 OS 能力**（无人值守的物理前提）。约束见 §5。
5. **设备身份文件是本机文件**：能读该文件的进程可冒充对应宿主。接受，因为同为本机已失守场景，且插件侧仍需设备批准。

## 3. 密钥与凭证

- **不落任何用户凭证明文**：Broker 与插件均不缓存 plugin_token；插件侧的 VIP 信封始终以 AES-256-GCM 密文形式（`chrome.storage.local`）缓存，篡改会导致 authTag 校验失败 → fail-closed。
- 设备私钥以 PKCS#8 PEM 存于权限 0600 的文件；公钥为 SPKI DER base64。
- `deviceId = sha256(raw 公钥) 前 24 位`，与 SPKI DER 的末 32 字节等价（Ed25519）。插件与 Broker 两侧算法一致，由单测交叉验证。

## 4. 控制面与消息总线隔离

全局消息分发器（`plugin/src/messaging/runtime.ts`）**按 action 字符串派发且不校验 sender**，任何扩展页面都可触发。因此：

- AgentBridge 的入站命令**不复用 `registerHandler`**，改由独立白名单（`task.start` / `task.cancel` / `sync.request` / 会话握手）在 AgentBridge 内部消化；
- 白名单外消息一律丢弃并计数（`rejectedInboundCount`）；
- **不引入 `externally_connectable`**，网页永远无法触达控制面。

## 5. 浏览器启动能力边界（§10.7 新增攻击面）

Broker 启动浏览器必须满足全部约束：

1. **只允许启动引导期记录的那一个** profile 与那一种浏览器（`browser.json` 固化 `{family, exe/bundle, profileDir}`）；不接受任意路径或参数。
2. 家族由**扩展上报**（`navigator.userAgentData.brands` → `chrome/edge/chromium`）；无法判定为 `unknown` 时**拒绝拉起**，不猜测。
3. **URL 白名单**：拉起命令携带的 URL 仅允许 `https://*.xiaohongshu.com` 域内 URL 或空白页（防被滥用为钓鱼跳转）。
4. **每次拉起写入审计日志**（时间、浏览器家族、profile、URL、触发原因）。
5. 拉起动作**幂等**（30s 防抖；浏览器已运行时等效开窗），不做进程状态探测。
6. **拉起命令附带消遮挡/消节流开关**（`--disable-features=CalculateNativeWinOcclusion`、`--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-backgrounding-occluded-windows`）：让抓取窗口被别的窗口盖住时不再被判 `hidden` 而停摆（真机实测对照成立）。连带后果=该浏览器会话所有标签页不被后台降级（CPU/耗电略增），已在设计文档 §10.7 声明。

### 5.1 窗口前台化能力边界（方案 B）

扩展侧无法把窗口切到系统前台（Chromium 拒绝非用户手势的聚焦请求，只闪任务栏，真机实测），故由 Broker 以 OS 级方式执行（`broker/browser/activate-window.mjs`）。该能力必须满足全部约束：

1. **只针对引导期固化的浏览器家族**：目标窗口的进程映像名白名单取自 `browser.json` 的 `family`（经家族表映射，如 edge→`msedge.exe`）；家族未知一律拒绝（`unknown-family`），不猜测、不递归枚举。
2. **窗口定位只用「类名 + 家族映像名 + 标题子串」**：不接受窗口 id、exe 路径、任意命令；标题提示仅作子串匹配（不区分大小写）。实测教训：IDE/Electron 应用的窗口类名同样是 `Chrome_WidgetWin_1`，只按类名匹配会误伤。
3. **无命令拼接注入面**：Windows 脚本是本模块内的**静态字符串常量**（standalone 运行时也不落盘读取），经 `-EncodedCommand`（base64/UTF-16LE）传递，参数只经环境变量传入；macOS/Linux 的应用名/家族名同样取自家族表常量。
4. **每次调用写入审计**（`window_activate`：family / hintSource / hintLen / ok / reason）——**不落标题原文**：hint 可能是页面可见文本（标签页标题），按契约隐私红线只进工具响应，不得落 `tasks.json` / `audit.jsonl`。
5. **失败一律降级、不重试、不提权**：helper 缺失（无 PowerShell/osascript/wmctrl/xdotool）、超时、系统拒绝前台化时，如实返回 `reason` 并让插件闪任务栏提示用户手动点击窗口；不做任何 UI 注入以外的系统操作（不修改注册表、不写系统设置）。
6. **抢焦点只在用户显式请求时发生**：仅 `xhs_activate_window` 调用触发（SKILL 要求先征询用户），运行期不自动执行。

## 6. 任务与配额

- **任务节奏配额为插件侧权威**（冷却债模型，§10.5）：每次新任务启动前由插件按「上次任务实际请求量折算的等效请求数（笔记打开 0.5、评论加载 1）+ 风控加成」结算冷却债，未还清返回 `QUOTA_EXCEEDED`（消息带可重试的绝对时刻）；24 小时任务数上限 96（滚动窗口）。Broker 不持判定逻辑，仅按插件上报的配额快照做**派发前预检**（非权威；陈旧只会漏拒，插件在派发时仍会权威重判）。
- **action 级限流**：每个工具各自独立滑窗（默认 60 次/分钟，取自 `contracts.limits.actionCallsPerMinute`），超限返回 `RATE_LIMITED`。与任务配额互补——配额管抓取启动的风控暴露面，限流管 AI 紧密轮询/试错造成的无谓负载。
- 显式续接（`xhs_start_crawl { resumeTaskId }`）**不占任务配额**：它不是新任务，只是把被风控/遮挡暂停的任务推回运行；前置条件是「用户已人工处理完」。派发阶段被拒（VIP/数据集/断言失败）的任务同样不结算、不计数（失败不烧额度）。
- 单任务规模沿用数据集剩余配额（VIP 500 篇），不另设更小上限。
- 插件侧 `agentTaskLatch` 与爬虫自身 `isCrawling` 双向兜底，避免手工与 Agent 任务并发。
- **插件侧风控暴露面**：累计评论加载次数与冷却递增次数跨任务持久化（`chrome.storage.local`），不随任务边界清零；空闲超过 6 小时视为 session 换代才归零累计次数（冷却递增次数保留）。无人值守默认走 `smart` 档（基线对齐 `standard`，并叠加密度自适应 + 疲劳因子 + 预防性冷却 + 长停顿）。
- **运行时供应链**：launcher 只执行 **SHA-256 校验通过**的受管运行时（`runtime.manifest.json` 声明 url/sha256/executable）；校验失败即拒绝安装并删除临时文件，绝不执行未经校验的字节；已安装文件被篡改时重新下载覆盖。`HONGTAN_AGENT_RUNTIME` 为运维显式信任的逃生口（绕过校验，仅限排障/私有部署）。详见 `OPERATIONS.md §1.1`。

### 6.1 多开与多 profile 策略

- **单 Broker 只接受一个扩展连接**：同一时刻新的 `hello` 会踢掉旧连接（审计记 `kicked_old`）。这是「单飞」的传输层保障——不允许两条链路同时下发任务。
- **多 profile**：配对粒度是 **Broker 的设备身份**（`device-identity.json`，位于 Agent 状态目录内；一个状态目录 = 一个 `deviceId`），**不按浏览器 profile 区分**。因此同一套 Agent 上跑多份浏览器 profile 时，只有「先连上的那个」持有会话；其余 profile 里的扩展会反复踢连接，形成抖动。
  - 推荐：需要多 profile 并行采集时，为每份 profile 使用**独立的 `HONGTAN_AGENT_STATE_DIR` 与独立端口**（等价于多套 Agent，各自生成独立设备身份）；每套各自与自己的扩展配对。
  - 不支持：同一套 Agent 上让多个 profile 同时下发任务（会在传输层互相踢掉）。

## 7. 已知残余风险

| # | 风险 | 说明 |
|---|---|---|
| 1 | **版本错位窗口**：新 Broker + 旧插件 = 新任务无节奏配额 | 配额判定已下沉插件侧（随商店自动更新分发，窗口短）；旧 Broker + 新插件 = 双闸门（保守无害）。插件侧配额状态随 `chrome.storage.local` 持久化，不再有「Broker 重启丢配额」问题。 |
| 2 | 本机攻击面随 Broker 常驻而扩大 | 已在 §2/§5 逐条约束；无法在「本机已失守」前提下提供更强保证。 |
| 3 | 抓取窗口在用户**最小化**（或系统锁屏）时**暂停** | M3 实测：hidden 态懒加载停摆。**遮挡已消除**：Broker 拉起的浏览器带消遮挡开关（`--disable-features=CalculateNativeWinOcclusion` 等），被别的窗口盖住不再被判 hidden（真机实测：遮挡下进度持续推进并正常终态）。残余=最小化（窗口真的不可见）与锁屏（会话锁定，任何进程都无法置前）、以及 Wayland（不允许外部进程设置焦点）。已通过「窗口激活契约 + 停摆可见化（`stalled_by_background`）+ `xhs_activate_window`（OS 级前台化）」管理；非安全风险，列此以便运维排查。 |
| 4 | 撤销设备后，页面爬虫按现有逻辑继续跑完 | 授权撤销只终止「上报与自动恢复」，不中断已在页面上执行的抓取循环（插件侧不越权干预爬虫）。 |
| 5 | 受管运行时的**清单本身不在签名链内** | `runtime.manifest.json` 与 `sha256` 由发布方提供、随接入包分发；若分发链路被替换，攻击者可同时替换二进制与哈希。缓解：marketplace 接入包的分发完整性由 marketplace 侧保证（Phase 3 发布项）；本机不再提供独立校验。 |
