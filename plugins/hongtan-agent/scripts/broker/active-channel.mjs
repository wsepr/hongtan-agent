/**
 * 独占通道租约（Active Channel Lease）——本机同一时刻只有一个浏览器接管红探。
 *
 * 为什么需要：原先 `handleHello` 无条件踢掉旧连接，谁最后连上谁赢。用户在 Edge 里
 * 正常采集时，只要打开 Chrome（它也装了红探并开了接管），就会把 Edge 挤下线，
 * 且被挤掉的一方 1 秒后重连再挤回去——实测 8 分钟 26 次 hello 翻转。
 *
 * 语义：
 * - 租约是**用户显式授予**的：无占用者时首个 hello 即占用（开关本身是显式动作）；
 *   已有占用者时必须带 `takeover` 才能转移，否则回 `session.occupied` + close(4004)。
 * - 占用者**离线也受保护**：休眠/Service Worker 回收造成的短暂离线不应触发抢占，
 *   待机方仍需用户点一次「立即启用」。
 * - `online` 由 `lastSeenAt` 推导，不落盘——进程崩溃重启后不会留下"假在线"。
 */

import fs from "node:fs";
import path from "node:path";

export const ACTIVE_CHANNEL_FILE = "active-channel.json";
/**
 * 租约文件结构版本。字段随独占通道一起增长（channelKey/family/extId/since/lastSeenAt/
 * approved/approvedAt），没有版本号就无法在改结构后识别旧文件。未知版本一律按"无租约"
 * 处理——宁可让用户重新占用一次，也不要误读一个语义已经变了的旧状态。
 */
export const LEASE_FILE_VERSION = 1;
/** 与 hello 新鲜度同口径：90s 内有过消息即视为在线 */
export const ONLINE_WINDOW_MS = 90_000;
/** 心跳 20s 一次；只需让"是否在线"在跨进程重启后大致可信，不必跟着心跳落盘 */
const PERSIST_THROTTLE_MS = 60_000;

/**
 * 通道标识：新插件上报 `channelKey`（家族 + 实例 id）；旧插件没有该字段时退化为家族，
 * 保证 N-1 兼容（Edge / Chrome 依然能区分，只是同浏览器的多 profile 无法区分——P2 再补实例 id）。
 */
export function channelKeyOf(msg) {
    const explicit = typeof msg?.channelKey === "string" ? msg.channelKey.trim() : "";
    if (explicit) return explicit;
    const family = typeof msg?.browserFamily === "string" && msg.browserFamily ? msg.browserFamily : "unknown";
    return `family:${family}`;
}

export function createActiveChannelStore({
    filePath,
    now = () => Date.now(),
    fsImpl = fs,
    onlineWindowMs = ONLINE_WINDOW_MS,
    persistThrottleMs = PERSIST_THROTTLE_MS,
    logger = console,
} = {}) {
    /** @type {{channelKey: string, family: string|null, extId: string|null, since: number, lastSeenAt: number} | null} */
    let lease = readFromDisk();
    let lastPersistAt = 0;

    function readFromDisk() {
        try {
            const raw = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            if (!raw || typeof raw.channelKey !== "string") return null;
            // 旧文件没有 version（undefined）视为当前版本；显式写了别的版本 → 当作无租约
            if (raw.version != null && raw.version !== LEASE_FILE_VERSION) return null;
            return {
                channelKey: raw.channelKey,
                family: typeof raw.family === "string" ? raw.family : null,
                extId: typeof raw.extId === "string" ? raw.extId : null,
                since: Number(raw.since) || now(),
                lastSeenAt: Number(raw.lastSeenAt) || 0,
                approved: typeof raw.approved === "boolean" ? raw.approved : null,
                approvedAt: Number(raw.approvedAt) || null,
            };
        } catch {
            return null;
        }
    }

    function persist(force = true) {
        if (!force && now() - lastPersistAt < persistThrottleMs) return false;
        try {
            fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
            if (lease === null) {
                fsImpl.rmSync?.(filePath, { force: true });
            } else {
                // 与 device-identity.json 一致：会话信息（谁在用、何时批准）不对同机其他用户开放
                fsImpl.writeFileSync(filePath, JSON.stringify({ version: LEASE_FILE_VERSION, ...lease }, null, 2), {
                    mode: 0o600,
                });
                // 覆盖写不会重新应用 mode，补一次。注意用 chmodSync：
                // node:fs 的异步 chmod 要求 callback（传两个参数会同步抛 "cb argument must be a function"），
                // 且 Windows 上可能不支持——两种情况都不该让整次落盘失败。
                try {
                    fsImpl.chmodSync?.(filePath, 0o600);
                } catch {
                    /* 权限收紧是尽力而为 */
                }
            }
            lastPersistAt = now();
            return true;
        } catch (e) {
            logger.warn?.("[channel] 租约写入失败:", e?.message ?? e);
            return false;
        }
    }

    function describe() {
        if (!lease) return null;
        return { ...lease, online: now() - lease.lastSeenAt <= onlineWindowMs };
    }

    /**
     * 对外视图（/health、session.occupied、connection_status 用）：
     * **不含 channelKey**。通道标识是"谁是占用者"的唯一凭据，只用于服务端比对，
     * 一旦随状态响应外泄，任何本机进程都能冒充占用者去调 reset，凭据就白设了。
     */
    function describePublic() {
        if (!lease) return null;
        return {
            family: lease.family,
            since: lease.since,
            lastSeenAt: lease.lastSeenAt,
            online: now() - lease.lastSeenAt <= onlineWindowMs,
        };
    }

    return {
        filePath,

        /** 当前租约（含推导出的 online 与 channelKey）；无占用者返回 null —— 仅服务端内部用 */
        describe,
        /** 对外脱敏视图（无 channelKey） */
        describePublic,

        /** 占用者是否为指定通道 */
        isOccupiedBy(channelKey) {
            return !!lease && lease.channelKey === channelKey;
        },

        /**
         * 授予/续期租约。同一通道重连保留 `since`（"什么时候开始用的"不应被刷新重新计时）；
         * **换 channelKey 视为新通道**，`since` 会重新计时（标识轮换后 UI 的"已连接 X 分钟"会归零，
         * 这是有意的：对使用者而言确实换了一条通道）。
         *
         * `approved` 会**覆盖**为本次 hello 的批准态，因此调用方要在 claim 之前读取
         * `describe().approved` 作为"上一次批准态"——撤销判定就靠这个比较，
         * 不能依赖内存里的 extensionSession（真实撤销是"先关后连"，届时会话已置空）。
         * @returns {object} 最新租约
         */
        claim({ channelKey, family = null, extId = null, approved = null }) {
            const at = now();
            if (lease && lease.channelKey === channelKey) {
                lease.lastSeenAt = at;
                lease.family = family ?? lease.family;
                lease.extId = extId ?? lease.extId;
            } else {
                lease = { channelKey, family, extId, since: at, lastSeenAt: at, approved: null, approvedAt: null };
            }
            if (typeof approved === "boolean") {
                // approvedAt 只在"由未批准转为已批准"时刷新；撤销后保留历史时间便于排障
                if (approved && lease.approved !== true) lease.approvedAt = at;
                lease.approved = approved;
            }
            persist();
            return { ...lease };
        },

        /** 心跳/任意消息刷新在线时间（节流落盘，内存值始终最新） */
        touch() {
            if (!lease) return;
            lease.lastSeenAt = now();
            persist(false);
        },

        /** 主动让出（占用者关闭开关）或重置幽灵占用；返回是否真有租约被清掉 */
        release() {
            if (!lease) return false;
            lease = null;
            persist();
            return true;
        },
    };
}
