/**
 * Broker 自启与自愈（设计文档 §6.2「探测 /health，未运行则 spawn detached 拉起单例」/ §10.1）。
 *
 * 为什么抽成独立模块：原先 adapter（`mcp-server.mjs`）用「一次性 `ensurePromise`」缓存自启动结果，
 * 于是**失败结果也被永久缓存**——Broker 拉起失败一次之后，该进程此后每次工具调用都直接回
 * `BROKER_UNREACHABLE`，既不重新探测 `/health` 也不再重试拉起，用户唯一的出路是重启宿主；
 * 而 Broker 中途崩溃/被杀时，缓存的 `true` 让调用直接发请求、拿到 fetch 失败就收场，
 * 「Broker 掉线」这条告警（§11.6 第⑤类，由 adapter 侧 /health 探测承担）也再不会出现。
 * 这与 §6.2 的幂等自愈语义相反：拉起必须可重复、失败必须可重试。
 *
 * 语义：
 * - **成功**探测带 TTL（默认 5s）：避免每次工具调用都做一次本地往返；
 * - **失败从不缓存**：下一次 `ensure()` 立即重新探测并重试拉起；
 * - 单飞：并发的工具调用共享同一次拉起，不重复 spawn；
 * - `invalidate()`：请求失败（连接被拒）时清掉健康缓存，让下次调用重新探测 + 必要时拉起。
 *
 * 依赖注入（probeHealth / spawnBroker / delay / now），可单测。
 */

export const DEFAULT_HEALTH_TTL_MS = 5_000;
export const DEFAULT_SPAWN_ATTEMPTS = 30;
export const DEFAULT_SPAWN_INTERVAL_MS = 500;

export function createBrokerLauncher({
    probeHealth,
    spawnBroker,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    logger = console,
    healthTtlMs = DEFAULT_HEALTH_TTL_MS,
    spawnAttempts = DEFAULT_SPAWN_ATTEMPTS,
    spawnIntervalMs = DEFAULT_SPAWN_INTERVAL_MS,
} = {}) {
    let healthyUntil = 0;
    /** @type {Promise<boolean> | null} */
    let inFlight = null;

    async function runEnsure() {
        if (await probeHealth()) {
            healthyUntil = now() + healthTtlMs;
            return true;
        }
        logger.warn?.("[adapter] Broker 未运行，spawn detached 拉起单例…");
        try {
            spawnBroker();
        } catch (e) {
            logger.error?.("[adapter] spawn Broker 失败:", e?.message ?? e);
            return false;
        }
        for (let i = 0; i < spawnAttempts; i += 1) {
            await delay(spawnIntervalMs);
            if (await probeHealth()) {
                healthyUntil = now() + healthTtlMs;
                logger.warn?.("[adapter] Broker 已就绪");
                return true;
            }
        }
        const waitedSec = Math.round((spawnAttempts * spawnIntervalMs) / 1000);
        logger.error?.(`[adapter] Broker 拉起失败（${waitedSec}s 内 /health 不可达）`);
        return false;
    }

    return {
        /** @returns {Promise<boolean>} Broker 当前可用（必要时拉起并等待就绪） */
        async ensure() {
            if (now() < healthyUntil) return true;
            if (inFlight) return inFlight;
            inFlight = runEnsure().finally(() => {
                // 失败不缓存：下次 ensure 重新探测并重试拉起（这正是旧实现缺失的自愈）
                inFlight = null;
            });
            return inFlight;
        },

        /** 请求失败（连接被拒）后调用：清掉健康缓存，让下次调用重新探测 */
        invalidate() {
            healthyUntil = 0;
        },

        isHealthy() {
            return now() < healthyUntil;
        },
    };
}
