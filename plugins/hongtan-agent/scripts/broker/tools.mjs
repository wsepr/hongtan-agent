/**
 * MCP 工具执行器（设计文档 §6.3 / 执行计划 S1）——9 工具。
 *
 * - 数据集类（list/create/rename）经 WS sync.request 透传到插件，离线返回 EXTENSION_OFFLINE；
 * - start_crawl 立即返回 task handle（慢路径在状态机里，M2 实证模式）；
 * - wait_for_task 短挂起（按 limits.waitHangSecMax 自钳，当前 30s + sinceSeq 增量）；
 * - cancel_task 走取消确认协议（30s 超时 → CANCEL_TIMEOUT，任务保持可恢复）。
 *
 * 全部依赖注入（session/taskStore/audit/browserManager/now/sleep），可单测。
 */

import { validateAgainstSchema } from "./schema.mjs";
import { BROKER_TERMINAL_STATES, BROKER_INTERMEDIATE_STATES, WAIT_EARLY_RETURN_STATES } from "./task-store.mjs";
import { BROWSER_UNRESOLVABLE } from "./browser/resolve-exe.mjs";
import { contractsFingerprint, resolveBuildId } from "../build-fingerprint.mjs";
import { AGENT_VERSION } from "../version.mjs";

const err = (code, message) => ({ ok: false, error: { code, message } });
const ok = (data) => ({ ok: true, data });

const PROCESS_BUILD_ID = resolveBuildId();

const XHS_URL_HOST_SUFFIX = "xiaohongshu.com";

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

export function createToolExecutor({
    contracts,
    taskStore,
    audit,
    session,
    browserManager,
    rateLimiter = null,
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

    async function syncRequest(action, params) {
        if (!session.isConnected()) {
            return err("EXTENSION_OFFLINE", "红探扩展未连接（休眠或未开启 Agent 接管），稍后可恢复");
        }
        return session.syncRequest(action, params, options.syncTimeoutMs);
    }

    // ------------------------------------------------------------------
    // 工具实现
    // ------------------------------------------------------------------

    function toolConnectionStatus(ctx = {}) {
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
                browserFamily: info?.browserFamily ?? null,
                agentEnabled: info?.agentEnabled ?? null,
                deviceApproved: info?.deviceApproved ?? null,
            },
            pairing: info?.pairing ?? null,
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
            onboarding: info?.onboarding ?? null,
        });
    }

    async function toolStartCrawl(args) {
        // 显式续接（§8.3）：resumeTaskId 优先于一切参数——它不是新任务，只是把暂停中的任务推回运行
        const resumeTaskId = typeof args?.resumeTaskId === "string" && args.resumeTaskId.trim() !== "" ? args.resumeTaskId.trim() : null;
        if (resumeTaskId) return toolResumeTask(resumeTaskId);

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

        // 2. 单飞互斥
        const active = taskStore.activeTask();
        if (active) {
            return err("TASK_BUSY", `已有任务在跑（taskId=${active.id}, state=${active.state}），请先用 xhs_task_status 查看`);
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
                        message: "拉起浏览器后扩展仍未连接。请检查：浏览器是否成功启动、扩展是否已安装/启用、Agent 接管开关是否打开",
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

    /**
     * 显式续接（设计文档 §8.3 / §10.4）：AI 经用户确认后让 `blocked_by_risk` /
     * `stalled_by_background` 的任务继续。
     *
     * 不占任务配额——续接不是「新启动」，只是把已存在的暂停任务推回 running；
     * 真正的风控暴露面控制由「用户已人工处理完」这一前提提供。
     */
    function toolResumeTask(taskId) {
        const task = taskStore.get(taskId);
        if (!task) return err("TASK_NOT_FOUND", `任务不存在: ${taskId}`);
        if (!BROKER_INTERMEDIATE_STATES.has(task.state)) {
            return err(
                "RESUME_NOT_APPLICABLE",
                `任务当前状态 ${task.state} 不支持续接（仅 blocked_by_risk / stalled_by_background / interrupted 可续接）`
            );
        }
        if (!session.isConnected()) {
            return err("EXTENSION_OFFLINE", "红探扩展未连接（休眠或未开启 Agent 接管），稍后可恢复");
        }
        if (!session.sendTaskStart(task, { resume: true })) {
            return err("EXTENSION_OFFLINE", "扩展连接在续接瞬间断开，请稍后重试");
        }
        taskStore.setState(task, "running");
        audit?.append("task_resumed", { taskId: task.id });
        return ok({
            taskId: task.id,
            state: task.state,
            message: "续跑指令已下发。请用 xhs_task_status 轮询跟进（间隔不少于 10 秒）",
        });
    }

    function toolTaskStatus(args) {
        const task = taskStore.get(args?.taskId);
        if (!task) return err("TASK_NOT_FOUND", `任务不存在: ${args?.taskId}`);
        return ok(taskStore.snapshot(task));
    }
    function toolTaskList(args) {
        const limit = Math.min(Math.max(1, args?.limit ?? 20), 50);
        // datasetId：按插件上报的真实数据集归属过滤（重名/改名后按名字无法定位）
        const datasetId = Number.isFinite(args?.datasetId) ? args.datasetId : undefined;
        const ids = taskStore.list({ limit, datasetId });
        return ok({
            tasks: ids.map((id) => taskStore.snapshot(taskStore.get(id))).filter(Boolean),
        });
    }

    /**
     * wait 的早退等待：终态或任一中间态（含 interrupted）立即返回。
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
        if (task.state === "blocked_by_risk") {
            return { nextAction: "need_human", suggestedWaitSec: 0 };
        }
        // 其余早退均为中间态：插件多在自愈，短挂起续读即可
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
        // 取消派发对象：running 及全部中间态（含 interrupted）都可能在插件侧持有抓取循环；
        // 与 WAIT_EARLY_RETURN_STATES 不同构（含 running、不含终态），保持独立字面量
        if (session.isConnected() && ["running", "blocked_by_risk", "stalled_by_background", "interrupted"].includes(previousState)) {
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
        // action 级限流（§10.5）：未知工具不计数，已知工具先在滑窗内判定
        if (rateLimiter && findTool(tool)) {
            const verdict = rateLimiter.check(tool);
            if (!verdict.ok) {
                audit?.append("rate_limited", { tool });
                return err(verdict.reason, verdict.message);
            }
        }
        // xhs_start_crawl 自带参数校验（resumeTaskId 形态不要求 articleLimit，keyword/noteUrl 互斥亦为
        // schema 之外的语义），因此先于通用校验分派，避免续接形态被 articleLimit 必填挡下
        if (tool === "xhs_start_crawl") return toolStartCrawl(args);
        const schemaError = validate(tool, args);
        if (schemaError === "UNKNOWN_TOOL") return err("UNKNOWN_TOOL", `未知工具: ${tool}`);
        if (schemaError) return err("INVALID_ARGS", schemaError);
        audit?.append("tool_call", { tool });
        switch (tool) {
            case "xhs_connection_status":
                return toolConnectionStatus(ctx);
            case "xhs_list_datasets":
                return syncRequest("list_datasets", {});
            case "xhs_create_dataset":
                return syncRequest("create_dataset", { name: args?.name, ...(args?.description ? { description: args.description } : {}) });
            case "xhs_rename_dataset":
                return syncRequest("rename_dataset", {
                    ...(args?.datasetId !== undefined ? { datasetId: args.datasetId } : {}),
                    ...(args?.name ? { name: args.name } : {}),
                    newName: args?.newName,
                });
            case "xhs_task_status":
                return toolTaskStatus(args);
            case "xhs_task_list":
                return toolTaskList(args);
            case "xhs_wait_for_task":
                return toolWaitForTask(args);
            case "xhs_cancel_task":
                return toolCancelTask(args);
            case "xhs_activate_window":
                return syncRequest("window_activate", {});
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
