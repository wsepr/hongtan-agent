/**
 * 任务配额（设计文档 §10.5）——最小启动间隔 + 24h 任务数上限。
 * 超限返回 QUOTA_EXCEEDED。Phase 1 为内存态（Broker 重启后重置，已记录于 SECURITY.md）。
 */

export function createQuota({
    now = () => Date.now(),
    minIntervalMs = 10 * 60 * 1000,
    maxPer24h = 24,
} = {}) {
    let lastStartAt = 0;
    /** @type {number[]} */
    const startTimestamps = [];

    function prune() {
        const cutoff = now() - 24 * 60 * 60 * 1000;
        while (startTimestamps.length && startTimestamps[0] <= cutoff) startTimestamps.shift();
    }

    return {
        /** @returns {{ok: true} | {ok: false, reason: "QUOTA_EXCEEDED", message: string, retryAfterMs?: number}} */
        checkAndRecord() {
            const t = now();
            prune();
            if (lastStartAt > 0 && t - lastStartAt < minIntervalMs) {
                return {
                    ok: false,
                    reason: "QUOTA_EXCEEDED",
                    message: `距上次启动不足 ${Math.round(minIntervalMs / 60000)} 分钟（防风控暴露面），请 ${Math.ceil((minIntervalMs - (t - lastStartAt)) / 60000)} 分钟后再试`,
                    retryAfterMs: minIntervalMs - (t - lastStartAt),
                };
            }
            if (startTimestamps.length >= maxPer24h) {
                return {
                    ok: false,
                    reason: "QUOTA_EXCEEDED",
                    message: `24 小时内任务数已达上限（${maxPer24h}）`,
                };
            }
            lastStartAt = t;
            startTimestamps.push(t);
            return { ok: true };
        },
    };
}
