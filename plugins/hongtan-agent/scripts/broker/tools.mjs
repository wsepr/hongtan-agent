/**
 * MCP 工具执行器（设计文档 §6.3 / 详细设计 §2.2）——14 工具。
 *
 * - 数据集类（list/create/rename）经 WS sync.request 透传到插件；list_datasets 离线可降级读快照
 *   （source:"cache"），其余离线返回 EXTENSION_OFFLINE；
 * - 数据读取类（dataset_overview/list_articles/read_articles）恒走活体 sync.request，
 *   不做离线快照；响应体积由插件侧组装期预算控制，Broker 只透传 truncated；
 * - 统一 VIP 门禁：除 connection_status/prepare_env 外的工具在 executeTool 入口单点拦截
 *   （提示性拦截，权威校验在插件侧）；
 * - connection_status 离线补 lastKnown（取自会话快照）/canWake/alerts；
 * - prepare_env 纯唤醒（幂等、不占单飞、不耗配额），不返回数据集；
 * - start_crawl 立即返回 task handle（慢路径在状态机里，M2 实证模式）；
 * - wait_for_task 短挂起（按 limits.waitHangSecMax 自钳，当前 30s + sinceSeq 增量）；
 * - task_status/task_list 附 freshness（新鲜度自述）+ 修复式拉起；
 * - cancel_task 走取消确认协议（30s 超时 → CANCEL_TIMEOUT，任务保持可恢复），手工任务直接拒绝。
 *
 * 全部依赖注入（session/taskStore/audit/browserManager/snapshotStore/alerts/now/sleep），可单测。
 */

import crypto from "node:crypto";
import { validateAgainstSchema } from "./schema.mjs";
import { BROKER_TERMINAL_STATES, WAIT_EARLY_RETURN_STATES } from "./task-store.mjs";
import { BROWSER_UNRESOLVABLE } from "./browser/resolve-exe.mjs";
import { contractsFingerprint, resolveBuildId } from "../build-fingerprint.mjs";
import { AGENT_VERSION } from "../version.mjs";

const err = (code, message) => ({ ok: false, error: { code, message } });
const ok = (data) => ({ ok: true, data });

const PROCESS_BUILD_ID = resolveBuildId();

const XHS_URL_HOST_SUFFIX = "xiaohongshu.com";

/**
 * 统一 VIP 门禁：仅这两项豁免。connection_status 是诊断会员态的入口；
 * prepare_env 是冷启动唤醒（不返回业务数据），豁免后才能打破「无 lastKnown 就拉不起浏览器」的死锁。
 * 门禁只是提示性拦截，权威校验在插件侧（加密信封 + fail-closed）。
 */
export const VIP_EXEMPT_TOOL_NAMES = Object.freeze(["xhs_connection_status", "xhs_prepare_env"]);
const VIP_EXEMPT_TOOLS = new Set(VIP_EXEMPT_TOOL_NAMES);

/** 数据读取类 action：VIP 门禁后、转发前检查设备批准，避免 sync.request 被插件丢弃后白等超时 */
export const DATA_READ_TOOL_NAMES = Object.freeze(["xhs_dataset_overview", "xhs_list_articles", "xhs_read_articles"]);
const DATA_READ_TOOLS = new Set(DATA_READ_TOOL_NAMES);

/** 按工具名设置转发超时：读类比控制类更宽松（overview/list 15s、read 30s、控制类保持 10s） */
const TOOL_SYNC_TIMEOUTS = {
    xhs_dataset_overview: 15_000,
    xhs_list_articles: 15_000,
    xhs_read_articles: 30_000,
};

/**
 * 由任务参数构造拉起用深链（§9.1 步骤 6）。纯函数：无 keyword/noteUrl 时返回 null（空白页）。
 * 与插件侧 deepLink.ts 同口径；URL 白名单在 browser/launch-command.mjs 二次校验。
 */
export function buildTaskLaunchUrl(params) {
    if (params?.keyword) {
        return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(params.keyword)}`;
    }
    if (params?.noteUrl) return params.noteUrl;
    return null;
}

function isValidXhsNoteUrl(url) {
    try {
        const parsed = new URL(url);
        return (
            (parsed.protocol === "https:" || parsed.protocol === "http:") &&
            (parsed.hostname === XHS_URL_HOST_SUFFIX || parsed.hostname.endsWith(`.${XHS_URL_HOST_SUFFIX}`))
        );
    } catch {
        return false;
    }
}

/**
 * 冷却中消息模板（与插件侧 `pacingGate.formatPacingMessage` 同一措辞）。
 * 快照里的 readyAt 是绝对时刻，这里据此算出「建议 HH:MM 后再开始」，供 AI 如实转述。
 */
export function formatQuotaMessage(quotaInfo) {
    const at = new Date(quotaInfo.readyAt);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const reason =
        typeof quotaInfo.reason === "string" && quotaInfo.reason !== "" ? quotaInfo.reason : "上次任务请求量较大";
    return `配额冷却中：${reason}，建议 ${hhmm} 后再开始`;
}

/**
 * 账本新鲜度自述（详细设计 §2.2 / §7.1）——纯函数，只保留不可派生字段：
 * activeTaskFrozen 由「activeTask != null && !extensionConnected」派生，不单设。
 */
export function buildFreshness({ info, task, now: _now } = {}) {
    return {
        extensionConnected: !!info?.connected,
        lastExtensionMessageAt: info?.lastSeenAt ?? null,
        staleReason: !info?.connected
            ? "extension-offline"
            : task?.error?.code === "BROKER_RESTARTED"
              ? "broker-restarted"
              : null,
    };
}

export function createToolExecutor({
    contracts,
    taskStore,
    audit,
    session,
    browserManager,
    rateLimiter = null,
    snapshotStore = null,
    alerts = null,
    uuid = () => crypto.randomUUID(),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    config = {},
    logger = console,
} = {}) {
    const limits = contracts?.limits ?? {};
    const startedAt = now();
    const contractsHash = contractsFingerprint(contracts ?? null);
    const options = {
        syncTimeoutMs: 10_000,
        // 查询前拉取会员态是可失败的增强（失败即回退 Broker 缓存），不沿用 syncTimeoutMs——
        // 否则设备未批准 / 插件未应答时会白等 10s，把只读查询拖慢
        vipSyncTimeoutMs: 2_000,
        waitPollIntervalMs: 500,
        cancelTimeoutMs: 30_000,
        extensionDeadlineMs: 90_000,
        // waitHangSecMax（问题清单 1.1）：单次挂起必须远小于宿主 ≈60s 放弃线。
        // 当前契约已无 waitTimeoutSecMax，别名分支只为仍在跑的旧出包兜底。
        maxWaitSec: limits.waitHangSecMax ?? limits.waitTimeoutSecMax ?? 300,
        ...config,
    };

    /** @type {Map<string, ReturnType<setTimeout>>} */
    const extensionDeadlineTimers = new Map();

    // ------------------------------------------------------------------
    // wait 事件驱动（问题清单 1.1）：taskStore 变更 → 25ms 去抖合并 → 唤醒该任务的 waiter。
    // 2s 兜底 tick 只防漏事件（如监听链异常），正常路径不再 500ms 忙轮询。
    // ------------------------------------------------------------------

    /** @type {Map<string, Set<() => void>>} taskId -> waiters */
    const wakeMap = new Map();
    const dirtyTaskIds = new Set();
    let wakeDebounceTimer = null;

    function onTaskStoreChanged(taskId) {
        if (taskId === undefined || taskId === null) {
            // 批量变更（sweep 等）：唤醒全部 waiter 重新判定
            for (const set of wakeMap.values()) {
                for (const fn of set) fn();
            }
            return;
        }
        dirtyTaskIds.add(taskId);
        if (wakeDebounceTimer) return;
        wakeDebounceTimer = setTimeout(() => {
            wakeDebounceTimer = null;
            const ids = [...dirtyTaskIds];
            dirtyTaskIds.clear();
            for (const tid of ids) {
                const set = wakeMap.get(tid);
                if (set) for (const fn of set) fn();
            }
        }, 25);
    }

    const unsubscribeTaskChanges = taskStore.addChangeListener?.(onTaskStoreChanged) ?? null;

    function findTool(name) {
        return contracts?.tools?.find((t) => t.name === name) ?? null;
    }

    function validate(name, args) {
        const tool = findTool(name);
        if (!tool) return "UNKNOWN_TOOL";
        return validateAgainstSchema(tool.inputSchema, args ?? {});
    }

    // ------------------------------------------------------------------
    // sync.request 透传（数据集类）
    // ------------------------------------------------------------------

    async function syncRequest(action, params, timeoutMs = options.syncTimeoutMs, requestOptions = {}) {
        if (!session.isConnected()) {
            return err("EXTENSION_OFFLINE", "红探扩展未连接（休眠或未开启 AI 接管），稍后可恢复");
        }
        return session.syncRequest(action, params, timeoutMs, requestOptions);
    }

    function syncTimeoutFor(tool, args = {}) {
        // 数据集模式与大批量 ID 读取一次装多篇，给 40s；小批定向读取保持 30s
        if (tool === "xhs_read_articles") {
            if (args?.articleIds === undefined) return 40_000;
            if (Array.isArray(args.articleIds) && args.articleIds.length > 20) return 40_000;
        }
        return TOOL_SYNC_TIMEOUTS[tool] ?? options.syncTimeoutMs;
    }

    /**
     * 会话会员态：在线取握手/实时刷新的缓存；离线优先 lastKnown（会话快照），
     * 再退到扩展会话缓存（同样是最后一次 hello 的事实）。两者皆无 = 从未连接过 → fail-closed。
     */
    function sessionVip() {
        const info = session.extensionInfo();
        // 在线时**只认活体会话**：hello 上报 vip:null（未登录/登出）必须 fail-closed，
        // 不能回落到 24h 内可能仍写着 vip:true 的离线快照。
        if (info?.connected) return info.vip ?? null;
        // 离线：优先 lastKnown（会话快照），再退到会话缓存（同样来自最后一次 hello）
        const cached = snapshotStore?.readSession?.({ extId: info?.extId ?? null }) ?? null;
        return cached?.session?.vip ?? info?.vip ?? null;
    }

    /** Broker 侧 VIP 门禁（提示性；权威校验在插件侧）。返回错误对象或 null。 */
    function vipGate(tool) {
        if (VIP_EXEMPT_TOOLS.has(tool)) return null;
        if (sessionVip()?.isVip === true) return null;
        return err(
            "VIP_REQUIRED",
            "AI 接管为会员功能（非会员或会员状态无法确认）。如刚开通会员，请先调 xhs_connection_status 刷新会员态；浏览器未连接可先调 xhs_prepare_env 唤醒"
        );
    }

    /**
     * 查询前拉取最新会员态。
     *
     * Broker 只在握手（hello）时缓存 vip——用户在握手之后登录 / 登出 / 刷新信封时，
     * 扩展侧缓存已更新而 Broker 内存仍是旧值（曾导致「插件已显示 VIP，AI 查仍为 null」）。
     * 此处经既有 sync.request 通道实时拉一次，覆盖由 broker-server 的 syncRequest 写穿完成。
     * 拉取失败一律静默沿用缓存（与快照刷新失败同口径），不阻塞只读查询。
     */
    async function refreshVipState() {
        const info = session.extensionInfo();
        // 设备未批准时插件会丢弃 sync.request（agentBridge 的 deviceApproved 门禁），
        // 拉取只会白等到超时——直接跳过
        if (!info?.connected || info.deviceApproved === false) return;
        try {
            await session.syncRequest("get_vip_state", {}, options.vipSyncTimeoutMs);
        } catch {
            /* 静默：沿用 Broker 缓存 */
        }
    }

    // ------------------------------------------------------------------
    // 工具实现
    // ------------------------------------------------------------------

    async function toolConnectionStatus(ctx = {}) {
        await refreshVipState();
        const info = session.extensionInfo();
        const active = taskStore.activeTask();
        const limit = info?.vip?.isVip ? limits.articleLimitMax ?? 500 : limits.nonVipArticleLimit ?? 20;
        // runtime 块（问题清单 4.2/4.3）：「正在运行的是哪份代码」在 AI 必查的 connection_status 里自证。
        // adapter 段为 null = 调用方较旧（未上送指纹头），不代表能力缺失。
        const adapterFp = ctx?.adapterFingerprint ?? null;
        const contractsMatch = adapterFp?.contractsHash ? adapterFp.contractsHash === contractsHash : null;
        const helloFresh = !!(info?.connected && Number.isFinite(info?.lastSeenAt) && now() - info.lastSeenAt < 90_000);
        return ok({
            broker: {
                version: contracts?.toolsVersion ? `tools@${contracts.toolsVersion}` : "unknown",
                protocolVersion: contracts?.protocolVersion ?? 1,
                uptimeSec: Math.round((now() - startedAt) / 1000),
                activeTasks: taskStore.activeCount(),
            },
            runtime: {
                broker: {
                    version: AGENT_VERSION,
                    buildId: PROCESS_BUILD_ID,
                    contractsHash,
                    startedAt,
                    pid: process.pid,
                    mode: process.versions.bun ? "standalone" : "node",
                    node: process.version,
                    effectiveLimits: limits,
                },
                adapter: adapterFp
                    ? {
                          version: adapterFp.version,
                          buildId: adapterFp.buildId,
                          contractsHash: adapterFp.contractsHash,
                          hostKey: process.env.HONGTAN_AGENT_HOST ?? null,
                      }
                    : null,
                extension: {
                    version: info?.version ?? null,
                    helloAt: info?.lastSeenAt ?? null,
                },
                agreement: {
                    contractsMatch,
                    helloFresh,
                    staleSuspect: contractsMatch === false,
                },
            },
            extension: {
                connected: info?.connected ?? false,
                lastSeenAt: info?.lastSeenAt ?? null,
                extId: info?.extId ?? null,
                version: info?.version ?? null,
                toolsVersion: info?.toolsVersion ?? null,
                capabilities: info?.capabilities ?? null,
                browserFamily: info?.browserFamily ?? null,
                agentEnabled: info?.agentEnabled ?? null,
                deviceApproved: info?.deviceApproved ?? null,
            },
            pairing: info?.pairing ?? null,
            // 占用通道（独占租约）：AI 必须能说清"任务会在哪个浏览器执行"，
            // 否则用户在 Chrome 里等一个正在 Edge 里跑的任务。
            channel: session.activeChannel?.() ?? null,
            vip: info?.vip
                ? {
                      isVip: info.vip.isVip,
                      // §6.3：两个到期时间必须分开回传，语义不同——
                      // vipExpiresAt 是会员到期（AI 据此提示「会员临近到期」），
                      // envelopeExpiresAt 是信封自身到期（签发 + 48h，过期会把 VIP 误判为非 VIP，供离线容灾判断）
                      vipExpiresAt: info.vip.expiresAt ?? null,
                      envelopeExpiresAt: info.vip.envelopeExpiresAt ?? null,
                      effectiveArticleLimit: limit,
                  }
                : null,
            // 任务节奏配额快照（§10.5，插件侧权威；Broker 只透出预检缓存）：
            // AI 可先查「何时可启动」，避免调了 start_crawl 才知道要等
            quota: info?.quota ?? null,
            activeTask: active ? taskStore.snapshot(active) : null,
            // 离线只读（详细设计 §2.2）：lastKnown 取自会话快照的 session 段（同一文件同一 TTL）——
            // **仅离线时返回**；在线恒为 null，缓存永不参与在线回答
            lastKnown: !info?.connected ? buildLastKnown(info) : null,
            // 可唤醒（布尔；不设 hints[]，下一步建议复用既有 onboarding）
            canWake: true,
            // 最近告警摘要（白名单字段 kind/at/taskId；仅覆盖当前 Broker 进程存活期）
            alerts: alerts?.digest?.() ?? [],
            onboarding: info?.onboarding ?? null,
        });
    }

    /** 离线会话摘要：命中快照 session 段 → {...session, extId, browserFamily, cachedAt}，否则 null */
    function buildLastKnown(info) {
        const cached = snapshotStore?.readSession?.({ extId: info?.extId ?? null }) ?? null;
        if (!cached) return null;
        return {
            ...(cached.session ?? {}),
            extId: cached.extId,
            browserFamily: cached.browserFamily,
            cachedAt: cached.cachedAt,
        };
    }

    /**
     * xhs_prepare_env（详细设计 §2.2 / §6）：纯唤醒——拉起浏览器并等连接。
     * 幂等（已连上不拉）、不占任务单飞、不耗配额；空 URL（不预开抓取深链，避免劫持用户当前搜索页）；
     * 首次引导（家族/extId 未记录）→ needs_manual_open。不返回数据集。
     */
    async function toolPrepareEnv(args, ctx = {}) {
        const connection = async () => (await toolConnectionStatus(ctx)).data;
        if (session.isConnected()) {
            return ok({
                ensure: { state: "connected", launched: false, skippedReason: "already-connected", deadlineAt: null },
                connection: await connection(),
            });
        }
        const waitKey = `env:${uuid()}`;
        let launched = null;
        try {
            launched = browserManager?.ensureRunning({ url: null, reason: "prepare", waitKey }) ?? null;
        } catch (e) {
            logger.warn?.("[broker] 准备环境拉起失败:", e?.message ?? e);
        }
        // 任何拉起失败都归入「需人工打开」：环境等待**没有**任务补投递路径（不像 waiting_extension
        // 还有 hello 重投 + watchdog 重拉），继续等下去没有出路。首次引导（browser.json 无 family/extId）
        // 的失败形状**不带 code**，旧实现只认 BROWSER_UNRESOLVABLE 会把它误报成 connecting。
        if (launched?.ok === false) {
            const skippedReason = launched.code === BROWSER_UNRESOLVABLE ? "browser-unresolvable" : "browser-config-missing";
            audit?.append("env_prepare", {
                reason: args?.reason ?? null,
                state: "needs_manual_open",
                code: launched.code ?? null,
                message: launched.message ?? null,
            });
            return ok({
                ensure: {
                    state: "needs_manual_open",
                    launched: false,
                    skippedReason,
                    message: launched.message ?? null,
                    deadlineAt: null,
                },
                connection: await connection(),
            });
        }
        // waitSec 短等待（连上即早退）；不传则立即返回 connecting，由 AI 按 ≥10s 复查
        const waitSec = Number.isFinite(args?.waitSec) ? args.waitSec : 0;
        if (waitSec > 0) {
            const deadline = now() + waitSec * 1000;
            while (now() < deadline && !session.isConnected()) {
                await sleep(Math.min(options.waitPollIntervalMs, Math.max(1, deadline - now())));
            }
        }
        const state = session.isConnected() ? "connected" : "connecting";
        audit?.append("env_prepare", { reason: args?.reason ?? null, state, launched: launched?.ok !== false });
        return ok({
            ensure: {
                state,
                launched: launched?.ok !== false,
                skippedReason: launched?.skipReason ?? null,
                deadlineAt: now() + options.extensionDeadlineMs,
            },
            connection: await connection(),
        });
    }

    /**
     * 数据集列表（详细设计 §2.2 / §5.4）：在线恒取活体（source:"live"）；离线降级读快照
     * （source:"cache" + stale + cachedAt）；未命中（无快照/超 TTL/extId 不匹配）→ EXTENSION_OFFLINE。
     */
    async function toolListDatasets() {
        if (session.isConnected()) {
            const r = await session.syncRequest("list_datasets", {}, options.syncTimeoutMs);
            if (!r?.ok) return r ?? err("EXTENSION_OFFLINE", "红探扩展未连接（休眠或未开启 AI 接管），稍后可恢复");
            return ok({ datasets: r.data?.datasets ?? [], source: "live" });
        }
        const cached = snapshotStore?.readDatasets?.({ extId: session.extensionInfo()?.extId ?? null }) ?? null;
        if (cached) return ok({ datasets: cached.datasets, source: "cache", stale: true, cachedAt: cached.cachedAt });
        return err("EXTENSION_OFFLINE", "红探扩展未连接（休眠或未开启 AI 接管），稍后可恢复");
    }

    /** 修复式拉起（R2，详细设计 §7.2）：仅「账本有活跃任务 + 扩展离线（矛盾信号）」时触发一次 */
    function maybeRepairTaskQuery() {
        if (session.isConnected()) return null;
        const active = taskStore.activeTask();
        if (!active) return null;
        let launched = null;
        try {
            launched = browserManager?.ensureRunning({ url: null, reason: "task-query", waitKey: `task-query:${active.id}` }) ?? null;
        } catch (e) {
            logger.warn?.("[broker] 任务查询修复式拉起失败:", e?.message ?? e);
        }
        const skippedReason = launched?.skipReason ?? null;
        // 真的发起过拉起才算「拉起」：防抖命中 / 进程探测命中（skipped）时只是「尝试」，
        // 审计与响应都如实标注，避免事后把"没拉也记成拉了"当证据。
        const attempted = launched?.ok !== false && launched?.skipped !== true;
        audit?.append("task_query_launch", { taskId: active.id, launched: attempted, skippedReason });
        return { triggered: true, taskId: active.id, launched: attempted, skippedReason };
    }

    /** 标题提示回退：活跃任务的 keyword（noteUrl 任务标题未知 → 由调用方再兜底域名词） */
    function activeTaskHint() {
        const keyword = taskStore.activeTask()?.params?.keyword;
        return typeof keyword === "string" && keyword.trim() !== "" ? keyword.trim() : null;
    }

    /**
     * 方案 B：把抓取窗口切到系统前台（《抓取窗口前台化与后台不停摆 实施方案》）。
     *
     * 扩展侧做不到——Chromium 会拒绝非用户手势的聚焦请求，回落成「闪任务栏」（真机实测：
     * `minimized→normal+focused`、`fullscreen→normal+focused` 等状态转换 hack 亦全部失败）。
     * 故插件那一步只作**尽力而为**（激活标签页 + windows.update）并回传窗口提示，
     * 真正生效的是随后 Broker 的 OS 级调用（Windows Win32 / macOS osascript / Linux X11 wmctrl）。
     *
     * 两个边界：① 插件离线时不做 OS 调用（此时没有在跑的任务，抢焦点只会打扰用户）；
     * ② 无受管窗且无活跃任务时也不做——否则只能拿域名词去猜，可能把**用户自有的**小红书窗口抢到前台。
     */
    async function toolActivateWindow() {
        const sync = await syncRequest("window_activate", {});
        if (sync?.ok === false) return sync;
        const plugin = sync?.data ?? null;
        const pluginHint = typeof plugin?.titleHint === "string" && plugin.titleHint.trim() !== "" ? plugin.titleHint.trim() : null;
        const taskHint = activeTaskHint();
        const hasActiveTask = taskStore.activeTask() !== null;
        const hint = pluginHint ?? taskHint ?? (hasActiveTask ? "小红书" : null);
        const hintSource = pluginHint ? "plugin" : taskHint ? "task-keyword" : hint !== null ? "domain" : "none";
        const pluginBlock = plugin
            ? { activated: plugin.activated === true, windowId: plugin.windowId ?? null, reason: plugin.reason ?? null }
            : null;

        if (hint === null) {
            return ok({
                activated: false,
                reason: plugin?.reason ?? "no-managed-window",
                hint: null,
                hintSource: "none",
                window: { hwnd: null, candidates: null },
                plugin: pluginBlock,
                message: "当前没有受管的抓取窗口（任务可能已结束），未做前台化",
            });
        }

        const os = (await browserManager?.activateWindowOS?.({ titleHint: hint, hintSource })) ?? {
            ok: false,
            reason: "unsupported-platform",
        };
        return ok({
            activated: os.ok === true,
            reason: os.ok ? null : os.reason,
            hint,
            hintSource,
            window: { hwnd: os.hwnd ?? null, candidates: os.candidates ?? null },
            plugin: pluginBlock,
            message: os.ok
                ? "抓取窗口已切到系统前台"
                : `未能把抓取窗口切到前台（${os.reason}）：请点击任务栏中闪烁的浏览器窗口继续抓取`,
        });
    }

    async function toolStartCrawl(args) {
        // v3 续跑已下线：显式拒绝旧形态，避免 AI 静默忽略后误判「任务还在继续」
        if (typeof args?.resumeTaskId === "string" && args.resumeTaskId.trim() !== "") {
            return err(
                "INVALID_ARGS",
                "不支持 resumeTaskId 参数；请用 keyword 或 noteUrl 加 articleLimit 新开任务（articleLimit 必填 1-500，续抓剩余量可用快照的 remaining）"
            );
        }

        // 1. 契约校验（articleLimit 必填等；keyword/noteUrl 二选一为 schema 之外的互斥语义）
        const schemaError = validate("xhs_start_crawl", args);
        if (schemaError) return err("INVALID_ARGS", schemaError);
        const hasKeyword = typeof args.keyword === "string" && args.keyword.trim() !== "";
        const hasNoteUrl = typeof args.noteUrl === "string" && args.noteUrl.trim() !== "";
        if (hasKeyword === hasNoteUrl) {
            return err("INVALID_ARGS", "keyword 与 noteUrl 必须二选一");
        }
        if (hasNoteUrl && !isValidXhsNoteUrl(args.noteUrl)) {
            return err("URL_NOT_MATCHED", "noteUrl 仅支持 xiaohongshu.com 域内 URL");
        }

        // 2. 单飞互斥（按对方状态给出可转述的处置指引）
        const active = taskStore.activeTask();
        if (active) {
            const busyHint =
                active.state === "stalled_by_background"
                    ? "有一个窗口被遮挡的暂停任务，请恢复窗口可见（或用 xhs_cancel_task 取消后重发）"
                    : "已有任务在进行，请先用 xhs_task_status 查看";
            return err("TASK_BUSY", `任务占用中（taskId=${active.id}, state=${active.state}）：${busyHint}`);
        }

        // 3. 配额预检（§10.5）：读插件上报的配额快照做派发前拦截——未到可启动时刻直接拒绝、
        //    不建任务（保住秒回 UX）。快照缺失（旧插件/扩展离线）时跳过，交给插件在派发时权威重判。
        const quotaInfo = session.extensionInfo()?.quota ?? null;
        if (quotaInfo && Number.isFinite(quotaInfo.readyAt) && quotaInfo.readyAt > now()) {
            audit?.append("quota_rejected", { readyAt: quotaInfo.readyAt, reason: quotaInfo.reason ?? null });
            return err("QUOTA_EXCEEDED", formatQuotaMessage(quotaInfo));
        }

        // 4. 建任务
        const params = {
            ...(hasKeyword ? { keyword: args.keyword.trim() } : { noteUrl: args.noteUrl.trim() }),
            ...(args.datasetName ? { datasetName: args.datasetName.trim() } : {}),
            articleLimit: args.articleLimit,
            ...(args.config ? { config: args.config } : {}),
        };
        const task = taskStore.createTask({ kind: "crawl", params });
        // §11.1：任务记录带工具名（唯一建任务的工具就是本工具）
        audit?.append("task_created", { taskId: task.id, tool: "xhs_start_crawl", params });

        // 5. 派发（扩展在线直发；离线则幂等拉起浏览器 + 等连接，90s 截止）
        if (session.isConnected()) {
            const sent = session.sendTaskStart(task);
            if (sent) {
                taskStore.setState(task, "running");
                audit?.append("task_dispatched", { taskId: task.id });
            } else {
                taskStore.setState(task, "failed", {
                    error: { code: "EXTENSION_OFFLINE", message: "扩展连接在派发瞬间断开，请稍后重试" },
                });
            }
        } else {
            taskStore.setState(task, "launching_browser");
            let launched = null;
            try {
                // 拉起命令必须**携带该任务的深链 URL**（§9.1 步骤 6：等效于提前开窗，
                // 扩展连上后 SW 按 URL 前缀定位该 tab；不携带则 SW 只能自行建窗）。
                // taskId 供 browserManager 的升级兜底按任务封顶（skip 后由它自调度 30s 升级）。
                launched =
                    browserManager?.ensureRunning({ url: buildTaskLaunchUrl(params), reason: "task-start", taskId: task.id }) ??
                    null;
            } catch (e) {
                logger.warn?.("[broker] 浏览器拉起失败:", e?.message ?? e);
            }
            if (launched?.ok === false && launched.code === BROWSER_UNRESOLVABLE) {
                // 无法拉起（浏览器未安装/已卸载/路径漂移且重探失败）：等待不可能成功，立即归因失败（v2.10）。
                // 「家族/extId 未记录」的失败不带 code，仍走下方等待——那是 hello 未达的合法竞态，
                // 连上后 dispatchPendingTasks 会派发，快速失败会破坏它。
                taskStore.setState(task, "failed", {
                    error: { code: BROWSER_UNRESOLVABLE, message: `无法自动拉起浏览器：${launched.message ?? "浏览器配置不可解析"}` },
                });
                audit?.append("task_failed", { taskId: task.id, code: BROWSER_UNRESOLVABLE });
                return ok({
                    taskId: task.id,
                    state: "failed",
                    message: "浏览器无法自动拉起，请手动打开装有红探扩展的浏览器后重试",
                });
            }
            taskStore.setState(task, "waiting_extension");
            audit?.append("task_wait_extension", {
                taskId: task.id,
                deadlineSec: Math.round(options.extensionDeadlineMs / 1000),
            });
            const timer = setTimeout(() => {
                extensionDeadlineTimers.delete(task.id);
                const current = taskStore.get(task.id);
                if (!current || BROKER_TERMINAL_STATES.has(current.state) || current.state === "running") return;
                taskStore.setState(current, "failed", {
                    error: {
                        code: "EXTENSION_UNAVAILABLE",
                        message: "拉起浏览器后扩展仍未连接。请检查：浏览器是否成功启动、扩展是否已安装/启用、AI 接管开关是否打开",
                    },
                });
                audit?.append("task_failed", { taskId: task.id, code: "EXTENSION_UNAVAILABLE" });
            }, options.extensionDeadlineMs);
            extensionDeadlineTimers.set(task.id, timer);
        }

        return ok({
            taskId: task.id,
            state: task.state,
            message: "任务已创建。请用 xhs_task_status 轮询跟进（间隔不少于 10 秒）",
        });
    }

    function toolTaskStatus(args) {
        const task = taskStore.get(args?.taskId);
        if (!task) return err("TASK_NOT_FOUND", `任务不存在: ${args?.taskId}`);
        const info = session.extensionInfo();
        const repair = maybeRepairTaskQuery();
        return ok({
            // 快照自带 source（task-store）；离线时不冒充实时，附 freshness 自述
            ...taskStore.snapshot(task),
            freshness: buildFreshness({ info, task, now: now() }),
            ...(repair ? { repair } : {}),
        });
    }
    function toolTaskList(args) {
        const limit = Math.min(Math.max(1, args?.limit ?? 20), 50);
        // datasetId：按插件上报的真实数据集归属过滤（重名/改名后按名字无法定位）
        const datasetId = Number.isFinite(args?.datasetId) ? args.datasetId : undefined;
        const ids = taskStore.list({ limit, datasetId });
        const info = session.extensionInfo();
        const repair = maybeRepairTaskQuery();
        return ok({
            tasks: ids.map((id) => taskStore.snapshot(taskStore.get(id))).filter(Boolean),
            freshness: buildFreshness({ info, task: taskStore.activeTask(), now: now() }),
            ...(repair ? { repair } : {}),
        });
    }

    /**
     * wait 的早退等待：终态或唯一中间态（stalled_by_background）立即返回。
     * 主路径是 taskStore 变更事件（25ms 去抖合并），sleep（可注入）仅作 2s 兜底与 deadline 推进——
     * 因此正常路径无忙轮询，且测试可推时钟。
     */
    function waitForWake(taskId) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        const set = wakeMap.get(taskId) ?? new Set();
        wakeMap.set(taskId, set);
        const fn = () => resolve();
        set.add(fn);
        return {
            promise,
            dispose: () => {
                set.delete(fn);
                if (set.size === 0) wakeMap.delete(taskId);
            },
        };
    }

    async function waitForEarlyReturn(taskId, deadline) {
        for (;;) {
            const current = taskStore.get(taskId);
            if (!current || WAIT_EARLY_RETURN_STATES.has(current.state)) return;
            const remaining = deadline - now();
            if (remaining <= 0) return;
            const wake = waitForWake(taskId);
            await Promise.race([wake.promise, sleep(Math.min(2000, remaining))]);
            wake.dispose();
        }
    }

    function buildWaitHint(task) {
        if (BROKER_TERMINAL_STATES.has(task.state)) {
            return { nextAction: "finished", suggestedWaitSec: 0 };
        }
        if (task.state === "stalled_by_background") {
            // 唯一中间态：窗口被遮挡/最小化，恢复可见即自愈，不需要人工盯守
            return { nextAction: "need_window_visible", suggestedWaitSec: 0 };
        }
        // 派发在途（queued/launching_browser/waiting_extension/running）：插件多在推进，短挂起续读即可
        return { nextAction: "wait_more", suggestedWaitSec: 15 };
    }

    async function toolWaitForTask(args) {
        const task = taskStore.get(args?.taskId);
        if (!task) return err("TASK_NOT_FOUND", `任务不存在: ${args?.taskId}`);
        const requestedSec = args?.timeoutSec ?? options.maxWaitSec;
        const timeoutSec = Math.min(Math.max(1, requestedSec), options.maxWaitSec);
        const sinceSeq = Number.isFinite(args?.sinceSeq) ? args.sinceSeq : 0;
        const deadline = now() + timeoutSec * 1000;

        await waitForEarlyReturn(args.taskId, deadline);

        const current = taskStore.get(args.taskId);
        if (!current) return err("TASK_NOT_FOUND", `任务不存在: ${args.taskId}`);
        const progress = taskStore.progressSince(args.taskId, sinceSeq);
        const earlyReturn = WAIT_EARLY_RETURN_STATES.has(current.state);
        return ok({
            snapshot: taskStore.snapshot(current),
            progressSince: progress.entries,
            lastSeq: progress.lastSeq,
            // 游标缺口显式化（问题清单 1.5）：truncated=游标落在已被环形裁掉的区间；
            // droppedCount=本轮响应之外被省略的条数（单轮口径）；ringDroppedTotal=环形裁剪跨轮累计
            firstAvailableSeq: progress.firstAvailableSeq,
            droppedCount: progress.droppedCount,
            ringDroppedTotal: progress.ringDroppedTotal,
            truncated: progress.truncated,
            effectiveTimeoutSec: timeoutSec,
            timedOut: !earlyReturn,
            hint: buildWaitHint(current),
        });
    }

    async function toolCancelTask(args) {
        const task = taskStore.get(args?.taskId);
        if (!task) return err("TASK_NOT_FOUND", `任务不存在: ${args?.taskId}`);
        if (BROKER_TERMINAL_STATES.has(task.state)) return ok(taskStore.snapshot(task));
        // 手工任务直接拒绝（详细设计 §7.4）：插件侧 handleTaskCancel 只认 Agent 态，会对 adopted 的
        // 手工任务回 NO_ACTIVE_TASK，而 Broker 把这种拒绝强制收敛为 canceled → 会谎报「已取消」，
        // 实际手工抓取仍在跑。位置在终态检查之后、置 canceling 之前。
        if ((task.source ?? "agent") === "manual") {
            return err("CANCEL_REJECTED", "手工任务请在插件中取消（AI 侧不支持取消手工任务）");
        }

        // 取消确认协议：通知插件 → 等 30s 终态；超时回退原状态并返回 CANCEL_TIMEOUT（任务保持可恢复）
        const previousState = task.state;
        const deadlineTimer = extensionDeadlineTimers.get(task.id);
        if (deadlineTimer) {
            clearTimeout(deadlineTimer);
            extensionDeadlineTimers.delete(task.id);
        }
        if (!taskStore.setState(task, "canceling")) {
            return err("CANCEL_REJECTED", `当前状态 ${task.state} 不允许取消`);
        }
        // 取消派发对象：running 与唯一中间态 stalled 都可能在插件侧持有抓取循环；
        // 与 WAIT_EARLY_RETURN_STATES 不同构（含 running、不含终态），保持独立字面量
        if (session.isConnected() && ["running", "stalled_by_background"].includes(previousState)) {
            session.sendTaskCancel(task.id);
        }
        const deadline = now() + options.cancelTimeoutMs;
        while (now() < deadline) {
            const current = taskStore.get(task.id);
            if (current && BROKER_TERMINAL_STATES.has(current.state)) {
                audit?.append("task_canceled", { taskId: task.id, confirmed: true });
                return ok(taskStore.snapshot(current));
            }
            await sleep(Math.min(options.waitPollIntervalMs, 200));
        }
        // 超时：回退到可恢复状态，返回 CANCEL_TIMEOUT 而非让任务凭空消失（设计文档 §9.2）
        taskStore.setState(task, "running", {
            error: { code: "CANCEL_TIMEOUT", message: "取消确认超时，抓取可能仍在进行，请稍后用 xhs_task_status 复查" },
        });
        audit?.append("task_cancel_timeout", { taskId: task.id });
        return err("CANCEL_TIMEOUT", "取消确认超时，抓取可能仍在进行，请稍后用 xhs_task_status 复查");
    }

    // ------------------------------------------------------------------
    // 分发
    // ------------------------------------------------------------------

    async function executeTool(tool, args, ctx = {}) {
        // 1. action 级限流（§10.5）：未知工具不计数，已知工具先在滑窗内判定
        if (rateLimiter && findTool(tool)) {
            const verdict = rateLimiter.check(tool);
            if (!verdict.ok) {
                audit?.append("rate_limited", { tool });
                return err(verdict.reason, verdict.message);
            }
        }
        // 2. 未知工具先判，避免被 VIP 错误码掩盖（VIP 门禁对未知工具没有意义）
        if (!findTool(tool)) return err("UNKNOWN_TOOL", `未知工具: ${tool}`);
        // 3. 统一 VIP 门禁（豁免 connection_status / prepare_env）
        const denied = vipGate(tool);
        if (denied) return denied;
        // 4. 数据读取类：设备未批准时插件会丢弃 sync.request，直接回码而不是白等到超时
        if (DATA_READ_TOOLS.has(tool) && session.extensionInfo()?.deviceApproved === false) {
            return err("DEVICE_NOT_APPROVED", "设备未确认或已被撤销，请在红探插件设置 →「AI 接管」中确认本机设备");
        }
        // 5. xhs_start_crawl 自带参数校验（keyword/noteUrl 互斥与 resumeTaskId 显式拒绝为 schema
        //    之外的语义），先于通用校验分派
        if (tool === "xhs_start_crawl") return toolStartCrawl(args);
        const schemaError = validate(tool, args);
        if (schemaError) return err("INVALID_ARGS", schemaError);
        audit?.append("tool_call", { tool });
        switch (tool) {
            case "xhs_connection_status":
                return await toolConnectionStatus(ctx);
            case "xhs_prepare_env":
                return toolPrepareEnv(args, ctx);
            case "xhs_list_datasets":
                return toolListDatasets();
            case "xhs_create_dataset":
                return syncRequest("create_dataset", { name: args?.name, ...(args?.description ? { description: args.description } : {}) });
            case "xhs_rename_dataset":
                return syncRequest("rename_dataset", {
                    ...(args?.datasetId !== undefined ? { datasetId: args.datasetId } : {}),
                    ...(args?.name ? { name: args.name } : {}),
                    newName: args?.newName,
                });
            case "xhs_dataset_overview":
                return syncRequest("dataset_overview", { ...args }, syncTimeoutFor(tool), { timeoutCode: "READ_TIMEOUT" });
            case "xhs_list_articles":
                return syncRequest("list_articles", { ...args }, syncTimeoutFor(tool), { timeoutCode: "READ_TIMEOUT" });
            case "xhs_read_articles": {
                if (args?.articleIds !== undefined && (args?.datasetId !== undefined || args?.datasetName !== undefined)) {
                    return err("INVALID_ARGS", "articleIds 与 datasetId/datasetName 不能同时使用；按 ID 读取会自动跨数据集");
                }
                return syncRequest("read_articles", { ...args }, syncTimeoutFor(tool, args), { timeoutCode: "READ_TIMEOUT" });
            }
            case "xhs_task_status":
                return toolTaskStatus(args);
            case "xhs_task_list":
                return toolTaskList(args);
            case "xhs_wait_for_task":
                return toolWaitForTask(args);
            case "xhs_cancel_task":
                return toolCancelTask(args);
            case "xhs_activate_window":
                return await toolActivateWindow();
            default:
                return err("UNKNOWN_TOOL", `未知工具: ${tool}`);
        }
    }

    return {
        executeTool,
        /** hello 补投递前清除该任务的「等扩展连接」截止计时器 */
        clearExtensionDeadline(taskId) {
            const timer = extensionDeadlineTimers.get(taskId);
            if (timer) {
                clearTimeout(timer);
                extensionDeadlineTimers.delete(taskId);
            }
        },
        /** Broker 关闭时清理截止计时器、唤醒全部 waiter 并退订变更监听 */
        dispose() {
            for (const timer of extensionDeadlineTimers.values()) clearTimeout(timer);
            extensionDeadlineTimers.clear();
            for (const set of wakeMap.values()) {
                for (const fn of set) fn();
            }
            wakeMap.clear();
            if (wakeDebounceTimer) {
                clearTimeout(wakeDebounceTimer);
                wakeDebounceTimer = null;
            }
            dirtyTaskIds.clear();
            unsubscribeTaskChanges?.();
        },
    };
}
