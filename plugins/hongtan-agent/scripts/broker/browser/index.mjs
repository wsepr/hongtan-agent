/**
 * 浏览器可用性管理（设计文档 §10.7 环③；《常驻工作区设计方案》§5.2）——Broker 独占的幂等拉起能力。
 *
 * 硬性要求（M2 实证）：浏览器生命周期必须由 detached Broker 持有——宿主/工具会话
 * 派生的浏览器会随会话回收被整体终止（WS close=1006）。spawn detached + unref。
 *
 * 引导期固化（层 4）：扩展上报家族 → 解析 exe + profile 三层回退（精确反查 → last_used → 裸拉起，
 * v2.10）→ 写 browser.json；运行期只读配置零探测；spawn error 事件（路径漂移）触发一次性重探。
 *
 * 拉起前置判定（P2）：扩展最近吻痕（≤60s → 浏览器必然在运行）→ OS 进程探测（win32）——
 * 任一命中即 skip spawn（审计 browser_launch_skipped）；skip 后为该任务调度 30s 升级定时器：
 * 到期扩展仍未回连（且仍有等待中的任务）才强制拉起一次（审计 browser_launch_escalated，每任务封顶）——
 * 既避开探测器假阳性（Edge 后台/更新进程在、扩展实际不可达），又保住 90s 截止内的冷启动预算。
 */

import fs from "node:fs";
import path from "node:path";
import { isKnownFamily, userDataRootCandidates } from "./family-table.mjs";
import { resolveExe } from "./resolve-exe.mjs";
import { resolveProfile } from "./resolve-profile.mjs";
import { buildLaunchCommand, LAUNCH_DEBOUNCE_MS } from "./launch-command.mjs";
import { mergeChildEnvironment } from "./child-env.mjs";
import { activateWindowOS as activateWindowOSPlatform } from "./activate-window.mjs";

/** 扩展「最近吻痕」窗口：≤60s 时跳过无谓拉起（WS 刚断的典型场景，alarms 会在 ≤30s 内重连） */
const RECENT_CONTACT_MS = 60_000;
/** skip 后的升级等待：到期仍无回连才强制拉起（保证 90s 截止前仍有 ≥60s 冷启动预算） */
const ESCALATION_DELAY_MS = 30_000;
/** 已完成升级的门控键集合上限（防泄漏；门控键全局唯一，超限整表清理即可） */
const ESCALATED_KEY_CAP = 500;

export function createBrowserManager({
    configPath,
    platform = process.platform,
    env = process.env,
    probes = {},
    spawnImpl,
    /** 前台化 helper 用的捕获型 spawn（可注入；缺省由 activate-window 模块自带实现） */
    spawnCapture,
    fsImpl = fs,
    audit,
    logger = console,
    now = () => Date.now(),
    /** 扩展最近消息时间戳（broker-server 注入；0 = 从未连过） */
    getExtensionLastSeenAt = () => 0,
    /** 升级放行门控（broker-server 注入）。收 `{taskId, waitKey}`：
     *  有 taskId ⇒ 该任务仍停留在 launching_browser/waiting_extension 才放行；
     *  无 taskId（环境等待）⇒ 只要带 waitKey 就允许升级一次（每 key 由本模块封顶）。
     *  按 taskId/门控键判定——过期升级定时器不得在另一个任务的等待期用旧 URL 拉起。 */
    shouldEscalate = () => true,
    setTimeoutImpl = setTimeout,
} = {}) {
    const joined = {
        joinPath: probes.joinPath ?? path.join,
        listDirectories: probes.listDirectories,
        pathExists: probes.pathExists ?? ((p) => fsImpl.existsSync(p)),
        fileExists: probes.fileExists ?? ((p) => fsImpl.existsSync(p)),
        queryAppPath: probes.queryAppPath,
        queryDefaultBrowserCommand: probes.queryDefaultBrowserCommand,
        lastUsedProfile: probes.lastUsedProfile,
        readSystemEnvironment: probes.readSystemEnvironment,
        // 注意：probes 是白名单合入——新探针不加进这里在真实装配中永远不可达；
        // 这里的键名还必须与 createOsProbes 的方法名逐字一致（曾因两处命名不同，last-used 回退在生产静默失效，单测因注入桩而抓不到）
        isBrowserProcessRunning: probes.isBrowserProcessRunning,
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
                /**
                 * 本次解析**针对哪个家族/扩展 ID**。为什么要单独记：config.family 会被
                 * `recordExtension` 随每次 hello 覆盖，而 exe/profileDir 是解析产物——
                 * 只看 "exe 非空 + profileResolved" 会把上一家族的 exe 当成有效值，
                 * 于是用户从 Edge 迁到 Chrome 后，离线拉起仍然打开 Edge。
                 * profileDir 的反查以 extId 为键，因此 extId 变化同样要重解析。
                 */
                resolvedForFamily: family,
                resolvedForExtId: extId,
            },
        };
    }

    /** 引导期解析并固化配置（层 2/3/4）。成功后运行期零探测。
     *  v2.10：profile 反查失败不再阻塞固化——exe 解析成功即固化（profileDir 可为 null = 裸拉起）。
     *  v2.11：解析结果与「家族 + extId」绑定——任一变化（用户换浏览器 / 重装换目录）必须重解析，
     *         否则拉起错误浏览器、或 profileDir 指向扩展已不在的旧档案；
     *         旧版 browser.json 没有这两个字段，视为失效自动迁移一次。 */
    function ensureResolvedImpl() {
        const config = readConfig();
        if (!config?.family || !config?.extId) {
            return { ok: false, message: "浏览器家族/extId 未记录（等待扩展 hello）" };
        }
        const resolvedForCurrentChannel =
            config.resolvedForFamily === config.family && config.resolvedForExtId === config.extId;
        if (
            resolvedForCurrentChannel &&
            (config.exe || config.kind === "open-b") &&
            (config.profileResolved || config.profileDir)
        ) {
            return { ok: true, config };
        }
        const resolved = resolveAll({ family: config.family, extId: config.extId });
        if (!resolved.ok) return resolved;
        writeConfig({ ...config, ...resolved.config, profileResolved: true });
        audit?.append("browser_resolved", resolved.config);
        return { ok: true, config: { ...config, ...resolved.config, profileResolved: true } };
    }

    let lastLaunchAt = 0;
    /** 最后一次成功发起 spawn 的任务（与 lastLaunchAt 分离：后者在 doLaunch 入口无条件赋值，
     *  解析失败时并无真实开窗）。preopened 必须按任务归因，不能比时间戳——同毫秒会漏判、
     *  过期升级定时器也会把别的任务的拉起算到当前任务头上。 */
    let lastSpawnTaskId = null;
    let launchCount = 0;
    /** 门控键 → 升级定时器（同一门控键至多一笔 pending） */
    const escalationTimers = new Map();
    /** 已完成升级的门控键（每 key 封顶一次） */
    const escalatedKeys = new Set();

    /** 扩展最近吻痕：≤60s 视为「浏览器必然在运行」（WS 刚断，等待 alarms 自愈重连即可） */
    function recentContact() {
        const seen = Number(getExtensionLastSeenAt()) || 0;
        return seen > 0 && now() - seen <= RECENT_CONTACT_MS;
    }

    /** skip 判定（防抖之后、解析之前）：返回 skip 原因或 null（探测不可用一律回退为照旧拉起） */
    function skipReasonFor() {
        if (recentContact()) return "recent-contact";
        const family = readConfig()?.family;
        if (family && joined.isBrowserProcessRunning?.(family) === true) return "process-running";
        return null;
    }

    /** 实拉核心（ensureRunning 与升级 path 共用；不含防抖与前置判定）。
     *  每次实拉消费防抖窗口（lastLaunchAt），失败形状与 v2.10 保持一致。 */
    function doLaunch({ url, reason, taskId = null }) {
        lastLaunchAt = now();
        const ready = ensureResolvedImpl();
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

        // v2.11：Broker 自身由宿主以精简环境启动，不传 env 会让浏览器继承这份残缺环境块。
        // 实测仅缺 ProgramFiles(x86) 一项，Edge 就会在启动约 10s 后认定 profile 不可信并清空
        // extensions.settings / 受保护顶层键 / Extensions 目录（手动打开正常 = explorer 给的是完整环境）。
        const childEnv = mergeChildEnvironment({
            baseEnv: env,
            systemEnv: joined.readSystemEnvironment?.() ?? {},
        });

        const doSpawn = (file, args) => {
            const child = spawnImpl(file, args, {
                detached: true,
                stdio: "ignore",
                windowsHide: true,
                env: childEnv,
            });
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
            // spawn 调用返回只代表已发起（异步 error 仍可能失败）；preopened 让插件多等一会儿即可兜底
            if (taskId) lastSpawnTaskId = taskId;
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
    }

    /** skip 后调度升级：30s 到期且扩展仍未回连（吻痕未刷新）、仍有等待中的任务 → 强制拉起一次（每任务封顶）。
     *  强制拉起绕过防抖（升级本身已是深思熟虑的兜底决策），由 doLaunch 消费新的防抖窗口。
     *  回连判据：排程时记下吻痕，到期仍无**新的**吻痕才算未回连——不能用「最近吻痕 ≤60s」绝对窗口，
     *  否则 skip 前 0~30s 内有接触时升级会被吞掉且不重排，实际升级点滑到 60s watchdog 之后，
     *  把 90s 截止前的冷启动预算削到 30s（正是设计 §5.2 禁止的时点）。
     *
     *  门控键（详细设计 §2.4）：`waitKey ?? taskId`——任务等待与环境等待（xhs_prepare_env 无任务）
     *  同构，否则「无任务的唤醒」会因 skip 永久吞掉拉起。 */
    function scheduleEscalation({ url, reason, taskId, waitKey = null }) {
        const gateKey = waitKey ?? taskId;
        if (!gateKey || escalationTimers.has(gateKey) || escalatedKeys.has(gateKey)) return;
        const seenAtSchedule = Number(getExtensionLastSeenAt()) || 0;
        logger.info?.(
            `[browser] 拉起已暂缓（gateKey=${gateKey}，触发 ${reason}），${ESCALATION_DELAY_MS / 1000}s 后若扩展仍未回连将强制拉起一次`
        );
        const timer = setTimeoutImpl(() => {
            escalationTimers.delete(gateKey);
            const seenNow = Number(getExtensionLastSeenAt()) || 0;
            if (seenNow > seenAtSchedule || !shouldEscalate({ taskId, waitKey })) {
                // 留痕：否则 M12 取证看不到「升级被抑制」，只能靠推测
                audit?.append("browser_launch_escalation_skipped", {
                    taskId,
                    waitKey,
                    trigger: reason,
                    reason: seenNow > seenAtSchedule ? "contact-refreshed" : "no-pending-task",
                });
                return;
            }
            escalatedKeys.add(gateKey);
            if (escalatedKeys.size > ESCALATED_KEY_CAP) escalatedKeys.clear();
            // lastSpawnTaskId 仍只按 taskId 归因（环境拉起没有任务 → 不置位，避免误判 preopened）
            const launched = doLaunch({ url, reason: "skip-escalation", taskId });
            audit?.append("browser_launch_escalated", { taskId, waitKey, ok: launched?.ok !== false });
        }, ESCALATION_DELAY_MS);
        escalationTimers.set(gateKey, timer);
    }

    return {
        /** extension.hello 时记录扩展上报的家族与 extId（层 1；引导期第 1 步） */
        recordExtension({ family, extId }) {
            const config = readConfig();
            if (config && config.family === family && config.extId === extId) return config;
            // 只记录"变了"，**不清空已解析的 exe/profile**：
            // 失效判定已由 ensureResolvedImpl 的 resolvedForFamily/resolvedForExtId 负责，
            // 提前清空只会在"新家族解析失败"时把可用配置一起丢掉（从能拉起变成完全拉不起）。
            // 解析成功时 writeConfig 自然覆盖旧值；解析失败时磁盘保留上次可用配置，便于排障。
            const invalidated = !!config && (config.family !== family || config.extId !== extId);
            const next = { ...(config ?? {}), family, extId, recordedAt: now() };
            writeConfig(next);
            audit?.append("browser_recorded", { family, extId, invalidated });
            return next;
        },

        /** 引导期解析并固化配置（层 2/3/4）。成功后运行期零探测。 */
        ensureResolved() {
            return ensureResolvedImpl();
        },

        /**
         * 幂等拉起（运行期）。已运行时等效开窗；30s 防抖；P2 前置判定：
         * 扩展最近吻痕 / OS 进程探测命中 → 跳过 spawn（browser_launch_skipped）并为该任务调度升级。
         * @param {{url?: string|null, reason?: string, taskId?: string|null, waitKey?: string|null}} options
         */
        ensureRunning({ url = null, reason = "extension-offline", taskId = null, waitKey = null } = {}) {
            const t = now();
            if (t - lastLaunchAt < LAUNCH_DEBOUNCE_MS) {
                logger.info?.("[browser] 防抖期内，跳过重复拉起（已运行时拉起等效开窗）");
                return { ok: true, skipped: true };
            }
            const skipReason = skipReasonFor();
            if (skipReason) {
                // skip 不消费防抖窗口：若探测假阳性、随后出现真实拉起需求，不应被防抖挡住
                logger.info?.(`[browser] 已确认浏览器在运行（${skipReason}），跳过拉起`);
                audit?.append("browser_launch_skipped", { reason: skipReason, trigger: reason });
                scheduleEscalation({ url, reason, taskId, waitKey });
                return { ok: true, skipped: true, skipReason };
            }
            return doLaunch({ url, reason, taskId });
        },

        getStatus() {
            return { launchCount, lastLaunchAt, lastSpawnTaskId, pendingEscalations: escalationTimers.size, config: readConfig() };
        },

        /**
         * OS 级把抓取窗口切到系统前台（方案 B）。
         *
         * 为什么在这里：扩展侧的 `chrome.windows.update({focused:true})` 被 Chromium 的
         * focus-stealing prevention 拒绝（实测只闪任务栏），只有 Broker 这种独立进程直接调
         * Win32 才能真正置前。家族取 `browser.json` 的固化值（未知家族一律拒绝，不猜测），
         * 目标窗口按「家族映像名白名单 + 标题子串」双重匹配，参数只经环境变量传给 helper。
         *
         * 纯尽力而为：失败一律如实返回 reason，由调用方转述给 AI/用户（不重试、不提权）。
         */
        async activateWindowOS({ titleHint = null, hintSource = "unknown", timeoutMs } = {}) {
            const family = readConfig()?.family ?? null;
            // helper 子进程也要拿到「像正常用户进程」的环境块：Broker 自身常被宿主以精简环境启动
            // （仓库已知事故：缺 ProgramFiles(x86) 会让浏览器清空扩展设置），缺变量时 helper 可能起不来
            const helperEnv = mergeChildEnvironment({
                baseEnv: env,
                systemEnv: joined.readSystemEnvironment?.() ?? {},
            });
            const result = await activateWindowOSPlatform({
                family,
                titleHint,
                platform,
                env: helperEnv,
                ...(spawnCapture ? { spawnCapture } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            });
            // 隐私红线（契约明文）：hint 可能是页面可见文本（标签页标题），只进工具响应，
            // **不得落 tasks.json / audit.jsonl**——审计只记来源与长度
            audit?.append("window_activate", {
                family,
                hintSource,
                hintLen: typeof titleHint === "string" ? titleHint.length : 0,
                ok: result.ok === true,
                reason: result.reason,
            });
            return result;
        },
    };
}
