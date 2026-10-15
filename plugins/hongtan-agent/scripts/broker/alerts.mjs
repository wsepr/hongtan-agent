/**
 * 告警监控（设计文档 §11.6）——把「会静默自愈的问题」升级为可归因告警。
 *
 * 设计意图：无人值守场景下「出错时无人看见」，因此 §11.6 明确列出五类须告警的情形。
 * 这里实现其中四类（第五类「Broker 掉线」只有 adapter 侧能观察到，见 mcp-server 的 /health 探测告警）：
 * 1. `extension_offline`：扩展连续离线超过阈值（默认 10 分钟）；
 * 2. `task_heartbeat_stall`：在跑任务超过阈值没有进度更新（Broker 视角的心跳超时）；
 * 3. `resume_exhausted`：任务恢复次数达上限（`RESUME_EXHAUSTED` 终态）；
 * 4. `connection_storm`：`kicked_old` 在窗口内高频出现（M2 开发期实测 40s 内 41 次，正式版须告警）。
 *
 * 告警落审计（`event: "alert"` + `kind`），并同时写日志；**去重**：同一任务的 stall、
 * 同一段离线只告警一次，避免刷屏（风暴类告警后重新计数）。
 *
 * 依赖注入 now/audit/logger，可单测。
 */

export const DEFAULT_ALERT_THRESHOLDS = {
    /** 扩展离线多久后告警（§11.6：>10 分钟） */
    extensionOfflineMs: 10 * 60 * 1000,
    /** 在跑任务多久没有进度更新算心跳超时（与插件侧 60s 孤儿判定不同：这里是上报链路视角） */
    taskStallMs: 5 * 60 * 1000,
    /** 连接风暴窗口与阈值（窗口内 `kicked_old` 达到该次数即告警） */
    kickedOldWindowMs: 60 * 1000,
    kickedOldCount: 5,
};

export function createAlertMonitor({ now = () => Date.now(), audit, logger = console, thresholds = {} } = {}) {
    const limits = { ...DEFAULT_ALERT_THRESHOLDS, ...thresholds };
    let extensionOfflineSince = null;
    let extensionOfflineAlerted = false;
    /** @type {number[]} */
    let kickedOldAt = [];
    /** @type {Set<string>} */
    const alertedStalled = new Set();

    function emit(kind, details = {}) {
        audit?.append("alert", { kind, ...details });
        logger.warn?.(`[broker][alert] ${kind}: ${JSON.stringify(details)}`);
    }

    return {
        /** 扩展（重新）握手成功 */
        noteExtensionConnected() {
            extensionOfflineSince = null;
            extensionOfflineAlerted = false;
        },
        /** 扩展连接断开（含被踢旧） */
        noteExtensionDisconnected() {
            if (extensionOfflineSince === null) extensionOfflineSince = now();
        },
        /** 每次发生「新连接踢旧」 */
        noteKickedOld() {
            const at = now();
            kickedOldAt.push(at);
            const cutoff = at - limits.kickedOldWindowMs;
            kickedOldAt = kickedOldAt.filter((ts) => ts >= cutoff);
            if (kickedOldAt.length >= limits.kickedOldCount) {
                emit("connection_storm", { count: kickedOldAt.length, windowMs: limits.kickedOldWindowMs });
                kickedOldAt = []; // 告警后重新计数：持续风暴按窗口重复告警，而不是每来一次刷一条
            }
        },
        /** 任务进入终态（从 stall 告警集合里摘除，避免同一 taskId 复用场景误报） */
        noteTaskSettled(taskId) {
            alertedStalled.delete(taskId);
        },
        /** 任务恢复次数耗尽 */
        noteResumeExhausted(taskId) {
            emit("resume_exhausted", { taskId });
        },
        /**
         * watchdog 周期调用（Broker 的 1 分钟 tick）。
         * @param {{activeTask?: {id: string, state: string, updatedAt?: number, createdAt?: number} | null}} ctx
         */
        tick({ activeTask = null } = {}) {
            const at = now();
            if (extensionOfflineSince !== null && !extensionOfflineAlerted && at - extensionOfflineSince >= limits.extensionOfflineMs) {
                extensionOfflineAlerted = true;
                emit("extension_offline", { offlineMs: at - extensionOfflineSince });
            }
            if (activeTask && activeTask.state === "running") {
                const last = activeTask.updatedAt ?? activeTask.createdAt ?? 0;
                if (at - last >= limits.taskStallMs && !alertedStalled.has(activeTask.id)) {
                    alertedStalled.add(activeTask.id);
                    emit("task_heartbeat_stall", { taskId: activeTask.id, silentMs: at - last });
                }
            }
        },
    };
}
