/**
 * 浏览器可用性管理（设计文档 §10.7 环③）——Broker 独占的幂等拉起能力。
 *
 * 硬性要求（M2 实证）：浏览器生命周期必须由 detached Broker 持有——宿主/工具会话
 * 派生的浏览器会随会话回收被整体终止（WS close=1006）。spawn detached + unref。
 *
 * 引导期固化（层 4）：扩展上报家族 → 解析 exe + profile 三层回退（精确反查 → last_used → 裸拉起，
 * v2.10）→ 写 browser.json；运行期只读配置零探测；spawn error 事件（路径漂移）触发一次性重探。
 */

import fs from "node:fs";
import path from "node:path";
import { isKnownFamily, userDataRootCandidates } from "./family-table.mjs";
import { resolveExe } from "./resolve-exe.mjs";
import { resolveProfile } from "./resolve-profile.mjs";
import { buildLaunchCommand, LAUNCH_DEBOUNCE_MS } from "./launch-command.mjs";

export function createBrowserManager({
    configPath,
    platform = process.platform,
    env = process.env,
    probes = {},
    spawnImpl,
    fsImpl = fs,
    audit,
    logger = console,
    now = () => Date.now(),
} = {}) {
    const joined = {
        joinPath: probes.joinPath ?? path.join,
        listDirectories: probes.listDirectories,
        pathExists: probes.pathExists ?? ((p) => fsImpl.existsSync(p)),
        fileExists: probes.fileExists ?? ((p) => fsImpl.existsSync(p)),
        queryAppPath: probes.queryAppPath,
        queryDefaultBrowserCommand: probes.queryDefaultBrowserCommand,
        lastUsedProfile: probes.lastUsedProfile,
    };

    function readConfig() {
        try {
            return JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
        } catch {
            return null;
        }
    }

    function writeConfig(config) {
        try {
            fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
            fsImpl.writeFileSync(configPath, JSON.stringify(config, null, 2));
            return true;
        } catch (e) {
            logger.warn?.("[browser] 配置写入失败:", e?.message ?? e);
            return false;
        }
    }

    /** 引导期解析（层 2 exe + 层 3 profile）。v2.10：profile 反查改为三层回退——
     *  Extensions/<extId> 精确反查（商店安装）→ Local State 的 profile.last_used（开发者模式 unpacked
     *  扩展在 Extensions 下无目录，精确反查必然失败）→ 裸拉起（profileDir=null，不带
     *  --profile-directory，浏览器按最近使用 profile 启动）。exe 解析失败仍是唯一硬失败
     *  （BROWSER_UNRESOLVABLE）。 */
    function resolveAll({ family, extId }) {
        if (!isKnownFamily(family)) {
            return { ok: false, message: `未知浏览器家族: ${family}（扩展上报非法或 unknown）` };
        }
        const exeResult = resolveExe({
            family,
            queryAppPath: joined.queryAppPath,
            queryDefaultBrowserCommand: joined.queryDefaultBrowserCommand,
            fileExists: joined.fileExists,
            env,
            platform,
        });
        if (!exeResult.ok) return exeResult;

        let profileDir = null;
        let profileSource = "bare-launch";
        let userDataRoot = null;
        let lastUsedHit = null;
        for (const root of userDataRootCandidates(family, platform, env)) {
            if (!joined.pathExists(root)) continue;
            const profileResult = resolveProfile({
                userDataRoot: root,
                extId,
                joinPath: joined.joinPath,
                listDirectories: joined.listDirectories,
                pathExists: joined.pathExists,
            });
            if (profileResult.ok) {
                profileDir = profileResult.profileDir;
                profileSource = profileResult.source;
                userDataRoot = root;
                break;
            }
            if (!lastUsedHit) {
                const used = joined.lastUsedProfile?.(root) ?? null;
                if (used && joined.pathExists(joined.joinPath(root, used))) {
                    lastUsedHit = { profileDir: used, root };
                }
            }
        }
        if (profileDir === null && lastUsedHit) {
            profileDir = lastUsedHit.profileDir;
            profileSource = "last-used";
            userDataRoot = lastUsedHit.root;
        }
        audit?.append("browser_profile_resolved", { family, extId, profileDir, profileSource });

        return {
            ok: true,
            config: {
                family,
                extId,
                exe: exeResult.kind === "exe" ? exeResult.exe : null,
                kind: exeResult.kind,
                bundleId: exeResult.bundleId ?? null,
                source: exeResult.source ?? null,
                profileDir,
                userDataRoot,
                resolvedAt: now(),
            },
        };
    }

    let lastLaunchAt = 0;
    let launchCount = 0;

    return {
        /** extension.hello 时记录扩展上报的家族与 extId（层 1；引导期第 1 步） */
        recordExtension({ family, extId }) {
            const config = readConfig();
            if (config && config.family === family && config.extId === extId) return config;
            const next = { ...(config ?? {}), family, extId, recordedAt: now() };
            writeConfig(next);
            audit?.append("browser_recorded", { family, extId });
            return next;
        },

        /** 引导期解析并固化配置（层 2/3/4）。成功后运行期零探测。
         *  v2.10：profile 反查失败不再阻塞固化——exe 解析成功即固化（profileDir 可为 null = 裸拉起）。 */
        ensureResolved() {
            const config = readConfig();
            if (!config?.family || !config?.extId) {
                return { ok: false, message: "浏览器家族/extId 未记录（等待扩展 hello）" };
            }
            if ((config.exe || config.kind === "open-b") && (config.profileResolved || config.profileDir)) {
                return { ok: true, config };
            }
            const resolved = resolveAll({ family: config.family, extId: config.extId });
            if (!resolved.ok) return resolved;
            writeConfig({ ...config, ...resolved.config, profileResolved: true });
            audit?.append("browser_resolved", resolved.config);
            return { ok: true, config: { ...config, ...resolved.config, profileResolved: true } };
        },

        /**
         * 幂等拉起（运行期）。已运行时等效开窗；30s 防抖；spawn error 一次性重探。
         * @param {{url?: string|null, reason?: string}} options
         */
        ensureRunning({ url = null, reason = "extension-offline" } = {}) {
            const t = now();
            if (t - lastLaunchAt < LAUNCH_DEBOUNCE_MS) {
                logger.info?.("[browser] 防抖期内，跳过重复拉起（已运行时拉起等效开窗）");
                return { ok: true, skipped: true };
            }
            lastLaunchAt = t;

            const ready = this.ensureResolved();
            if (!ready.ok) {
                audit?.append("browser_launch_error", { message: ready.message, reason });
                return ready;
            }
            const command = buildLaunchCommand({
                resolvedExe: { ok: true, kind: ready.config.kind, exe: ready.config.exe, bundleId: ready.config.bundleId },
                profileDir: ready.config.profileDir,
                url,
            });
            if (!command.ok) {
                audit?.append("browser_launch_error", { message: command.message, reason });
                return command;
            }

            const doSpawn = (file, args) => {
                const child = spawnImpl(file, args, { detached: true, stdio: "ignore", windowsHide: true });
                // spawn 对不存在/不可执行的路径不抛同步异常，而是异步发 error 事件——
                // 必须监听，否则崩掉整个 Broker（demo 教训）
                child.on("error", (e) => {
                    logger.warn?.("[browser] spawn error:", e?.message ?? e);
                    audit?.append("browser_spawn_error", { message: e?.message ?? String(e) });
                });
                child.unref();
                return child;
            };

            try {
                doSpawn(command.command.file, command.command.args);
                launchCount += 1;
                audit?.append("browser_launch", {
                    family: ready.config.family,
                    profile: ready.config.profileDir,
                    url: url ?? "(blank)",
                    reason,
                });
                return { ok: true, skipped: false };
            } catch (e) {
                audit?.append("browser_launch_error", { message: e?.message ?? String(e), reason });
                return { ok: false, message: e?.message ?? String(e) };
            }
        },

        getStatus() {
            return { launchCount, lastLaunchAt, config: readConfig() };
        },
    };
}
