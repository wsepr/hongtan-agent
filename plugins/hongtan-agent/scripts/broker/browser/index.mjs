/**
 * 浏览器可用性管理（设计文档 §10.7 环③）——Broker 独占的幂等拉起能力。
 *
 * 硬性要求（M2 实证）：浏览器生命周期必须由 detached Broker 持有——宿主/工具会话
 * 派生的浏览器会随会话回收被整体终止（WS close=1006）。spawn detached + unref。
 *
 * 引导期固化（层 4）：扩展上报家族 → 解析 exe + 反查 profile → 写 browser.json；
 * 运行期只读配置零探测；spawn error 事件（路径漂移）触发一次性重探。
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

    /** 引导期解析（层 2 exe + 层 3 profile） */
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

        let profileResult = { ok: false, message: "未找到 User Data 根" };
        for (const root of userDataRootCandidates(family, platform, env)) {
            if (!joined.pathExists(root)) continue;
            profileResult = resolveProfile({
                userDataRoot: root,
                extId,
                joinPath: joined.joinPath,
                listDirectories: joined.listDirectories,
                pathExists: joined.pathExists,
            });
            if (profileResult.ok) {
                profileResult.userDataRoot = root;
                break;
            }
        }
        if (!profileResult.ok) return { ok: false, code: "PROFILE_UNRESOLVABLE", message: profileResult.message };

        return {
            ok: true,
            config: {
                family,
                extId,
                exe: exeResult.kind === "exe" ? exeResult.exe : null,
                kind: exeResult.kind,
                bundleId: exeResult.bundleId ?? null,
                source: exeResult.source ?? null,
                profileDir: profileResult.profileDir,
                userDataRoot: profileResult.userDataRoot,
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

        /** 引导期解析并固化配置（层 2/3/4）。成功后运行期零探测。 */
        ensureResolved() {
            const config = readConfig();
            if (!config?.family || !config?.extId) {
                return { ok: false, message: "浏览器家族/extId 未记录（等待扩展 hello）" };
            }
            if (config.profileDir && (config.exe || config.kind === "open-b")) {
                return { ok: true, config };
            }
            const resolved = resolveAll({ family: config.family, extId: config.extId });
            if (!resolved.ok) return resolved;
            writeConfig({ ...config, ...resolved.config });
            audit?.append("browser_resolved", resolved.config);
            return { ok: true, config: { ...config, ...resolved.config } };
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
