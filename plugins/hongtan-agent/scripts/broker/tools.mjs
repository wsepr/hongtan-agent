/**
 * MCP 工具执行器（设计文档 §6.3 / 执行计划 S1）——9 工具。
 *
 * - 数据集类（list/create/rename）经 WS sync.request 透传到插件，离线返回 EXTENSION_OFFLINE；
 * - start_crawl 立即返回 task handle（慢路径在状态机里，M2 实证模式）；
 * - wait_for_task 长轮询（timeoutSec ≤ 300 + sinceSeq 增量）；
 * - cancel_task 走取消确认协议（30s 超时 → CANCEL_TIMEOUT，任务保持可恢复）。
 *
 * 全部依赖注入（session/taskStore/quota/browserManager/now/sleep），可单测。
 */

import { validateAgainstSchema } from "./schema.mjs";
import { BROKER_TERMINAL_STATES } from "./task-store.mjs";

const err = (code, message) => ({ ok: false, error: { code, message } });
const ok = (data) => ({ ok: true, data });

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

export function createToolExecutor({
    contracts,
    taskStore,
    quota,
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
    const options = {
        syncTimeoutMs: 10_000,
        waitPollIntervalMs: 500,
        cancelTimeoutMs: 30_000,
        extensionDeadlineMs: 90_000,
        maxWaitSec: limits.waitTimeoutSecMax ?? 300,
        ...config,
    };

    /** @type {Map<string, ReturnType<setTimeout>>} */
    const extensionDeadlineTimers = new Map();

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

    function toolConnectionStatus() {
        const info = session.extensionInfo();
        const active = taskStore.activeTask();
        const limit = info?.vip?.isVip ? limits.articleLimitMax ?? 500 : limits.nonVipArticleLimit ?? 20;
        return ok({
            broker: {
                version: contracts?.toolsVersion ? `tools@${contracts.toolsVersion}` : "unknown",
                protocolVersion: contracts?.protocolVersion ?? 1,
                uptimeSec: Math.round((now() - startedAt) / 1000),
                activeTasks: taskStore.activeCount(),
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

        // 3. 配额
        const quotaResult = quota.checkAndRecord();
        if (!quotaResult.ok) {
            audit?.append("quota_rejected", { reason: quotaResult.message });
            return err(quotaResult.reason, quotaResult.message);
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
            try {
                // 拉起命令必须**携带该任务的深链 URL**（§9.1 步骤 6：等效于提前开窗，
                // 扩展连上后 SW 按 URL 前缀定位该 tab；不携带则 SW 只能自行建窗）
                browserManager?.ensureRunning({ url: buildTaskLaunchUrl(params), reason: "task-start" });
            } catch (e) {
                logger.warn?.("[broker] 浏览器拉起失败:", e?.message ?? e);
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
        if (!["blocked_by_risk", "stalled_by_background"].includes(task.state)) {
            return err(
                "RESUME_NOT_APPLICABLE",
                `任务当前状态 ${task.state} 不支持续接（仅 blocked_by_risk / stalled_by_background 可续接）`
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

    async function toolWaitForTask(args) {
        const task = taskStore.get(args?.taskId);
        if (!task) return err("TASK_NOT_FOUND", `任务不存在: ${args?.taskId}`);
        const timeoutSec = Math.min(Math.max(1, args?.timeoutSec ?? options.maxWaitSec), options.maxWaitSec);
        const sinceSeq = Number.isFinite(args?.sinceSeq) ? args.sinceSeq : 0;
        const deadline = now() + timeoutSec * 1000;

        // 「完成 / 失败 / 需人工介入 / 超时」才返回：终态或中间态（blocked/stalled）均返回
        while (now() < deadline) {
            const current = taskStore.get(args.taskId);
            if (!current) break;
            if (BROKER_TERMINAL_STATES.has(current.state) || ["blocked_by_risk", "stalled_by_background"].includes(current.state)) {
                break;
            }
            await sleep(options.waitPollIntervalMs);
        }
        const current = taskStore.get(args.taskId);
        if (!current) return err("TASK_NOT_FOUND", `任务不存在: ${args.taskId}`);
        const { entries, lastSeq } = taskStore.progressSince(args.taskId, sinceSeq);
        return ok({
            snapshot: taskStore.snapshot(current),
            progressSince: entries,
            lastSeq,
            timedOut: !BROKER_TERMINAL_STATES.has(current.state) && !["blocked_by_risk", "stalled_by_background"].includes(current.state),
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

    async function executeTool(tool, args) {
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
                return toolConnectionStatus();
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
        /** Broker 关闭时清理截止计时器 */
        dispose() {
            for (const timer of extensionDeadlineTimers.values()) clearTimeout(timer);
            extensionDeadlineTimers.clear();
        },
    };
}
