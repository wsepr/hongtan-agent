/**
 * 只读会话快照（详细设计 §2.1）——离线时回答「上次在线看到的数据集与会话摘要」。
 *
 * - `session` 段与 `datasets` 段各自维护独立时间戳（sessionUpdatedAt / refreshedAt）：
 *   「仅 hello 成功」不得把数据集段的陈旧度刷掉（数据集靠主动 list 刷新，两者失效时机不同）；
 * - extId 不匹配（换浏览器 / 重装插件）或超 TTL → 一律 null（宁可不答，不给旧数据）；
 * - 原子写（tmp + rename，与 task-store.persist 同法）；读损坏 → null（不抛）；写失败只 warn。
 *
 * 依赖注入（fs/now/logger），可单测。
 */

import fs from "node:fs";
import path from "node:path";

export const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export function createSessionSnapshotStore({
    filePath,
    fsImpl = fs,
    now = () => Date.now(),
    ttlMs = DEFAULT_SNAPSHOT_TTL_MS,
    logger = console,
} = {}) {
    /** 整份读取；首次启动/文件损坏一律返回 null（不抛，避免读路径把主链路带崩） */
    function readAll() {
        if (!filePath) return null;
        try {
            const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    function persist(data) {
        if (!filePath) return;
        try {
            fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
            const tmp = `${filePath}.tmp`;
            fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fsImpl.renameSync(tmp, filePath);
        } catch (e) {
            logger.warn?.("[snapshot] 会话快照落盘失败:", e?.message ?? e);
        }
    }

    return {
        /** 合并写 session 段 + sessionUpdatedAt（不动 datasets 段与其陈旧度） */
        writeSession({ extId = null, browserFamily = null, vip = null, quota = null, lastSeenAt = null } = {}) {
            const current = readAll() ?? {};
            persist({
                ...current,
                extId: extId ?? current.extId ?? null,
                browserFamily: browserFamily ?? current.browserFamily ?? null,
                session: { vip: vip ?? null, quota: quota ?? null, lastSeenAt: lastSeenAt ?? now() },
                sessionUpdatedAt: now(),
            });
        },

        /** 覆盖 datasets 段 + refreshedAt（不动 session 段与其陈旧度） */
        writeDatasets(datasets) {
            const current = readAll() ?? {};
            persist({
                ...current,
                datasets: Array.isArray(datasets) ? datasets : [],
                refreshedAt: now(),
            });
        },

        /** @returns {null | { datasets: any[], cachedAt: number }} extId 不匹配 / 超 TTL → null */
        readDatasets({ extId = null } = {}) {
            const data = readAll();
            if (!data || data.extId !== extId) return null;
            if (!Number.isFinite(data.refreshedAt) || now() - data.refreshedAt > ttlMs) return null;
            return { datasets: data.datasets ?? [], cachedAt: data.refreshedAt };
        },

        /** @returns {null | { session: any, extId: string|null, browserFamily: string|null, cachedAt: number }} 判据同 readDatasets，用 sessionUpdatedAt */
        readSession({ extId = null } = {}) {
            const data = readAll();
            if (!data || data.extId !== extId) return null;
            if (!Number.isFinite(data.sessionUpdatedAt) || now() - data.sessionUpdatedAt > ttlMs) return null;
            return {
                session: data.session ?? null,
                extId: data.extId ?? null,
                browserFamily: data.browserFamily ?? null,
                cachedAt: data.sessionUpdatedAt,
            };
        },

        /** 诊断（/health.snapshot） */
        getStatus() {
            const data = readAll();
            return {
                exists: !!data,
                extId: data?.extId ?? null,
                refreshedAt: data?.refreshedAt ?? null,
                sessionUpdatedAt: data?.sessionUpdatedAt ?? null,
                datasetCount: Array.isArray(data?.datasets) ? data.datasets.length : 0,
            };
        },
    };
}
