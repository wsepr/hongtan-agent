/**
 * action 级限流（设计文档 §10.5 / 执行计划 S11）。
 *
 * 与「任务节奏配额」（插件侧冷却债，§10.5）互补，管的不是同一件事：
 * - 配额管**抓取启动**的风控暴露面（按上次任务请求量折算的冷却债 + 24h 上限，判定在插件侧）；
 * - 本模块管**工具调用频率**——AI 紧密轮询 `xhs_task_status`、或反复试错参数时，
 *   会以读操作占满会话并放大插件侧无谓负载。
 *
 * 滑窗按 action 独立计数（各工具互不牵连）；窗口内超限返回 RATE_LIMITED，
 * 并在 Retry-After 语义上告知还需等待多久。
 *
 * 依赖注入 now，可单测。
 */

const DEFAULT_WINDOW_MS = 60_000;

export function createActionLimiter({ now = () => Date.now(), perMinute = {}, defaultPerMinute = 60, windowMs = DEFAULT_WINDOW_MS } = {}) {
    /** @type {Map<string, number[]>} action → 窗口内调用时间戳 */
    const hits = new Map();

    /** 未配置 → 默认值；配置为非正数 → 显式不限流 */
    function limitFor(action) {
        const configured = perMinute[action];
        if (configured === undefined || configured === null) return defaultPerMinute;
        return Number.isFinite(configured) ? configured : defaultPerMinute;
    }

    function prune(action, cutoff) {
        const list = hits.get(action);
        if (!list) return [];
        while (list.length && list[0] <= cutoff) list.shift();
        return list;
    }

    return {
        /**
         * @returns {{ok: true, remaining: number} | {ok: false, reason: "RATE_LIMITED", message: string, retryAfterMs: number}}
         */
        check(action) {
            const t = now();
            const limit = limitFor(action);
            if (limit <= 0) return { ok: true, remaining: Number.POSITIVE_INFINITY };
            const list = prune(action, t - windowMs);
            if (list.length >= limit) {
                const retryAfterMs = Math.max(1, list[0] + windowMs - t);
                return {
                    ok: false,
                    reason: "RATE_LIMITED",
                    message: `工具 ${action} 调用过于频繁（${Math.round(windowMs / 1000)} 秒内上限 ${limit} 次），请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试`,
                    retryAfterMs,
                };
            }
            list.push(t);
            if (!hits.has(action)) hits.set(action, list);
            return { ok: true, remaining: limit - list.length };
        },
        /** 供 /health 与单测读取当前窗口计数 */
        count(action) {
            return prune(action, now() - windowMs).length;
        },
    };
}
