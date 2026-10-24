# 红探 Agent —— server instructions（SKILL 不支持时的兜底摘要）

（本文件经 MCP `initialize` 的 `instructions` 下发；宿主支持 skills 时以 `SKILL.md` 为准。）

红探（hongtan）是小红书评论采集与分析插件。当用户请求实质涉及「采集/抓取小红书评论」「找客户数据」「分析/总结/统计已抓取的笔记评论」「读取数据集内容」时，使用红探工具：

1. 先调 `xhs_connection_status` 确认链路（扩展是否连接、AI 接管开关、设备是否已确认、是否 VIP、`quota` 告知新任务何时可启动）。**VIP 统一门禁**：除 `xhs_connection_status`、`xhs_prepare_env` 外，所有工具都可能返回 `VIP_REQUIRED`；不要靠直接调 `xhs_start_crawl` 去赌门禁。未就绪时**先分流**：`vip.isVip === true` → 可直接 `xhs_start_crawl`；会员态未知／无 `lastKnown` → 先调 `xhs_prepare_env`（豁免门禁）拉起并等待连接，再复查 `xhs_connection_status` 的会员态，确认是 VIP 后才启动；`vip.isVip === false` → 按 `VIP_REQUIRED` 告知并引导开通，不拉起。浏览器开着但开关未开/设备未确认时按返回的 `onboarding` 指引用户，不要重试。`quota.readyAt` 非空时：先告知用户可启动时刻、**不要试跑**。人工引导按三步走：① 开启插件「AI 接管」开关；② 核对设备核对码并确认；③ VIP 会员态。每步等用户回话后再复查。
   **只读意图先分四支**：① 只读且有快照 → 直接答并标注新鲜度；② 只读但要准确/无快照 → 调 `xhs_prepare_env`（**纯唤醒**：拉起浏览器并等连接，不返回数据集、不占单飞、不耗配额；调用前轻量说明"需要打开浏览器，约 10-60 秒，会切到前台"；返回 `needs_manual_open` 时按 `BROWSER_UNRESOLVABLE` 阶梯引导用户手动打开；`waitSec` 不传或取小值，单次 ≤30 秒）后再读；③ 读取笔记/评论内容 → 数据读取恒为 live、无离线快照，需扩展在线，离线时先 `xhs_prepare_env` 唤醒；④ 要抓取 → VIP 态确认后调 `xhs_start_crawl`。
   `xhs_list_datasets` 离线且快照未过期（24 小时内）时返回 `source:"cache"` + `stale:true` + `cachedAt`，必须复述"这是上次浏览器在线时（`cachedAt`）看到的，可能已过期"，快照只用于给用户看与选、不作存在性判据；无快照/超期/换过浏览器则返回 `EXTENSION_OFFLINE`。`xhs_task_status`/`xhs_task_list` 不做缓存，但带 `freshness`（`extensionConnected`/`lastExtensionMessageAt`/`staleReason`）：离线时账本停在最后一次上报，**不得当实时**；账本有活跃任务且离线时工具会自动尝试重新拉起浏览器（响应带 `repair`），按 ≥10 秒复查即可，不要自己再试跑。
2. 启动前必须向用户复述「目标关键词/页面、数据集名、数量上限」并获确认；同时告知会打开一个独立抓取窗口（启动时会被**尝试**带到前台，且不会被自动关闭，用户可自行关闭），采集期间若该窗口**被最小化**任务会暂停、恢复可见后自动继续（**被别的窗口盖住不会导致停摆**；**无需**要求用户保持前台）。config 可选参数与插件配置界面对齐：`skipExistingArticles`（跳过已存在笔记，默认 true）、`autoExpandCommentReplies`（自动展开评论回复，默认 false）、`commentExpandLimit`（每条最多展开次数 0-999，0=不限，仅展开开启时生效）、`commentLimit`（每篇评论上限 1-2000，默认 100）、`crawlMode`（默认 smart）、`crawlCommentImages`（VIP 专属，默认 false）；用户有偏好时按其偏好传入并复述。
3. `xhs_start_crawl` 立即返回 `taskId`，不会等待完成。启动浏览器约需 10-60 秒，期间应说「正在启动浏览器，请稍候」。
4. 监控用 `xhs_wait_for_task` **连续短挂起**：不传 `timeoutSec`（用默认 30 秒），把上一次返回的 `lastSeq` 原样作为下次 `sinceSeq` 续读增量；即使契约允许更大值，单次也不超过 30 秒。收到 `-32603` 等传输层错误时**禁止重发等待类调用**，降级为 `xhs_task_status` 快照确认现场。轮询间隔不得少于 10 秒，禁止紧密轮询。若 `xhs_task_status` 返回 `orphaned: true`（活跃任务 60 秒无新消息）：`running` 时按"上报暂时失联、插件即将给出终态结论"转述，不要宣告失败、不要重试、不要另起任务；**`stalled_by_background` 时它只表示账本停止更新（遮挡即暂停，恢复可见自动继续，超 10 分钟插件会终态化）**，不要说成故障。按 10 秒以上间隔继续复查。
5. 任务的存续不依赖你是否在线。窗口被最小化/不可见时任务只是**暂停**（`stalled_by_background`，同一任务）——**调 `xhs_activate_window` 抢回窗口前台 / 请用户点任务栏窗口让它恢复可见，就会自动继续，切勿新开任务**；只有当这段暂停在 10 分钟内一直未恢复可见（插件兜底收尾）时，才与页面被关/离开站点/心跳超时/浏览器退出、风控一样一律终态 `failed`、不可复活，插件不会自动恢复，继续抓取的唯一方式是新开任务（见第 6 条）。不要因一次失败或断连就宣告失败，也不要未经用户确认自动重开任务。
6. **任务失败后的重试（标准流程）**：读到 `failed`（`TASK_INTERRUPTED` / `BLOCKED_BY_RISK`）时——① 读快照 `processed.articles` 与 `remaining`（= max(0, `targetArticles` − 已抓篇数)，manual 与 agent 同口径；`targetArticles` 缺失时按"目标未知"如实说明）；② `remaining === 0` → 告知用户已完成，不重开；③ `remaining > 0` → **征得用户同意后**用原参数新开任务：同 keyword/noteUrl 与 datasetName、`articleLimit = remaining`、`skipExistingArticles = true`（不重复入库）、其余 config 沿用；④ 被 `QUOTA_EXCEEDED` 拒时如实转述可重试时刻，不换参硬试；⑤ 同一任务因基础设施导致的**终态中断**最多建议重试一次。唯一中间态是 `stalled_by_background`（窗口被最小化，恢复可见自动继续，超 10 分钟终态失败），无需人工处理。

7. **手动任务（`source:"manual"`）**：用户在插件里自己发起的抓取也会进任务账本，并**同样计入配额**（冷却债 / 24 小时内次数上限 / 风控加成），且与 AI 任务**共用全局单飞**（同一时刻只允许一个执行中任务）。因此：`xhs_task_list` 会看到 `source:"manual"` 的记录；被 `TASK_BUSY` 拒且来源是 manual 时如实说明"插件里有一个手动任务在跑（数据集「X」），请等它完成或在插件中结束"；**不得**用 `xhs_cancel_task` 取消手动任务（返回 `CANCEL_REJECTED`，"请在插件中取消"）；手动任务失败即由用户在插件中重跑。

8. **数据读取与分析（漏斗优先）**：`xhs_dataset_overview`（数据集统计/时间范围/互动汇总/按赞与按评论的 Top5 摘要/标签分布/`activeCrawl`）→ `xhs_list_articles`（分页、排序、抓取时间与标签筛选；`pageSize>100` 自动精简；`total`/`hasMore`/`tagNamesNotFound`）→ `xhs_read_articles`（每批 ≤5 篇，按输入顺序返回）。`commentLimit` 为 `-1`（全部有效顶层，可能很大）/`0`（不要评论）/`1-2000`（**每篇**目标返回 N 条**有效**顶层评论，被清洗消除的不占名额、按 `commentSort` 向后补位），默认 -1；双口径：`comments`/`commentCount`=页面显示总数，`scrapedComments`/`scrapedCommentCount`=实际抓取数（含回复）。清洗内置规则 1-4 恒开、规则 5-6 按用户设置；`activeCrawl`/`tagNamesNotFound`/`missingArticleIds`/`truncated`/`truncatedArticleIds`/`commentsUnavailableArticleIds` 必须如实转述。`truncated=true` 不等于有文章缺失：`truncatedArticleIds` 只列因预算不足整篇未返回的文章（已返回但评论被跳过的不列入）；`commentLimit` 有限且 `returnedTopLevel` 未达目标时降 `articleIds`/`commentLimit` 重读，`commentLimit=-1` 时降 `articleIds` 重读，已达目标仍为 `true` 时降 `replyLimit` 重读该篇，不硬塞。`commentsUnavailableArticleIds` 非空表示评论读取失败（该篇 `returnedTopLevel=0` 且无 `cleaningStats`），不得说「没有评论」，应说明读取失败并用更小的 `articleIds` 重试。读取前看 `scrapedComments` 预判，评论 >500 先与用户确认口径。数据读取恒为 live，离线先 `xhs_prepare_env`；三个读取工具同样受 VIP 门禁。

错误码处理（详见 SKILL）：
- `EXTENSION_OFFLINE`、`STALLED_BY_BACKGROUND`：不得重试，也不得宣告失败；分别说明「扩展暂时休眠，稍后恢复」「抓取窗口被最小化，任务已暂停，恢复窗口可见后自动继续」（被别的窗口盖住不会导致停摆）。不要要求用户保持前台；用户在场且希望立即恢复时，**先征询**再调 `xhs_activate_window`（前台化由本机服务用 OS 级方式执行，会抢焦点；`activated=false` 时按 `reason` 说明原因并请用户点击任务栏中闪烁的窗口，**不要反复重试**）。注意：**恢复窗口可见是唯一补救，必须在 10 分钟内做出**——暂停若 10 分钟内一直没被恢复可见，插件会兜底终态化为 `TASK_INTERRUPTED(stalled_timeout)`（根因仍是窗口最小化/遮挡，只是错过了恢复窗口期）。
- `BLOCKED_BY_RISK`：必须人工——提示用户在浏览器完成验证；任务已终态失败，用户确认处理后按第 6 条标准重试流程征得同意再新开任务；禁止自动重试。
- `VIP_REQUIRED`：如实说明 AI 接管为会员功能并引导开通/登录；不重试。除 `xhs_connection_status`、`xhs_prepare_env` 外，其余工具均需 VIP；刚开通会员可先调 `xhs_connection_status` 刷新会员态后重试，浏览器未连接可先 `xhs_prepare_env` 唤醒。VIP 过期后任务控制类工具同样被拒——请用户在插件/浏览器手动操作，不声称已取消或已恢复。
- `AGENT_DISABLED`、`DEVICE_NOT_APPROVED`：引导用户在插件设置中开启开关 / 核对设备核对码并确认；不重试。
- `LOGIN_WALL`、`NOT_LOGGED_IN`：提示用户登录小红书后重试。
- `EXTENSION_UNAVAILABLE`：说明扩展可能未安装/被禁用，提示检查 `chrome://extensions`。
- `BROWSER_UNRESOLVABLE`：说明无法自动拉起浏览器（未安装/已卸载/路径漂移）。阶梯处理：只读定位浏览器 → 经宿主**非沙盒** shell 尝试启动（脱离式写法；**不得在沙盒中启动**——沙盒派生进程随沙盒销毁，WorkBuddy 实证）并**验证扩展已连上**（5~10s 后查 `xhs_connection_status`）→ 连上才重新调 `xhs_start_crawl` 新建任务；仅有沙盒 shell 或验证失败时，引导用户手动打开。
- `PROTOCOL_VERSION_MISMATCH`：提示升级插件或红探本机服务。
- `TASK_BUSY`：改用 `xhs_task_status` 查询现有任务，勿盲目启动。
- `QUOTA_EXCEEDED`：说明配额冷却中（按上次任务请求量折算，消息里会给可重试时刻）；**不要连续试跑、不要换参数/数据集重试**，到时间再启动。
- `TASK_INTERRUPTED`：**终态**中断（`error.reason` 归因 tab_closed/page_left/heartbeat_timeout/browser_gone/stalled_timeout；其中 stalled_timeout＝窗口最小化/遮挡后 10 分钟内始终未被恢复可见、由插件兜底收尾——根因仍是暂停，只是错过了恢复窗口期），按第 6 条标准重试流程处理；同一任务最多建议重试一次。若任务仍在暂停（`stalled_by_background`）**不要重开**：先调 `xhs_activate_window` 抢回窗口前台（或请用户点任务栏窗口让窗口恢复可见），会自动继续。
- `CONTENT_NOT_READY`：说明页面类型可能不符；最多重试一次，重试前先查状态确认没有任务已在跑。
- `URL_NOT_MATCHED`：说明该 URL 不支持（仅搜索结果页 / 笔记详情页 / 用户主页）。
- `TAB_UNAVAILABLE`：抓取标签页已关闭或不可用，任务已终态失败（不自动恢复）；按 `TASK_INTERRUPTED` 的重试流程处理。
- `CANCEL_TIMEOUT` / `CANCEL_REJECTED`：说明抓取可能仍在进行，稍后复查。
- `RATE_LIMITED`：说明操作过频，稍后重试。
- `INVALID_ARGS`：按 inputSchema 修正参数（注意 `articleLimit` 必填 1-500）。
- `TASK_NOT_FOUND`：核对 taskId；任务超过 24 小时会被清理。
- `DATASET_NOT_FOUND`：数据集不存在——先用 `xhs_list_datasets` 核对名称或 ID，不要原样重试；重名/改名后按名字无法定位时改用 `datasetId`。
- `UNKNOWN_TOOL`：可能需升级运行时。
- `BROKER_NO_RESPONSE`：请求已送达但结果未知——**先查 `xhs_task_status` 确认是否已生效，禁止直接重发**等待/启动/取消类调用；读类调用若确需继续，可用更小范围（更少 `articleIds`、更小 `pageSize`/`commentLimit`）重试一次。
- `RUNTIME_STALE`：运行进程旧于当前契约——按消息里的 pid 结束该进程，下一次工具调用会自动重拉新版本；不要反复重试。
- `BROKER_ERROR`：Broker 内部执行异常——启动/等待/取消类先查 `xhs_task_status` 确认现场再决定；持续出现说明运行时异常。
- `BROKER_UNREACHABLE`：Broker 未运行且自动拉起失败——提示用户手动启动红探本机服务后再试。

表中没有的码（含形态不明的传输层错误）：原样转述、不重试、不推测原因；有副作用的调用先查状态再决定下一步。

不得绕过 VIP 限制；被钳制或降级的结果一律如实转述。`articleLimit` 是单次任务上限（1-500），数据集无数量上限、可被多次任务累加。

版本：`protocolVersion: 2`、`toolsVersion: 13`（与 `contracts/xhs-agent-tools-v1.json` 联动）。
