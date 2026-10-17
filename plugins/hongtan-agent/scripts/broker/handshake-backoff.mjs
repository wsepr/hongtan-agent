/**
 * 协议外/旧协议客户端的握手退避（抓取 + 硬化）。
 *
 * 为什么单独成模块：退避要按 extId 维护「窗口内失败计数 + 冷却期」，且必须能注入时钟做
 * 确定性单测；把它塞进 alerts.mjs 会让「告警器」同时承担限流状态，职责混乱。
 * 这里的判定结果由调用方拿去 emit 告警（`alerts.noteLegacyProtocolClient`），本模块不碰 audit。
 *
 * 只统计**协议外失败**：hello 前的未识别帧（含裸 `{type:"hello"}`）与 5s hello 超时。
 * 不统计 `PROTOCOL_VERSION_MISMATCH`——那是有明确信号、可由任一侧升级修复的受支持失败，
 * 计入退避会在灰度期误伤正常客户端。
 */

/** 默认参数与 §11.6 `connection_storm` 的口径一致（窗口 60s / 阈值 5 次） */
export const DEFAULT_HANDSHAKE_BACKOFF = {
    windowMs: 60_000,
    threshold: 5,
    cooldownMs: 5 * 60_000,
};

/** 无 Origin 时的回退键：WS 服务端允许空 Origin（curl 等调试工具），不能让它们共用一个空键 */
const NO_ORIGIN_KEY = "<no-origin>";

const ORIGIN_PREFIX = "chrome-extension://";

/**
 * 从 upgrade 请求的 Origin 头推出 extId。Origin 校验（`isAllowedWebSocketOrigin`）保证它要么为空、
 * 要么是 `chrome-extension://<extId>`，因此这里不需要再校验合法性。
 * @param {string | undefined | null} origin
 * @returns {string} 空 Origin 时返回 ""（退避内部按 NO_ORIGIN_KEY 归一）
 */
export function extIdFromOrigin(origin) {
    const normalized = String(origin ?? "").trim();
    return normalized.startsWith(ORIGIN_PREFIX) ? normalized.slice(ORIGIN_PREFIX.length) : "";
}

function normalizeKey(extId) {
    const key = typeof extId === "string" ? extId.trim() : "";
    return key || NO_ORIGIN_KEY;
}

/**
 * @param {{ now?: () => number, windowMs?: number, threshold?: number, cooldownMs?: number }} [deps]
 */
export function createHandshakeBackoff({ now = () => Date.now(), windowMs, threshold, cooldownMs } = {}) {
    const limits = {
        windowMs: windowMs ?? DEFAULT_HANDSHAKE_BACKOFF.windowMs,
        threshold: threshold ?? DEFAULT_HANDSHAKE_BACKOFF.threshold,
        cooldownMs: cooldownMs ?? DEFAULT_HANDSHAKE_BACKOFF.cooldownMs,
    };
    /** @type {Map<string, number[]>} extId → 窗口内失败时刻 */
    const failures = new Map();
    /** @type {Map<string, number>} extId → 冷却截止时刻 */
    const blockedUntil = new Map();

    return {
        /**
         * 记一次协议外握手失败。
         * @param {string} extId
         * @returns {boolean} 达到阈值（并已进入冷却）时为 true —— 调用方据此 emit 告警
         */
        noteFailure(extId) {
            const key = normalizeKey(extId);
            const at = now();
            const recent = (failures.get(key) ?? []).filter((ts) => at - ts < limits.windowMs);
            recent.push(at);
            if (recent.length >= limits.threshold) {
                // 告警后重新计数（与 connection_storm 同：持续风暴按窗口重复告警，而不是每来一次刷一条）
                failures.set(key, []);
                blockedUntil.set(key, at + limits.cooldownMs);
                return true;
            }
            failures.set(key, recent);
            return false;
        },
        /**
         * 冷却期内为 true —— 供 upgrade 阶段在建立会话之前拒连。
         * @param {string} extId
         */
        isBlocked(extId) {
            const key = normalizeKey(extId);
            const until = blockedUntil.get(key);
            if (until === undefined) return false;
            if (now() >= until) {
                blockedUntil.delete(key);
                return false;
            }
            return true;
        },
        /** 调试/自检快照（供 /health 或排查用） */
        snapshot() {
            const at = now();
            const counts = {};
            for (const [key, times] of failures) {
                const recent = times.filter((ts) => at - ts < limits.windowMs).length;
                if (recent > 0) counts[key] = recent;
            }
            const blockedExtIds = [...blockedUntil.entries()].filter(([, until]) => at < until).map(([key]) => key);
            return { blockedExtIds, counts };
        },
    };
}
