/**
 * 任务账本（设计文档 §8 / 执行计划 S1）——状态机 + 24h JSON 落盘。
 *
 * - 状态机（v3）：queued → launching_browser → waiting_extension → running → 终态，
 *   唯一中间态 stalled_by_background（遮挡/最小化暂停，恢复可见自愈）；
 *   interrupted / blocked_by_risk / partial 已删除：终态中断与风控一律终态失败，任务不可复活；
 * - 账本：JSON 文件落盘（原子写），24h TTL watchdog 清理；seq 单调递增；
 * - 旧状态只读归一化（D9）：load 时把旧落盘记录映射为新语义，不迁移原文；
 * - 依赖注入（fs/now/logger），可单测。
 */

import fs from "node:fs";
import path from "node:path";

export const BROKER_TERMINAL_STATES = new Set([
    "completed",
    "failed",
    "canceled",
    "aborted_by_user",
]);

export const BROKER_ACTIVE_STATES = new Set([
    "queued",
    "launching_browser",
    "waiting_extension",
    "running",
    "stalled_by_background",
    "canceling",
]);

/** 中间态（暂停态，非终态）：经 task.progress 与插件双向同步（§8.3 / §10.4 / §10.7） */
export const BROKER_INTERMEDIATE_STATES = new Set(["stalled_by_background"]);

/**
 * wait_for_task 的早退集合（问题清单 1.3）：终态或任一中间态都应立即返回，
 * 不含 stalled 会让 wait 在遮挡期间挂满整个 timeoutSec，撞上宿主 ≈60s 放弃线。
 */
export const WAIT_EARLY_RETURN_STATES = new Set([...BROKER_TERMINAL_STATES, ...BROKER_INTERMEDIATE_STATES]);

/** 旧状态集合（D9）：v3 删除的历史状态，load 时只读归一化 */
const LEGACY_TASK_STATES = new Set(["interrupted", "blocked_by_risk", "partial"]);

/**
 * 旧状态归一化（D9，只读）：与插件侧 legacyStatus.ts 同口径。
 * - partial → failed/TASK_INTERRUPTED（历史说明：旧版本按数据集写入上限提前结束）；
 * - interrupted：达标 → completed；未达标 → failed/TASK_INTERRUPTED（不猜原因）；
 * - blocked_by_risk → failed/BLOCKED_BY_RISK（保留风控加成语义）。
 * 返回归一化副本；非旧状态原样返回（保持引用）。
 */
export function normalizeLegacyTask(task) {
    if (!task || !LEGACY_TASK_STATES.has(task?.state)) return task;
    const normalized = { ...task };
    const originalTarget = Number.isFinite(task.params?.articleLimit) ? task.params.articleLimit : 0;
    const articles = Number.isFinite(task.processed?.articles) ? task.processed.articles : 0;
    if (task.state === "partial") {
        normalized.state = "failed";
        normalized.error = {
            code: "TASK_INTERRUPTED",
            message: "任务提前结束（历史记录）",
        };
    } else if (task.state === "interrupted") {
        // 单篇/作者进度在评论抓取前上报，达标不等于评论完整；这两个目标不得按进度收敛。
        // 与插件 taskCompletion.isNoteLikeProgressTarget 同义；跨运行时不能共享代码，测试保持对照。
        const targetType = resolveTaskTarget(task)?.type ?? null;
        const noteLike = targetType === "noteUrl" || targetType === "authorUrl";
        if (!noteLike && originalTarget > 0 && articles >= originalTarget) {
            normalized.state = "completed";
        } else {
            normalized.state = "failed";
            normalized.error = {
                code: "TASK_INTERRUPTED",
                message: "任务中断（历史记录，未记录原因）",
            };
        }
    } else if (task.state === "blocked_by_risk") {
        normalized.state = "failed";
        normalized.error = { code: "BLOCKED_BY_RISK", message: "任务因风控中断（历史记录）" };
    }
    return normalized;
}

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
        "failed",
        "canceled",
        "stalled_by_background",
        "canceling",
        "aborted_by_user",
    ],
    /**
     * 中间态是**暂停**而非终态（§8.3）：插件才是终态权威，暂停之后既可能回 running
     * （遮挡解除），也可能直接收尾（暂停期间达标、或用户取消）。
     * 因此中间态必须允许所有终态目标——否则「暂停后正常完成」的 task.result 会被拒，
     * 账本永远停在中间态（终态 summary/error 也写不进去）。
     */
    stalled_by_background: ["running", "completed", "failed", "canceled", "aborted_by_user"],
    canceling: ["canceled", "running", "failed"],
    completed: [],
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

/** 出站文本脱敏：把任意消息里 URL 的 xsec_token/xsec_source 值替换为 [redacted] */
const SECRET_QUERY_VALUE_RE = /((?:xsec_token|xsec_source)=)[^&\s"'<>)]*/gi;

export function redactSecretsInText(text) {
    return text.replace(SECRET_QUERY_VALUE_RE, "$1[redacted]");
}

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
                for (const rawTask of list) {
                    // D9：旧状态（interrupted/blocked_by_risk/partial）先只读归一化为新语义，
                    // 再走「非终态 → failed(BROKER_RESTARTED)」的常规收敛
                    const task = normalizeLegacyTask(rawTask);
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
        const safeExtra =
            extra?.error && typeof extra.error.message === "string"
                ? { ...extra, error: { ...extra.error, message: redactSecretsInText(extra.error.message) } }
                : extra;
        if (task.state === state) {
            Object.assign(task, safeExtra, { updatedAt: now() });
            persist();
            return true;
        }
        if (!canBrokerTransition(task.state, state)) {
            logger.warn?.(`[broker] 非法任务状态转移（拒绝）: taskId=${task.id} ${task.state} → ${state}`);
            return false;
        }
        task.state = state;
        task.stateChangedAt = now();
        Object.assign(task, safeExtra);
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
        createTask({ kind, params, source = "agent" }) {
            seqCounter += 1;
            const id = `t${now().toString(36)}${seqCounter.toString(36).padStart(3, "0")}`;
            const task = {
                id,
                kind,
                params,
                // 任务来源（详细设计 §2.3）：manual = 用户在插件里手动发起的抓取（不可由 AI 取消）
                source,
                state: "queued",
                seq: 0,
                processed: { articles: 0, comments: 0, images: 0, skippedByBlacklist: 0, skippedExisting: 0 },
                /**
                 * 目标总篇数：agent 任务取 AI 请求值，manual（认领）任务由插件上报的 data.total 补齐。
                 * 手工任务认领时只有 `params: { adopted: true }`，不落这里就永远推不出 remaining。
                 */
                targetArticles: Number.isFinite(params?.articleLimit) ? params.articleLimit : null,
                /** 当前篇目序号（插件 progress 上报） */
                currentArticle: null,
                /** 数据集名与抓取目标：manual 任务只能由插件上报才可知（见 noteProgress） */
                datasetName: null,
                target: null,
                visibility: null,
                blocked: null,
                effectiveConfig: null,
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
         * 其余终态（真实结果）仍不可逆。v3 只接受 running / stalled_by_background。
         */
        readoptFromPlugin(taskId, state) {
            const task = tasks.get(taskId);
            if (!task) return false;
            if (!BROKER_TERMINAL_STATES.has(task.state) || task.error?.code !== "BROKER_RESTARTED") return false;
            if (!["running", "stalled_by_background"].includes(state)) return false;
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
        noteProgress(taskId, { seq, data, datasetId, datasetName, target, effectiveConfig }) {
            const task = tasks.get(taskId);
            if (!task || BROKER_TERMINAL_STATES.has(task.state)) return false;
            if (!Number.isFinite(seq) || seq <= task.seq) return false;
            task.seq = seq;
            // 数据集归属由插件上报（AI 只给名字，重名/改名后按名字无法定位真实 id）→ 供 task_list 过滤
            if (Number.isFinite(datasetId)) task.datasetId = datasetId;
            // manual 任务的身份事实只能由插件上报（Broker 侧无从解析）：数据集名、抓取目标、生效配置
            if (typeof datasetName === "string" && datasetName !== "" && datasetName.length <= MAX_DATASET_NAME_LEN) {
                task.datasetName = datasetName;
            }
            if (isTaskTarget(target)) task.target = { type: target.type, value: target.value };
            if (effectiveConfig && typeof effectiveConfig === "object" && !Array.isArray(effectiveConfig)) {
                task.effectiveConfig = effectiveConfig;
            }
            const safeData =
                data && typeof data.message === "string"
                    ? { ...data, message: redactSecretsInText(data.message) }
                    : data;
            if (safeData) {
                if (Number.isFinite(safeData.articles)) task.processed.articles = safeData.articles;
                if (Number.isFinite(safeData.comments)) task.processed.comments = safeData.comments;
                if (Number.isFinite(safeData.images)) task.processed.images = safeData.images;
                if (Number.isFinite(safeData.skippedByBlacklist)) task.processed.skippedByBlacklist = safeData.skippedByBlacklist;
                if (Number.isFinite(safeData.skippedExisting)) task.processed.skippedExisting = safeData.skippedExisting;
                // 目标总篇数与篇目序号：插件侧 total 是钳制后的真实目标，比 AI 请求值更权威
                // （0 视为尚未得知，不能把已知目标清掉）
                if (Number.isFinite(safeData.total) && safeData.total > 0) task.targetArticles = safeData.total;
                if (Number.isFinite(safeData.current)) task.currentArticle = safeData.current;
                if (typeof safeData.visibility === "string") task.visibility = safeData.visibility;
                if (typeof safeData.message === "string") task.lastMessage = safeData.message;
            }
            task.progressHistory.push({ seq, at: now(), data: safeData ?? null });
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
            if (!["stalled_by_background"].includes(intermediate)) return false;
            return setState(task, intermediate);
        },

        snapshot(task) {
            const processed = task.processed;
            const targetArticles = resolveTargetArticles(task);
            return {
                taskId: task.id,
                state: task.state,
                kind: task.kind,
                /** 任务来源（详细设计 §2.3）：旧落盘记录缺字段时按 agent 兜底 */
                source: task.source ?? "agent",
                params: redactTaskParams(task.params),
                /** 抓取目标：manual 任务由插件上报的起始页（type=page），agent 任务可从 params 回退推导；URL 已脱敏 */
                target: redactTaskTarget(resolveTaskTarget(task)),
                /** 插件解析后的真实数据集 id（AI 给的只是名字；早期失败/未解析时为 null） */
                datasetId: Number.isFinite(task.datasetId) ? task.datasetId : null,
                /** 数据集名：manual 任务只有插件上报才有（agent 可回退到 AI 请求名） */
                datasetName:
                    typeof task.datasetName === "string" && task.datasetName !== ""
                        ? task.datasetName
                        : typeof task.params?.datasetName === "string" && task.params.datasetName !== ""
                          ? task.params.datasetName
                          : null,
                /** 本任务目标总篇数（null = 旧版插件未上报，无法判断是否抓满） */
                targetArticles,
                /** 当前篇目序号（null = 旧版插件未上报） */
                currentArticle: Number.isFinite(task.currentArticle) ? task.currentArticle : null,
                seq: task.seq,
                processed,
                visibility: task.visibility,
                lastMessage: task.lastMessage ?? null,
                blocked: task.blocked,
                effectiveConfig: task.effectiveConfig,
                /**
                 * 本任务剩余目标：targetArticles − 已抓篇数。
                 * manual 任务与 agent 任务同口径（手工任务的目标由插件上报，不再恒为 0）。
                 * 目标未知（旧版插件）时兜底 0，保持历史语义——AI 侧按「已完成」处置，不引入 null。
                 */
                remaining:
                    targetArticles === null
                        ? 0
                        : Math.max(0, targetArticles - (Number.isFinite(processed?.articles) ? processed.articles : 0)),
                /** Broker 重启后从插件重播认领的任务（此时 createdAt 是认领时刻，不是真实开始时刻） */
                adopted: task.adoptedFromExtension === true,
                extensionTabId: task.extensionTabId,
                /**
                 * 孤儿信号（§8.1 / §6.3 / 详细设计 §2.2）：**全部活跃态**超过 60s 没有新消息 ⇒ 视为已失联，
                 * 插件稍后会自行恢复或转终态。只读回给 AI，便于其如实转述「任务似乎失联、
                 * 正在自愈」而不是把长时间静默当成正常推进。原先只判 running，会让冻结在
                 * 暂停态的旧记录静默失真。
                 */
                orphaned:
                    BROKER_ACTIVE_STATES.has(task.state) &&
                    now() - (task.updatedAt ?? task.createdAt ?? now()) > ORPHAN_TIMEOUT_MS,
                /** 进入当前状态的时刻：暂停态即停摆起点，终态即结束时刻 */
                stateChangedAt: Number.isFinite(task.stateChangedAt) ? task.stateChangedAt : null,
                /** 自账本记录创建以来的时长（活跃任务算到当下，终态算到 updatedAt） */
                durationMs: Math.max(
                    0,
                    (BROKER_TERMINAL_STATES.has(task.state) ? task.updatedAt ?? now() : now()) -
                        (task.createdAt ?? now())
                ),
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

/** 插件上报字段的长度上限（插件为受信对端，这里只防异常值把账本与响应撑大） */
const MAX_TARGET_VALUE_LEN = 2048;
const MAX_DATASET_NAME_LEN = 100;

/** 插件上报的抓取目标形状校验（`{ type, value }` 且两者皆非空字符串、长度受限） */
const TASK_TARGET_TYPES = new Set(["keyword", "noteUrl", "authorUrl", "page"]);

function isTaskTarget(value) {
    return (
        !!value &&
        typeof value === "object" &&
        TASK_TARGET_TYPES.has(value.type) &&
        typeof value.value === "string" &&
        value.value !== "" &&
        value.value.length <= MAX_TARGET_VALUE_LEN
    );
}

/**
 * 目标总篇数：插件上报的 total（钳制后真实目标）优先，回退 AI 请求的 articleLimit。
 * manual 任务认领时两者皆缺 → null，由插件首条 progress 补齐。
 */
function resolveTargetArticles(task) {
    if (Number.isFinite(task?.targetArticles) && task.targetArticles > 0) return task.targetArticles;
    return Number.isFinite(task?.params?.articleLimit) ? task.params.articleLimit : null;
}

/** 抓取目标：priority 插件上报（manual 的起始页 / agent 的解析结果），回退 AI 请求参数 */
function resolveTaskTarget(task) {
    if (isTaskTarget(task?.target)) return { type: task.target.type, value: task.target.value };
    if (typeof task?.params?.keyword === "string" && task.params.keyword !== "") {
        return { type: "keyword", value: task.params.keyword };
    }
    if (typeof task?.params?.noteUrl === "string" && task.params.noteUrl !== "") {
        return { type: "noteUrl", value: task.params.noteUrl };
    }
    if (typeof task?.params?.authorUrl === "string" && task.params.authorUrl !== "") {
        return { type: "authorUrl", value: task.params.authorUrl };
    }
    return null;
}

/** 出站剥离的访问令牌参数（与插件 toReportableUrl 同口径） */
const REPORT_STRIPPED_QUERY_KEYS = new Set(["xsec_token", "xsec_source"]);

function toReportableUrl(value) {
    try {
        const parsed = new URL(value);
        let changed = false;
        for (const key of [...parsed.searchParams.keys()]) {
            if (REPORT_STRIPPED_QUERY_KEYS.has(key)) {
                parsed.searchParams.delete(key);
                changed = true;
            }
        }
        return changed ? parsed.toString() : value;
    } catch {
        return value;
    }
}

/**
 * 快照出站脱敏：本地 task.params/target 保留导航所需的 token（Broker 重启后续抓），
 * 但对 AI 的响应不能带 xsec_token/xsec_source。
 */
function redactTaskParams(params) {
    if (!params || typeof params !== "object") return params;
    const copy = { ...params };
    for (const key of ["noteUrl", "authorUrl"]) {
        if (typeof copy[key] === "string") copy[key] = toReportableUrl(copy[key]);
    }
    return copy;
}

function redactTaskTarget(target) {
    if (!target) return target;
    if (target.type !== "noteUrl" && target.type !== "authorUrl" && target.type !== "page") return target;
    return { ...target, value: toReportableUrl(target.value) };
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
