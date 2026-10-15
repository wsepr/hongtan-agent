/**
 * 任务账本（设计文档 §8 / 执行计划 S1）——状态机 + 24h JSON 落盘。
 *
 * - 状态机：queued → launching_browser → waiting_extension → running → 终态，
 *   含 blocked_by_risk / stalled_by_background（中间态透传）、interrupted、canceling；
 * - 账本：JSON 文件落盘（原子写），24h TTL watchdog 清理；seq 单调递增；
 * - 依赖注入（fs/now/logger），可单测。
 */

import fs from "node:fs";
import path from "node:path";

export const BROKER_TERMINAL_STATES = new Set([
    "completed",
    "partial",
    "failed",
    "canceled",
    "aborted_by_user",
]);

export const BROKER_ACTIVE_STATES = new Set([
    "queued",
    "launching_browser",
    "waiting_extension",
    "running",
    "blocked_by_risk",
    "stalled_by_background",
    "interrupted",
    "canceling",
]);

/** 中间态（暂停态，非终态）：经 task.progress 与插件双向同步（§8.3 / §10.4 / §10.7） */
export const BROKER_INTERMEDIATE_STATES = new Set(["blocked_by_risk", "stalled_by_background", "interrupted"]);

/**
 * wait_for_task 的早退集合（问题清单 1.3）：终态或任一中间态都应立即返回，
 * 不含 interrupted 会让 wait 在遮挡/心跳中断期间挂满整个 timeoutSec，撞上宿主 ≈60s 放弃线。
 */
export const WAIT_EARLY_RETURN_STATES = new Set([...BROKER_TERMINAL_STATES, ...BROKER_INTERMEDIATE_STATES]);

/**
 * 孤儿判定窗口（§8.1：60s 无心跳 ⇒ orphaned）。
 *
 * Broker 与插件用的是同一套信息基础（插件的 heartbeatAt 也只由 crawl_progress 推进），
 * 因此从上报链路视角复算同一阈值不会产生与插件不一致的判定；这里只作为**只读信号**
 * 回给 AI（§6.3 的 task_status 出参含 orphaned），恢复动作仍由插件侧负责（P3）。
 */
export const ORPHAN_TIMEOUT_MS = 60_000;

/** 合法转移表；表外转移拒绝（返回 false 并告警，不抛错——Broker 不因账本状态机崩溃） */
export const BROKER_TRANSITIONS = {
    queued: ["launching_browser", "waiting_extension", "running", "failed", "canceled"],
    launching_browser: ["waiting_extension", "failed", "canceled"],
    waiting_extension: ["running", "failed", "canceled"],
    running: [
        "completed",
        "partial",
        "failed",
        "canceled",
        "blocked_by_risk",
        "stalled_by_background",
        "interrupted",
        "canceling",
        "aborted_by_user",
    ],
    /**
     * 中间态是**暂停**而非终态（§8.3）：插件才是终态权威，暂停之后既可能回 running
     * （用户过完验证码 / 遮挡解除），也可能直接收尾（暂停期间达标、或用户取消）。
     * 因此中间态必须允许所有终态目标——原先只允许 running/canceled/aborted_by_user，
     * 会让「暂停后正常完成」的 task.result 被拒，账本永远停在中间态（/health 与
     * xhs_task_list 显示任务永不结束，终态 summary/error 也写不进去）。
     */
    blocked_by_risk: ["running", "completed", "partial", "failed", "canceled", "aborted_by_user"],
    stalled_by_background: ["running", "completed", "partial", "failed", "canceled", "aborted_by_user"],
    interrupted: ["running", "completed", "partial", "failed", "canceled", "aborted_by_user"],
    canceling: ["canceled", "running", "failed"],
    completed: [],
    partial: [],
    failed: [],
    canceled: [],
    aborted_by_user: [],
};

export function canBrokerTransition(from, to) {
    return BROKER_TRANSITIONS[from]?.includes(to) ?? false;
}

const PROGRESS_HISTORY_CAP = 500;
/** progressSince 单次响应最多回传的条目数（控制 token；被截掉的计入 droppedCount） */
const PROGRESS_RESPONSE_LIMIT = 40;

export function createTaskStore({
    ledgerPath,
    fsImpl = fs,
    now = () => Date.now(),
    ttlMs = 24 * 60 * 60 * 1000,
    logger = console,
    /**
     * 任何可能改变「活跃任务数」的变更后回调（签名 (taskId)，sweep 等批量变更不带 id）。
     * 由 Broker 接到 keep-awake 协调上（§10.7 环①：任务运行期间阻止系统休眠）；
     * 挂在账本层而非各调用点，避免新增转移路径时漏掉协调。
     */
    onChanged = null,
} = {}) {
    /** @type {Map<string, any>} */
    const tasks = new Map();
    let seqCounter = 0;

    /**
     * 变更监听器注册表：供 wait_for_task 事件驱动（问题清单 1.1）等多方订阅，
     * 与 DI 的 onChanged（keep-awake）互不干扰。回调签名 (taskId|undefined)。
     */
    const changeListeners = new Set();
    function emitChange(taskId) {
        onChanged?.(taskId);
        for (const fn of changeListeners) {
            try {
                fn(taskId);
            } catch (e) {
                logger.warn?.("[broker] 任务变更监听器异常:", e?.message ?? e);
            }
        }
    }

    function persist() {
        if (!ledgerPath) return;
        try {
            fsImpl.mkdirSync(path.dirname(ledgerPath), { recursive: true });
            const tmp = `${ledgerPath}.tmp`;
            fsImpl.writeFileSync(tmp, JSON.stringify([...tasks.values()], null, 2));
            fsImpl.renameSync(tmp, ledgerPath);
        } catch (e) {
            logger.warn?.("[broker] 任务账本落盘失败:", e?.message ?? e);
        }
    }

    function load() {
        if (!ledgerPath) return;
        try {
            const raw = fsImpl.readFileSync(ledgerPath, "utf8");
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                for (const task of list) {
                    // 非终态任务在 Broker 重启后无法自动续派（插件侧自会恢复/收敛），
                    // 直接标记失败，等待 TTL 清理
                    if (!BROKER_TERMINAL_STATES.has(task.state)) {
                        task.state = "failed";
                        task.error = { code: "BROKER_RESTARTED", message: "Broker 重启，任务状态不可续持" };
                    }
                    tasks.set(task.id, task);
                    if (typeof task.numericSeq === "number" && task.numericSeq >= seqCounter) {
                        seqCounter = task.numericSeq;
                    }
                }
            }
        } catch {
            /* 首次启动或账本损坏：从空账本开始 */
        }
    }

    load();

    function setState(task, state, extra = {}) {
        if (task.state === state) {
            Object.assign(task, extra, { updatedAt: now() });
            persist();
            return true;
        }
        if (!canBrokerTransition(task.state, state)) {
            logger.warn?.(`[broker] 非法任务状态转移（拒绝）: taskId=${task.id} ${task.state} → ${state}`);
            return false;
        }
        task.state = state;
        task.stateChangedAt = now();
        Object.assign(task, extra);
        task.updatedAt = now();
        persist();
        emitChange(task.id);
        return true;
    }

    function sweep() {
        const cutoff = now() - ttlMs;
        let removed = 0;
        for (const [id, task] of tasks) {
            if (!BROKER_TERMINAL_STATES.has(task.state) && task.createdAt < cutoff) {
                // 超时未终态的活跃任务先标失败，下一轮清理
                setState(task, "failed", {
                    error: { code: "TASK_STALE", message: "任务超过 24h 未终态，已被账本清理" },
                });
                continue;
            }
            if (BROKER_TERMINAL_STATES.has(task.state) && (task.updatedAt ?? task.createdAt) < cutoff) {
                tasks.delete(id);
                removed += 1;
            }
        }
        if (removed > 0) {
            persist();
            emitChange(undefined);
        }
        return removed;
    }

    return {
        createTask({ kind, params }) {
            seqCounter += 1;
            const id = `t${now().toString(36)}${seqCounter.toString(36).padStart(3, "0")}`;
            const task = {
                id,
                kind,
                params,
                state: "queued",
                seq: 0,
                processed: { articles: 0, comments: 0, images: 0, skippedByBlacklist: 0, skippedExisting: 0 },
                visibility: null,
                blocked: null,
                effectiveConfig: null,
                resumeCount: 0,
                extensionTabId: null,
                extensionWindowId: null,
                error: null,
                summary: null,
                progressHistory: [],
                createdAt: now(),
                updatedAt: now(),
                stateChangedAt: now(),
                numericSeq: seqCounter,
            };
            tasks.set(id, task);
            persist();
            emitChange(task.id);
            return task;
        },

        get(taskId) {
            return tasks.get(taskId) ?? null;
        },

        activeTask() {
            for (const task of tasks.values()) {
                if (BROKER_ACTIVE_STATES.has(task.state)) return task;
            }
            return null;
        },

        list({ limit = 20, datasetId } = {}) {
            return [...tasks.values()]
                .filter((t) => (Number.isFinite(datasetId) ? t.datasetId === datasetId : true))
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, limit)
                .map((t) => t.id);
        },

        /** 非终态任务数（/health 队列深度） */
        activeCount() {
            let n = 0;
            for (const task of tasks.values()) {
                if (BROKER_ACTIVE_STATES.has(task.state)) n += 1;
            }
            return n;
        },

        /**
         * 就地重键：把 createTask 生成的 id 换成外部（插件侧）已知的 taskId。
         * 用于冷启动对账认领插件侧重播的任务——让 task_status/取消按插件侧 id 可寻址。
         */
        renameTaskId(oldId, newId) {
            if (!newId || tasks.has(newId)) return false;
            const task = tasks.get(oldId);
            if (!task) return false;
            tasks.delete(oldId);
            task.id = newId;
            tasks.set(newId, task);
            persist();
            return true;
        },

        setState,

        /**
         * 以插件为准重新认领（§10.7 环② / §15 #10 风险缓解）。
         *
         * Broker 重启时会把在途任务标记为 `failed(BROKER_RESTARTED)`，那只是「内存账本丢失」的
         * 占位；设计明确此时**以插件为准**收敛。但 `task.progress` 对终态任务是 no-op，
         * 于是若不推翻该占位，账本会长期停在 failed，而插件其实还在跑（AI 会误报失败）。
         * 故：仅当失败原因正是 `BROKER_RESTARTED` 时允许按插件上报的状态复活，
         * 其余终态（真实结果）仍不可逆。
         */
        readoptFromPlugin(taskId, state) {
            const task = tasks.get(taskId);
            if (!task) return false;
            if (!BROKER_TERMINAL_STATES.has(task.state) || task.error?.code !== "BROKER_RESTARTED") return false;
            if (!["running", "interrupted", "blocked_by_risk", "stalled_by_background"].includes(state)) return false;
            task.state = state;
            task.stateChangedAt = now();
            task.error = null;
            task.summary = null;
            task.updatedAt = now();
            persist();
            emitChange(taskId);
            return true;
        },

        /** 进度上报：seq 必须单调递增；迟到的 progress 为 no-op */
        noteProgress(taskId, { seq, data, datasetId }) {
            const task = tasks.get(taskId);
            if (!task || BROKER_TERMINAL_STATES.has(task.state)) return false;
            if (!Number.isFinite(seq) || seq <= task.seq) return false;
            task.seq = seq;
            // 数据集归属由插件上报（AI 只给名字，重名/改名后按名字无法定位真实 id）→ 供 task_list 过滤
            if (Number.isFinite(datasetId)) task.datasetId = datasetId;
            if (data) {
                if (Number.isFinite(data.articles)) task.processed.articles = data.articles;
                if (Number.isFinite(data.comments)) task.processed.comments = data.comments;
                if (Number.isFinite(data.images)) task.processed.images = data.images;
                if (Number.isFinite(data.skippedByBlacklist)) task.processed.skippedByBlacklist = data.skippedByBlacklist;
                if (Number.isFinite(data.skippedExisting)) task.processed.skippedExisting = data.skippedExisting;
                if (typeof data.visibility === "string") task.visibility = data.visibility;
                if (typeof data.message === "string") task.lastMessage = data.message;
            }
            task.progressHistory.push({ seq, at: now(), data: data ?? null });
            if (task.progressHistory.length > PROGRESS_HISTORY_CAP) {
                const overflow = task.progressHistory.length - PROGRESS_HISTORY_CAP;
                task.progressHistory.splice(0, overflow);
                // 被环形裁掉的条数跨轮累计（问题清单 1.5）：progressSince 经 ringDroppedTotal 透出
                task.droppedCount = (task.droppedCount ?? 0) + overflow;
            }
            task.updatedAt = now();
            persist();
            emitChange(taskId);
            return true;
        },

        noteIntermediateState(taskId, intermediate) {
            const task = tasks.get(taskId);
            if (!task || BROKER_TERMINAL_STATES.has(task.state)) return false;
            if (!["blocked_by_risk", "stalled_by_background", "interrupted"].includes(intermediate)) return false;
            return setState(task, intermediate);
        },

        noteRecovered(taskId, { tabId, windowId, resumeCount, remaining }) {
            const task = tasks.get(taskId);
            if (!task) return false;
            task.extensionTabId = tabId ?? task.extensionTabId;
            task.extensionWindowId = windowId ?? task.extensionWindowId;
            if (Number.isFinite(resumeCount)) task.resumeCount = resumeCount;
            if (Number.isFinite(remaining)) task.remainingTarget = remaining;
            task.updatedAt = now();
            persist();
            emitChange(taskId);
            return true;
        },

        snapshot(task) {
            return {
                taskId: task.id,
                state: task.state,
                kind: task.kind,
                params: task.params,
                /** 插件解析后的真实数据集 id（AI 给的只是名字；早期失败/未解析时为 null） */
                datasetId: Number.isFinite(task.datasetId) ? task.datasetId : null,
                seq: task.seq,
                processed: task.processed,
                visibility: task.visibility,
                lastMessage: task.lastMessage ?? null,
                blocked: task.blocked,
                effectiveConfig: task.effectiveConfig,
                resumeCount: task.resumeCount,
                extensionTabId: task.extensionTabId,
                /**
                 * 孤儿信号（§8.1 / §6.3）：在跑任务超过 60s 没有新消息 ⇒ 视为已失联，
                 * 插件稍后会自行恢复或转终态。只读回给 AI，便于其如实转述「任务似乎失联、
                 * 正在自愈」而不是把长时间静默当成正常推进。
                 */
                orphaned:
                    task.state === "running" && now() - (task.updatedAt ?? task.createdAt ?? now()) > ORPHAN_TIMEOUT_MS,
                error: task.error,
                summary: task.summary,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
            };
        },

        /**
         * wait_for_task / task_status 的增量：seq > sinceSeq 的进度条目 + 当前 lastSeq。
         *
         * 截断语义（问题清单 1.5）：历史环形裁剪与单次响应上限都可能让 AI 拿不到完整增量——
         * `truncated: true`（游标落在已被裁掉的区间）、`droppedCount`（**单轮口径**：仅本轮
         * 响应之外被省略的条数）与 `ringDroppedTotal`（环形裁剪的跨轮累计，诊断用）把
         * 「静默丢增量」变成显式信号；条目输出为紧凑投影，落盘仍存原始 data。
         */
        progressSince(taskId, sinceSeq) {
            const task = tasks.get(taskId);
            if (!task) {
                return { entries: [], lastSeq: 0, firstAvailableSeq: 0, droppedCount: 0, ringDroppedTotal: 0, truncated: false };
            }
            const since = sinceSeq ?? 0;
            const firstAvailableSeq = task.progressHistory[0]?.seq ?? 0;
            const filtered = task.progressHistory.filter((e) => e.seq > since);
            const omitted = Math.max(0, filtered.length - PROGRESS_RESPONSE_LIMIT);
            const entries = filtered.slice(-PROGRESS_RESPONSE_LIMIT).map(compactProgressEntry);
            return {
                entries,
                lastSeq: task.seq,
                firstAvailableSeq,
                droppedCount: omitted,
                ringDroppedTotal: task.droppedCount ?? 0,
                truncated: since < firstAvailableSeq,
            };
        },

        sweep,
        persist,
        /** 订阅任务变更（wait 事件驱动等）；返回退订函数。回调签名 (taskId|undefined) */
        addChangeListener(fn) {
            changeListeners.add(fn);
            return () => changeListeners.delete(fn);
        },
        size: () => tasks.size,
    };
}

/** progressHistory 条目的对外紧凑投影（控制响应体积；不改动落盘结构） */
function compactProgressEntry(entry) {
    const d = entry?.data ?? null;
    return {
        seq: entry?.seq ?? null,
        at: entry?.at ?? null,
        current: d?.current ?? null,
        total: d?.total ?? null,
        articles: d?.articles ?? null,
        comments: d?.comments ?? null,
        message: d?.message ?? null,
        visibility: d?.visibility ?? null,
    };
}
