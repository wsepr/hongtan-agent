/**
 * [hongtan-agent] Broker：本机常驻单例进程（执行计划 S1/S2 装配层）
 *
 * 职责（设计文档 §5/§6/§10）：
 * - WebSocket 服务端（ws://127.0.0.1:17373/extension）：challenge/proof 配对 + hello + 心跳 + 命令白名单
 * - HTTP loopback：GET /health + POST /v1/mcp（工具执行）+ /v1/adapters/register|heartbeat
 * - 任务账本（24h TTL）+ 审计日志 + 浏览器幂等拉起 + 任务期阻止休眠 + 开机自启
 *   （任务节奏配额已下沉插件侧，Broker 只缓存插件上报的快照做派发前预检，§10.5）
 *
 * 运行：node scripts/broker-server.mjs（或经 mcp-server.mjs detached 拉起单例）
 * 配置：HONGTAN_AGENT_* 环境变量（见 CONFIG）
 */

import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createLoopbackWebSocketServer } from "./websocket-server.mjs";
import { createTaskStore, BROKER_INTERMEDIATE_STATES } from "./broker/task-store.mjs";
import { createActionLimiter } from "./broker/rate-limit.mjs";
import { createAlertMonitor } from "./broker/alerts.mjs";
import { createHandshakeBackoff, extIdFromOrigin } from "./broker/handshake-backoff.mjs";
import { createAudit } from "./broker/audit.mjs";
import { createPairing } from "./broker/pairing.mjs";
import { createActiveChannelStore, channelKeyOf, ACTIVE_CHANNEL_FILE } from "./broker/active-channel.mjs";
import { createToolExecutor, buildTaskLaunchUrl } from "./broker/tools.mjs";
import { createSessionSnapshotStore } from "./broker/session-snapshot.mjs";
import { createBrowserManager } from "./broker/browser/index.mjs";
import { createOsProbes } from "./broker/browser/os-probes.mjs";
import { loadOrCreateDeviceIdentity, resolveStateDirectory } from "./device-identity.mjs";
import { createKeepAwake } from "./keep-awake.mjs";
import { createAutostart } from "./autostart.mjs";
import { contractsFingerprint, resolveBuildId } from "./build-fingerprint.mjs";
// 静态 import 而非 fs 读取：standalone 产物（bun compile）不内嵌运行时 readFileSync 的文件
import contractsJson from "../contracts/xhs-agent-tools-v1.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BROKER_VERSION = "0.1.0";
const BUILD_ID = resolveBuildId();

/** 已知的旧协议 hello 形态（抓取实测到新形态就往这里加）：协议规定的是 `extension.hello` */
const LEGACY_HELLO_TYPES = new Set(["hello"]);

// ====================================================================
// 配置
// ====================================================================

export function loadConfig(env = process.env) {
    const stateDir = env.HONGTAN_AGENT_STATE_DIR || resolveStateDirectory(env);
    return {
        port: Number(env.HONGTAN_AGENT_PORT ?? 17373),
        stateDir,
        ledgerPath: path.join(stateDir, "tasks.json"),
        auditPath: path.join(stateDir, "audit.jsonl"),
        browserConfigPath: path.join(stateDir, "browser.json"),
        // 只读会话快照（详细设计 §5.1）：与任务账本分开存（失效语义不同）
        snapshotPath: path.join(stateDir, "session-snapshot.json"),
        extensionDeadlineMs: Number(env.HONGTAN_AGENT_EXTENSION_DEADLINE_MS ?? 90_000),
        hostKey: env.HONGTAN_AGENT_HOST ?? "workbuddy",
    };
}

// ====================================================================
// 装配（依赖注入以便测试）
// ====================================================================

export function createBroker({
    config = loadConfig(),
    contracts,
    now = () => Date.now(),
    spawnImpl = spawn,
    fsImpl = fs,
    probes = null,
    logger = console,
    identity = null,
    autostart = createAutostart({ logger }),
    // 保活默认实现会派生 PowerShell 宿主（真机行为）；测试注入桩以避免真实副作用
    keepAwake = createKeepAwake({ logger }),
    rateLimiter = null,
} = {}) {
    fs.mkdirSync(config.stateDir, { recursive: true });

    // 未显式注入时用真实 OS 探针（§10.7 层 2/层 3）：resolve-exe / resolve-profile 只接受注入的
    // 探测函数，生产装配若不供给实现，App Paths、默认浏览器反查与目录枚举兜底在真实路径上
    // 全都不可达（只剩标准安装路径兜底）——测试自己注入桩，所以这条断链单测抓不到。
    const effectiveProbes = probes ?? createOsProbes();

    // 抓取 + 硬化：协议外/旧协议客户端按来源退避（窗口 60s / 阈值 5 次 / 冷却 5 分钟），
    // 冷却期内由 refuseUpgrade 在建立会话之前拒连
    const handshakeBackoff = createHandshakeBackoff({ now });

    const audit = createAudit({ filePath: config.auditPath, now });
    /**
     * 独占通道租约：同一时刻只有一个浏览器接管红探（详见 broker/active-channel.mjs）。
     * 放在这里而非 handleHello 内部，是因为健康检查、工具响应与 HTTP 重置都要读同一份状态。
     */
    const activeChannel = createActiveChannelStore({
        filePath: path.join(config.stateDir, ACTIVE_CHANNEL_FILE),
        now,
        logger,
    });
    /**
     * takeover 限流（60s 窗口）。扩展没有身份， broker 无法密码学校验"确实是用户点的"，
     * 于是退而求其次：给这个动作加上可观测 + 有上限，避免本机异常进程把它刷成抖动。
     */
    const MAX_TAKEOVER_PER_MINUTE = 5;
    /** @type {number[]} */
    const takeoverAttempts = [];
    function noteTakeoverAttempt(at) {
        takeoverAttempts.push(at);
        while (takeoverAttempts.length > 0 && at - takeoverAttempts[0] > 60_000) takeoverAttempts.shift();
        return takeoverAttempts.length;
    }
    // §11.6 告警监控：把「会静默自愈」的问题升级为可归因告警（离线超时 / 心跳停摆 / 恢复耗尽 / 连接风暴）
    // digestSize：进 connection_status 的最近告警摘要（§9.1，仅覆盖当前进程存活期）
    const alerts = createAlertMonitor({ now, audit, logger, thresholds: { digestSize: 10, ...(config.alertThresholds ?? {}) } });
    // 只读会话快照（详细设计 §5）：离线时回答「上次在线看到的数据集与会话摘要」
    const snapshotStore = createSessionSnapshotStore({ filePath: config.snapshotPath, now, logger });
    const taskStore = createTaskStore({
        ledgerPath: config.ledgerPath,
        now,
        logger,
        // 账本任何变更后重算保活（§10.7 环①）：挂在账本层，避免新增转移路径时漏掉
        onChanged: () => refreshKeepAwake(),
    });
    // action 级限流（§10.5）：默认按 contracts.limits.actionCallsPerMinute，未配置时 60 次/分钟/工具
    const actionLimiter =
        rateLimiter ??
        createActionLimiter({
            now,
            defaultPerMinute: contracts?.limits?.actionCallsPerMinute ?? 60,
        });
    const browserManager = createBrowserManager({
        configPath: config.browserConfigPath,
        spawnImpl,
        fsImpl,
        audit,
        logger,
        now,
        probes: effectiveProbes,
        // P2 前置判定（《常驻工作区设计方案》§5.2）：吻痕新鲜 / 进程探测命中 → skip spawn。
        // 两处均为延迟执行闭包（变量声明见下方/上方，调用时才求值）
        getExtensionLastSeenAt: () => extensionLastSeenAt,
        // 门控（详细设计 §2.4/§2.5）：有 taskId 时该任务仍停在 launching_browser/waiting_extension 才放行；
        // 无 taskId 的环境等待（prepare_env）只要带 waitKey 就允许升级一次（每 key 由 browserManager 封顶）。
        // 过期升级定时器不得因“另有任务在等”就用旧 URL 拉起。
        shouldEscalate: ({ taskId, waitKey } = {}) => {
            if (taskId) {
                const t = taskStore.get(taskId);
                return !!t && ["launching_browser", "waiting_extension"].includes(t.state);
            }
            return !!waitKey;
        },
    });

    /** @type {{peer: any, extId: string, version: string, browserFamily: string, agentEnabled: boolean, deviceApproved: boolean, device: any, vip: any, quota: any, helloAt: number} | null} */
    let extensionSession = null;
    let extensionLastSeenAt = 0;
    /** 最近一次 hello 的 extId（离线时仍用于快照归属判定与 lastKnown/lastSeenAt 透出）。
     *  初值取自固化配置：Broker 重启后内存丢失，但快照不失效（§5.3），须能按同一 extId 命中。 */
    let lastExtensionExtId = browserManager.getStatus().config?.extId ?? null;
    /** @type {Map<string, {resolve: (r: any) => void, timer: any}>} */
    const syncPending = new Map();

    function sendToExtension(payload) {
        const peer = extensionSession?.peer;
        if (!peer || !peer.isOpen) return false;
        return peer.send(payload);
    }

    function refreshKeepAwake() {
        if (taskStore.activeCount() > 0) keepAwake.acquire("task-active");
        else keepAwake.release();
    }

    /**
     * 等待扩展连接的任务在 watchdog 中重试拉起浏览器（§10.7 环③「超时未连 → 尝试拉起 → 再等一轮」）。
     * ensureRunning 自带 30s 防抖，故 1 分钟一轮不会造成拉起风暴；
     * P2：前置判定（吻痕/进程探测）命中时 ensureRunning 会 skip 并由 browserManager 自调度 30s 升级，
     * 此处的 taskId 用于升级的「每任务封顶一次」。
     */
    function retryLaunchForWaitingTasks() {
        if (sessionFacade.isConnected()) return;
        if (taskStore.activeCount() === 0) return;
        const task = taskStore.activeTask();
        if (!task || task.state !== "waiting_extension") return;
        try {
            browserManager.ensureRunning({
                url: buildTaskLaunchUrl(task.params),
                reason: "waiting-extension-retry",
                taskId: task.id,
            });
        } catch (e) {
            logger.warn?.("[broker] 重试拉起浏览器失败:", e?.message ?? e);
        }
    }

    const sessionFacade = {
        isConnected: () => !!(extensionSession?.peer?.isOpen),
        /** 当前占用通道（脱敏：不含 channelKey）；无占用者时为 null —— AI 据此回答"任务会在哪个浏览器执行" */
        activeChannel: () => activeChannel.describePublic(),
        extensionInfo: () =>
            extensionSession
                ? {
                      connected: !!(extensionSession.peer?.isOpen),
                      lastSeenAt: extensionLastSeenAt || null,
                      extId: extensionSession.extId,
                      version: extensionSession.version,
                      browserFamily: extensionSession.browserFamily,
                      agentEnabled: extensionSession.agentEnabled,
                      deviceApproved: extensionSession.deviceApproved,
                      pairing: pairing
                          ? {
                                deviceId: pairing.deviceId,
                                fingerprint: pairing.fingerprint,
                                hostKey: pairing.hostKey,
                                displayName: pairing.displayName,
                                approved: extensionSession.deviceApproved,
                            }
                          : null,
                      vip: extensionSession.vip,
                      // 任务节奏配额快照（§10.5，插件侧权威）——派发前预检与 connection_status 共用
                      quota: extensionSession.quota ?? null,
                      onboarding: buildOnboardingHint(),
                  }
                : {
                      connected: false,
                      // 离线仍透出「上次在线」的归属与时间：快照读取（extId 匹配）与 freshness 依赖它们
                      extId: lastExtensionExtId,
                      lastSeenAt: extensionLastSeenAt || null,
                      onboarding: buildOnboardingHint(),
                  },
        sendTaskStart: (task, { resume = false, preopened = false } = {}) =>
            sendToExtension({
                type: "task.start",
                taskId: task.id,
                kind: task.kind,
                params: task.params,
                // 显式续接（§8.3）：带 resumeOf 的 task.start 让插件把暂停中的任务推回 running
                ...(resume ? { resumeOf: task.id } : {}),
                // 预开窗标志（v2.12）：最后一次成功发起的 spawn 属于本任务——深链窗口可能仍在
                // 创建中（移交/冷启动开窗是异步的），插件收到后应先短暂等待预开窗再兜底自建
                ...(preopened ? { preopened: true } : {}),
            }),
        sendTaskCancel: (taskId) => sendToExtension({ type: "task.cancel", taskId }),
        // sync 写穿（详细设计 §2.5/§5.2）：数据集成功后覆盖快照 datasets 段（create/rename 再 fire-and-forget
        // 拉一次 list，保证快照与插件权威一致）；会员态（get_vip_state）成功后覆盖内存会话与快照 session 段
        syncRequest: async (action, params, timeoutMs) => {
            const result = await rawSyncRequest(action, params, timeoutMs);
            if (result?.ok) {
                if (action === "list_datasets") {
                    snapshotStore.writeDatasets(result.data?.datasets ?? []);
                    audit.append("snapshot_datasets_refreshed", { count: (result.data?.datasets ?? []).length });
                } else if (action === "create_dataset" || action === "rename_dataset") {
                    refreshDatasets();
                } else if (action === "get_vip_state") {
                    // 会员态实时拉取（工具查询前触发）：Broker 只在 hello 时缓存一次 vip，
                    // 登录/登出/信封刷新后必须由此覆盖，否则 connection_status 一直报握手时的旧值
                    if (extensionSession) {
                        extensionSession.vip = result.data?.vip ?? null;
                        // 与 handleHello 同口径写 session 段：lastKnown 与在线会话保持一致
                        snapshotStore.writeSession({
                            extId: extensionSession.extId,
                            browserFamily: extensionSession.browserFamily,
                            vip: extensionSession.vip,
                            quota: extensionSession.quota,
                            lastSeenAt: now(),
                        });
                    }
                }
            }
            return result;
        },
    };

    /** 底层 sync.request 透传（不含写穿与副作用），供 syncRequest 包装复用 */
    function rawSyncRequest(action, params, timeoutMs) {
        return new Promise((resolve) => {
            const requestId = crypto.randomUUID();
            const sent = sendToExtension({ type: "sync.request", requestId, action, params });
            if (!sent) {
                resolve({ ok: false, error: { code: "EXTENSION_OFFLINE", message: "红探扩展未连接" } });
                return;
            }
            const timer = setTimeout(() => {
                syncPending.delete(requestId);
                resolve({
                    ok: false,
                    error: { code: "EXTENSION_OFFLINE", message: "扩展响应超时（连接可能不稳定）" },
                });
            }, timeoutMs);
            syncPending.set(requestId, { resolve, timer });
        });
    }

    /**
     * 主动刷新快照 datasets 段（详细设计 §5.2）：仅在线时发起，失败（离线 / 设备未批准致请求被丢弃）
     * 静默忽略——不落快照、不告警、不重试、不阻塞主链路。写穿由 syncRequest 包装完成。
     */
    function refreshDatasets() {
        if (!sessionFacade.isConnected()) return;
        // 写穿与审计由 syncRequest 包装完成，这里只负责触发一次拉取；失败一律静默
        void sessionFacade.syncRequest("list_datasets", {}, 10_000).catch(() => undefined);
    }

    function buildOnboardingHint() {
        if (!extensionSession) {
            // 浏览器多半没开：不要把「请人工开浏览器」当唯一出路——start_crawl 会自动拉起（§9.1 步骤 6），
            // 仅首次引导（扩展从未连接过、无从解析浏览器配置）才需要人工兜底
            return "可直接发起抓取任务（本机服务会自动拉起浏览器）；若启动后报 EXTENSION_UNAVAILABLE，请人工打开浏览器检查插件安装与 Agent 接管开关";
        }
        if (!extensionSession.agentEnabled) {
            return "请在红探插件设置 →「Agent 接管」中开启开关";
        }
        if (!extensionSession.deviceApproved) {
            return "请在红探插件设置 →「Agent 接管」→ 设备管理中核对本机指纹并点击批准";
        }
        return null;
    }

    // 运行时指纹（问题清单 4.3）：对「本进程实际生效的契约对象」取哈希——DI 可注入测试桩，
    // 哈希必须反映实际使用的那份，而非磁盘文件
    const contractsHash = contractsFingerprint(contracts ?? contractsJson);

    // ------------------------------------------------------------------
    // /v1/mcp 请求级幂等回放（问题清单 1.4）：adapter 重试时复用 X-Hongtan-Request-Id，
    // 命中即回放首次结果，杜绝「传输层重试导致副作用工具二次执行」
    // ------------------------------------------------------------------

    const MCP_REPLAY_TTL_MS = 10 * 60 * 1000;
    const MCP_REPLAY_MAX = 256;
    /** @type {Map<string, {result: any, at: number}>} */
    const mcpReplay = new Map();

    function replayGet(requestId) {
        const hit = mcpReplay.get(requestId);
        if (!hit) return null;
        if (now() - hit.at > MCP_REPLAY_TTL_MS) {
            mcpReplay.delete(requestId);
            return null;
        }
        // LRU touch
        mcpReplay.delete(requestId);
        mcpReplay.set(requestId, hit);
        return hit.result;
    }

    function replayPut(requestId, result) {
        mcpReplay.delete(requestId);
        mcpReplay.set(requestId, { result, at: now() });
        while (mcpReplay.size > MCP_REPLAY_MAX) {
            mcpReplay.delete(mcpReplay.keys().next().value);
        }
    }

    /** adapter 指纹头（X-Hongtan-Adapter-*）→ ctx.adapterFingerprint，供 runtime 块自证 */
    function adapterFingerprintFrom(req) {
        const h = req.headers;
        const version = typeof h["x-hongtan-adapter-version"] === "string" ? h["x-hongtan-adapter-version"] : null;
        const buildId = typeof h["x-hongtan-adapter-build-id"] === "string" ? h["x-hongtan-adapter-build-id"] : null;
        const hash = typeof h["x-hongtan-adapter-contracts-hash"] === "string" ? h["x-hongtan-adapter-contracts-hash"] : null;
        if (!version && !buildId && !hash) return null;
        return { version, buildId, contractsHash: hash };
    }

    const tools = createToolExecutor({
        contracts,
        taskStore,
        audit,
        session: sessionFacade,
        browserManager,
        rateLimiter: actionLimiter,
        snapshotStore,
        alerts,
        now,
        config: {
            extensionDeadlineMs: config.extensionDeadlineMs,
            // 取消确认超时：30s（设计文档 §9.2）
            cancelTimeoutMs: 30_000,
        },
        logger,
    });

    const pairing = createPairing({ identity, now, logger });

    // ------------------------------------------------------------------
    // 任务终态与拉起收敛
    // ------------------------------------------------------------------

    function applyTaskResult(msg) {
        const task = taskStore.get(msg.taskId);
        if (!task || BROKER_TERMINAL(msg.taskId)) return;
        const status = ["completed", "partial", "failed", "canceled", "aborted_by_user"].includes(msg.status)
            ? msg.status
            : "failed";
        // 终态以插件汇总为准：summary 合入 processed（与 task_status 快照同口径）
        const mergedProcessed = { ...task.processed };
        if (msg.summary && typeof msg.summary === "object") {
            for (const key of ["articles", "comments", "images", "skippedByBlacklist", "skippedExisting"]) {
                if (Number.isFinite(msg.summary[key])) mergedProcessed[key] = msg.summary[key];
            }
        }
        taskStore.setState(task, status, {
            summary: msg.summary ?? null,
            error: msg.error ?? null,
            effectiveConfig: msg.effectiveConfig ?? task.effectiveConfig,
            ...(Number.isFinite(msg.resumeCount) ? { resumeCount: msg.resumeCount } : {}),
            // 终态也带上数据集归属（插件上报的真实 id，供 task_list 过滤/复盘）
            ...(Number.isFinite(msg.datasetId) ? { datasetId: msg.datasetId } : {}),
        });
        task.processed = mergedProcessed;
        taskStore.persist();
        // §11.1：终态必须可归因——记录错误码 / 恢复次数 / 耗时 / 数据集归属，便于用户回来复盘
        audit.append("task_result", {
            taskId: task.id,
            status,
            errorCode: msg.error?.code ?? null,
            resumeCount: Number.isFinite(msg.resumeCount) ? msg.resumeCount : task.resumeCount,
            datasetId: Number.isFinite(task.datasetId) ? task.datasetId : null,
            durationMs: Math.max(0, now() - (task.createdAt ?? now())),
            hostKey: pairing?.hostKey ?? null,
            deviceId: pairing?.deviceId ?? null,
            summary: msg.summary ?? null,
        });
        if (msg.error?.code === "RESUME_EXHAUSTED") alerts.noteResumeExhausted(task.id);
        alerts.noteTaskSettled(task.id);
        refreshKeepAwake();
        // 终态后顺带刷新快照（详细设计 §5.2 #3）：插件侧仅读 IndexedDB，成本低；失败静默
        refreshDatasets();
    }

    function BROKER_TERMINAL(taskId) {
        const t = taskStore.get(taskId);
        return !t || ["completed", "partial", "failed", "canceled", "aborted_by_user"].includes(t.state);
    }

    /**
     * 插件上报的状态 → 账本状态（认领与复活共用同一口径，避免两处漂移）。
     * 不明/缺失状态按 running 处理（插件重播的常态就是 running）。
     */
    function advertisedStateOf(state) {
        return ["interrupted", "blocked_by_risk", "stalled_by_background"].includes(state) ? state : "running";
    }

    /**
     * 认领插件侧重播的未知任务（冷启动对账，§10.7 环②）。
     * Broker 重启会丢失内存账本；插件侧在握手后补报当前态，此处据此重建一条记录，
     * 使 `xhs_task_status` 仍能回答「任务 X 现在什么状态」，而不是返回 TASK_NOT_FOUND。
     */
    function adoptUnknownTask(taskId, msg) {
        if (!taskId || taskStore.get(taskId)) return;
        const task = taskStore.createTask({
            kind: "crawl",
            params: { adopted: true, taskId },
            // 来源按插件上报（详细设计 §2.3/§8.2）：manual = 插件里手动发起的抓取
            source: msg.source === "manual" ? "manual" : "agent",
        });
        // createTask 生成的 id 与插件侧 taskId 不一致：就地重键到插件侧 id
        taskStore.renameTaskId(task.id, taskId);
        const adopted = taskStore.get(taskId);
        // 认领后按插件上报的状态落位（中间态直接透传；不明状态按 running 处理）
        const advertised = advertisedStateOf(msg.state);
        taskStore.setState(adopted, "running");
        if (advertised !== "running") taskStore.noteIntermediateState(taskId, advertised);
        adopted.adoptedFromExtension = true;
        adopted.lastMessage = msg.data?.message ?? null;
        taskStore.persist();
        audit.append("task_adopted", { taskId, state: advertised });
    }

    /** hello 后补投递：把停在 launching_browser / waiting_extension 的待派任务发出（demo 已验证模式） */
    function dispatchPendingTasks() {
        for (const id of taskStore.list({ limit: 100 })) {
            const task = taskStore.get(id);
            if (!task || !["launching_browser", "waiting_extension"].includes(task.state)) continue;
            tools.clearExtensionDeadline(task.id);
            // 预开窗判定：最后一次成功发起的 spawn 属于本任务——spawn 后深链窗口可能仍在创建中，
            // 插件收到后应先短暂等待预开窗再兜底自建。按任务归因，避免同毫秒时间戳漏判与跨任务误判
            const preopened = browserManager.getStatus().lastSpawnTaskId === task.id;
            if (sessionFacade.sendTaskStart(task, { preopened })) {
                taskStore.setState(task, "running");
                audit.append("task_dispatched", { taskId: task.id, via: "hello-redelivery", preopened });
            }
        }
    }

    // ------------------------------------------------------------------
    // WS 会话处理
    // ------------------------------------------------------------------

    function handleExtensionMessage(peer, msg) {
        // 「吻痕」只由**被识别并处理**的消息刷新。早期实现无差别地在函数入口刷新，于是任意进程都能
        // 让它恒真——实测有客户端每 1–3s 发一帧裸 {type:"hello"}（从未完成握手），就足以让
        // recentContact() 持续为真，静默抑制 broker 拉起**该拉起的**浏览器。
        const beforeHello = !extensionSession || extensionSession.peer !== peer;
        const recognized = msg.type === "session.challenge" || msg.type === "extension.hello" || msg.type === "session.proof.error";
        // 抓取：把来源随每条留痕带上，否则「谁在反复握手失败」只能靠猜（origin/extId 由 onConnection 钉在 peer 上）
        const peerTrace = { origin: peer?._origin ?? null, extId: peer?._extIdFromOrigin ?? null, remotePort: peer?._remotePort ?? null };

        if (beforeHello && !recognized) {
            // hello 前的其余消息一律忽略（白名单外不响应），也不计吻痕
            audit.append("ws_message_before_hello", { type: msg?.type ?? "unknown", ...peerTrace });
            // 硬化：已知旧协议形态 → 留痕 + 显式拒绝（回拒绝帧 + 专用 close 码），而不是静默忽略
            if (LEGACY_HELLO_TYPES.has(msg?.type)) {
                audit.append("legacy_hello_frame", { type: msg.type, ...peerTrace });
                peer.send({
                    type: "hello.rejected",
                    reason: "LEGACY_PROTOCOL_UNSUPPORTED",
                    expected: "extension.hello",
                    protocolVersion: contracts?.protocolVersion ?? null,
                    message: "本机 Agent 仅接受 extension.hello 握手，请更新扩展",
                });
                audit.append("hello_reject", { reason: "LEGACY_PROTOCOL_UNSUPPORTED", got: msg.type, ...peerTrace });
                // 已给出明确信号，别让 5s 超时再补一条重复留痕
                peer._setHelloSeen?.();
                if (handshakeBackoff.noteFailure(peerTrace.extId)) {
                    alerts.noteLegacyProtocolClient({ extId: peerTrace.extId, origin: peerTrace.origin });
                }
                peer.close(4003, "legacy protocol");
            }
            return;
        }
        extensionLastSeenAt = now();
        // 占用者的任何已识别消息都刷新租约在线时间（节流落盘）；待机方的消息到不了这里
        if (extensionSession?.peer === peer) activeChannel.touch();

        // 未完成 hello：仅接受 challenge/proof 与 hello
        if (beforeHello) {
            if (msg.type === "session.challenge") {
                // extId 参与 proof 签名载荷（与插件侧 verifyProof 的 extId 同源），缺失按空串签名
                const proof = pairing.respondToChallenge(msg, typeof msg.extId === "string" ? msg.extId : "");
                peer.send(proof);
                return;
            }
            if (msg.type === "extension.hello") {
                handleHello(peer, msg);
                return;
            }
            audit.append("session_proof_error", { code: msg.code, message: msg.message });
            return;
        }

        switch (msg.type) {
            case "channel.release": {
                // 占用者主动让出（插件关闭开关时先发本帧再断连）。
                // 能走到这里说明 peer 已是当前会话本人（beforeHello 分支已 return），
                // 因此这条"让出"天然绑定连接所有权，不需要任何共享密钥。
                if (!extensionSession || extensionSession.peer !== peer) {
                    audit.append("ws_unknown_message", { type: msg.type, reason: "not-session-owner" });
                    break;
                }
                const released = activeChannel.describe();
                activeChannel.release();
                audit.append("channel_released", {
                    channelKey: released?.channelKey ?? null,
                    family: released?.family ?? null,
                    reason: typeof msg.reason === "string" ? msg.reason : null,
                });
                break;
            }
            case "extension.ping":
                peer.send({ type: "server.pong" });
                break;
            case "session.challenge":
                // 已建立的会话不重复握手
                break;
            case "task.progress": {
                // 冷启动对账（§10.7 环②）：Broker 重启后账本可能丢失在途任务，
                // 插件侧会重播当前态——对未知 taskId 就地认领，使 task_status 仍可作答
                adoptUnknownTask(msg.taskId, msg);
                // 以插件为准的对账（§15 #10）：重启时被标记 failed(BROKER_RESTARTED) 的在途任务
                // 会因「终态任务的 task.progress 为 no-op」而永远卡在 failed；插件重播即推翻该占位
                if (taskStore.readoptFromPlugin(msg.taskId, advertisedStateOf(msg.state))) {
                    audit.append("task_readopted", { taskId: msg.taskId, state: advertisedStateOf(msg.state) });
                }
                taskStore.noteProgress(msg.taskId, { seq: msg.seq, data: msg.data, datasetId: msg.datasetId });
                const task = taskStore.get(msg.taskId);
                // 中间态双向跟随：插件上报中间态即落中间态；插件报回 running（遮挡解除 /
                // 用户过完验证码）也必须同步回 running，否则账本停在中间态，后续终态会被状态机拒绝
                if (task && BROKER_INTERMEDIATE_STATES.has(task.state) && msg.state === "running") {
                    taskStore.setState(task, "running");
                    audit.append("task_resumed_running", { taskId: msg.taskId });
                } else if (msg.state && BROKER_INTERMEDIATE_STATES.has(msg.state)) {
                    taskStore.noteIntermediateState(msg.taskId, msg.state);
                    audit.append("task_intermediate", { taskId: msg.taskId, state: msg.state, errorCode: msg.errorCode });
                }
                break;
            }
            case "task.result":
                // 缓存插件上报的配额快照（终态结算后的最新值，§10.5）——放在 applyTaskResult
                // 之前：该函数对未知/终态任务会早退，但快照缓存不应跟着被跳过
                if (extensionSession && msg.quota) extensionSession.quota = msg.quota;
                applyTaskResult(msg);
                break;
            case "task.cancel.result": {
                audit.append("task_cancel_result", {
                    taskId: msg.taskId,
                    accepted: msg.accepted,
                    reason: msg.reason,
                    code: msg.code ?? null,
                });
                const task = taskStore.get(msg.taskId);
                if (!task) break;
                // 强制清理脏状态（技术审查报告 §2）：插件明确「本机没有这个任务」时，
                // Broker 的这条任务不可能还在跑 → 直接收敛为 canceled，而不是回退成 running
                // 留下一个永远不会结束的幽灵任务（AI 侧表现为「任务永远在跑」）。
                // 不限于正在 canceling 的时刻：取消超时后插件迟到的拒绝同样该收敛。
                if (!msg.accepted && (msg.code === "NO_ACTIVE_TASK" || msg.code === "TASK_ID_MISMATCH")) {
                    if (!BROKER_TERMINAL(msg.taskId)) {
                        taskStore.setState(task, "canceled", { summary: task.summary ?? null, error: null });
                    }
                    audit.append("task_cancel_forced", { taskId: msg.taskId, code: msg.code });
                    break;
                }
                if (task && task.state === "canceling" && !msg.accepted) {
                    // 插件拒绝取消（如 sendTab 失败已强制收敛）：回退可恢复状态
                    taskStore.setState(task, "running");
                }
                break;
            }
            case "task.recovered":
                taskStore.noteRecovered(msg.taskId, {
                    tabId: msg.tabId,
                    windowId: msg.windowId,
                    resumeCount: msg.resumeCount,
                    remaining: msg.remaining,
                });
                audit.append("task_recovered", {
                    taskId: msg.taskId,
                    resumeCount: msg.resumeCount,
                    remaining: msg.remaining,
                });
                break;
            case "sync.response": {
                const pending = syncPending.get(msg.requestId);
                if (pending) {
                    clearTimeout(pending.timer);
                    syncPending.delete(msg.requestId);
                    pending.resolve(
                        msg.ok
                            ? { ok: true, data: msg.data }
                            : { ok: false, error: msg.error ?? { code: "SYNC_FAILED", message: "同步操作失败" } }
                    );
                }
                break;
            }
            default:
                // 白名单外消息丢弃并计数（设计文档 §7.5）
                audit.append("ws_unknown_message", { type: msg?.type ?? "unknown" });
        }
    }

    function handleHello(peer, msg) {
        if (msg.protocolVersion !== contracts?.protocolVersion) {
            audit.append("hello_reject", { reason: "PROTOCOL_VERSION_MISMATCH", got: msg.protocolVersion });
            peer.close(4002, "protocol version mismatch");
            return;
        }
        // ---- 独占通道租约 ----
        // 规则：无占用者 → 首个 hello 即占用（开关本身就是用户的显式动作）；
        // 同一通道重连 → 续期；其余一律拒绝，只有用户点了「切换到此浏览器」带来的
        // takeover 才能转移租约。离线占用者同样受保护——休眠/SW 回收造成的短暂离线
        // 不应让另一个浏览器自动抢占（否则又回到"谁后连谁赢"）。
        const incomingKey = channelKeyOf(msg);
        const lease = activeChannel.describe();
        // 同一浏览器换了通道标识：storage 抖动回退到"不带 key"后恢复，或用户清空扩展数据
        // 重建了实例 id。只允许在**旧租约已离线**时改键——在线仍拒绝，避免同一浏览器的
        // 两个 profile 互相顶替；跨浏览器（family 不同）永远不算"同一浏览器"。
        // 注意 family 两端都可能为 null：那时 channelKey 也会同为 `family:unknown`，
        // 于是 keyRotated 因"键相同"而不成立——这份安全依赖 channelKeyOf 的默认值，
        // 改那个默认值时必须回头看这里。
        const sameBrowser =
            !!lease && lease.extId === (msg.extId ?? null) && lease.family === (msg.browserFamily ?? null);
        const keyRotated = sameBrowser && lease.channelKey !== incomingKey && !lease.online;
        if (keyRotated) {
            // 带上批准态：改键路径不满足 device_revoked 的同通道条件，批准态若同时丢失
            // （清空扩展数据必然如此）只有这里能留下证据。
            audit.append("channel_rekeyed", {
                from: lease.channelKey,
                to: incomingKey,
                family: lease.family,
                prevApproved: lease.approved,
                nowApproved: msg.deviceApproved === true,
            });
        }
        const wantsTakeover = msg.takeover === true && !!lease && lease.channelKey !== incomingKey;
        // 抢通道限流：防止本机异常进程反复 takeover 把两个浏览器刷成抖动（用户正常最多点两三次）
        const isTakeover = wantsTakeover && noteTakeoverAttempt(now()) <= MAX_TAKEOVER_PER_MINUTE;
        // 被限流与"被别人占用"在协议上原本长得一模一样，用户点了没反应会以为界面坏了。
        // 用一个显式字段区分，让插件能说"操作太频繁"而不是重复"Edge 正在使用"。
        const throttled = wantsTakeover && !isTakeover;
        if (throttled) {
            audit.append("channel_takeover_throttled", { incomingKey, activeChannelKey: lease.channelKey });
        }
        const granted = !lease || lease.channelKey === incomingKey || isTakeover || keyRotated;
        if (!granted) {
            // 还剩多久窗口才滑过去：客户端据此倒计时，避免"手动刷新 → 限流显示被抹掉 → 再点又被拒"
            const retryAfterMs = throttled
                ? Math.max(1_000, 60_000 - (now() - (takeoverAttempts[0] ?? now())))
                : undefined;
            peer.send({
                type: "session.occupied",
                activeFamily: lease.family ?? "unknown",
                activeSince: lease.since,
                activeOnline: lease.online,
                ...(throttled ? { throttled: true, retryAfterMs } : {}),
                message: throttled ? "切换操作过于频繁" : "这台红探客户端正被另一个浏览器使用",
            });
            // 与 channel_takeover_throttled 是同一次拒绝的两条留痕（后者带 activeChannelKey），
            // 统计"被拒绝次数"时不要重复计数
            audit.append("channel_occupied", {
                incomingKey,
                incomingFamily: msg.browserFamily ?? null,
                activeFamily: lease.family ?? null,
                activeOnline: lease.online,
                ...(throttled ? { throttled: true } : {}),
            });
            peer.close(4004, "occupied");
            return;
        }
        // 撤销留痕（§11.1）：用**租约里记录的上一次批准态**判断，不依赖内存会话。
        // 真实撤销是 `rehandshake()`：先 close 再 connect，broker 的 onClose 早已把
        // extensionSession 置空——依赖它会漏记，且是否漏记取决于 close 与新 hello 的先后。
        // 不能只看 deviceId：整机只有一份设备身份，Edge 与 Chrome 的 deviceId 必然相同。
        if (lease?.channelKey === incomingKey && lease.approved === true && msg.deviceApproved === false) {
            audit.append("device_revoked", { deviceId: msg.deviceId, extId: msg.extId ?? null });
        }
        if (extensionSession && extensionSession.peer && extensionSession.peer !== peer) {
            audit.append("kicked_old", {
                extId: extensionSession.extId,
                reason: isTakeover ? "switched" : "reconnected",
                toChannel: incomingKey,
            });
            // 只有「换浏览器」才算连接风暴；同一浏览器重连（SW 被回收）不该触发告警
            if (isTakeover) alerts.noteKickedOld();
            try {
                extensionSession.peer.close(4000, isTakeover ? "switched" : "reconnected");
            } catch {
                /* 旧连接已死 */
            }
        }
        if (isTakeover) {
            audit.append("channel_switched", { from: lease.channelKey, fromFamily: lease.family ?? null, to: incomingKey, toFamily: msg.browserFamily ?? null });
        }
        activeChannel.claim({
            channelKey: incomingKey,
            family: msg.browserFamily ?? null,
            extId: msg.extId ?? null,
            approved: msg.deviceApproved === true,
        });
        extensionSession = {
            peer,
            extId: msg.extId ?? null,
            version: msg.version ?? null,
            browserFamily: msg.browserFamily ?? "unknown",
            agentEnabled: msg.agentEnabled === true,
            deviceApproved: msg.deviceApproved === true,
            deviceId: msg.deviceId ?? null,
            device: msg.pendingDevice ?? null,
            vip: msg.vip ?? null,
            quota: msg.quota ?? null,
            helloAt: now(),
        };
        audit.append("hello_ok", {
            extId: extensionSession.extId,
            version: extensionSession.version,
            browserFamily: extensionSession.browserFamily,
            agentEnabled: extensionSession.agentEnabled,
            deviceApproved: extensionSession.deviceApproved,
        });
        // 浏览器家族/extId 记录（引导期第 1 步）+ 解析固化
        browserManager.recordExtension({ family: extensionSession.browserFamily, extId: extensionSession.extId });
        alerts.noteExtensionConnected();
        lastExtensionExtId = extensionSession.extId;
        // 会话快照（详细设计 §5.2 #1）：hello 写 session 段，并主动拉一次 list_datasets 覆盖 datasets 段。
        // 每次重连都做——同时兜住「用户离线期间手动改过数据」。刷新失败静默
        snapshotStore.writeSession({
            extId: extensionSession.extId,
            browserFamily: extensionSession.browserFamily,
            vip: extensionSession.vip,
            quota: extensionSession.quota,
            lastSeenAt: now(),
        });
        audit.append("snapshot_session_written", { extId: extensionSession.extId });
        refreshDatasets();
        const resolved = browserManager.ensureResolved();
        if (!resolved.ok) {
            audit.append("browser_resolve_pending", { message: resolved.message });
        }
        dispatchPendingTasks();
    }

    // ------------------------------------------------------------------
    // HTTP
    // ------------------------------------------------------------------

    /** 已签发的 adapter 会话 token（register 签名验证后签发；Phase 1 对 /v1/mcp 不强制） */
    const adapterTokens = new Map();

    function verifyRegisterSignature(body) {
        if (!identity || !body?.hostKey || !Number.isFinite(body?.timestamp) || typeof body?.signature !== "string") {
            return false;
        }
        // 时间窗 ±60s，防重放
        if (Math.abs(now() - body.timestamp) > 60_000) return false;
        const payload = Buffer.from(`hongtan-agent|register|${body.hostKey}|${body.timestamp}`, "utf8");
        try {
            const publicKey = crypto.createPublicKey({
                key: Buffer.from(identity.publicKey, "base64"),
                format: "der",
                type: "spki",
            });
            return crypto.verify(null, payload, publicKey, Buffer.from(body.signature, "base64"));
        } catch {
            return false;
        }
    }

    async function handleHttpRequest(req, res) {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
        if (req.method === "GET" && url.pathname === "/health") {
            const active = taskStore.activeTask();
            reply(res, 200, {
                ok: true,
                version: BROKER_VERSION,
                // 运行时指纹（问题清单 4.2/4.3）：pid/startedAt/contractsHash 让「键不存在 vs 键为 null」
                // 可机判——与 adapter 侧哈希比对即证伪运行进程是否旧于源码
                pid: process.pid,
                startedAt: new Date(startedAt).toISOString(),
                contractsHash,
                buildId: BUILD_ID,
                mode: process.versions.bun ? "standalone" : "node",
                node: process.version,
                uptimeSec: Math.round((now() - startedAt) / 1000),
                extension: {
                    connected: sessionFacade.isConnected(),
                    lastSeenAt: extensionLastSeenAt || null,
                },
                // 占用通道（脱敏）：UI 与排障据此回答"现在由哪个浏览器接管"
                channel: activeChannel.describePublic(),
                tasks: { active: taskStore.activeCount(), total: taskStore.size() },
                activeTaskId: active?.id ?? null,
                // 注意 config 里两个字段语义不同：family 是"当前连接方"，exe/profileDir 是
                // "上次成功解析的结果"，二者可以不一致（换浏览器后尚未重解析）——
                // 判断解析结果是否当前有效，看 resolvedForFamily / resolvedForExtId。
                browser: browserManager.getStatus(),
                // 只读会话快照诊断（详细设计 §2.5）：exists/refreshedAt/sessionUpdatedAt/datasetCount
                snapshot: snapshotStore.getStatus(),
                keepAwakeHeld: keepAwake.isHeld(),
                recentTasks: taskStore
                    .list({ limit: 5 })
                    .map((id) => taskStore.snapshot(taskStore.get(id)))
                    .filter(Boolean),
            });
            return true;
        }
        if (req.method === "POST" && url.pathname === "/v1/mcp") {
            const body = await readJsonBody(req, res);
            if (body === null) return true;
            const requestId = typeof req.headers["x-hongtan-request-id"] === "string" ? req.headers["x-hongtan-request-id"] : null;
            if (requestId) {
                const replayed = replayGet(requestId);
                if (replayed) {
                    reply(res, 200, replayed);
                    return true;
                }
            }
            // 问题清单 1.1：整个等待期零字节写出正是触发 undici HeadersTimeoutError 的形态——
            // 进入即预写头，执行期间每 10s 写一个空格（合法 JSON 前导空白，resp.json() 可解析）
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.flushHeaders?.();
            const keepAlive = setInterval(() => {
                if (!res.writableEnded) res.write(" ");
            }, 10_000);
            let result;
            try {
                result = await tools.executeTool(body.tool, body.args, { adapterFingerprint: adapterFingerprintFrom(req) });
                if (requestId) replayPut(requestId, result);
            } catch (e) {
                logger.warn?.("[broker] 工具执行异常:", e?.message ?? e);
                result = { ok: false, error: { code: "BROKER_ERROR", message: e?.message ?? String(e) } };
            } finally {
                clearInterval(keepAlive);
            }
            res.end(JSON.stringify(result));
            return true;
        }
        if (req.method === "POST" && url.pathname === "/v1/adapters/register") {
            const body = await readJsonBody(req, res);
            if (body === null) return true;
            if (!verifyRegisterSignature(body)) {
                audit.append("adapter_register_rejected", { hostKey: body?.hostKey });
                reply(res, 401, { ok: false, error: { code: "DEVICE_NOT_APPROVED", message: "register 签名校验失败" } });
                return true;
            }
            const token = crypto.randomUUID();
            adapterTokens.set(token, now() + 24 * 60 * 60 * 1000);
            audit.append("adapter_registered", { hostKey: body.hostKey, displayName: body.displayName });
            reply(res, 200, { ok: true, token });
            return true;
        }
        if (req.method === "POST" && url.pathname === "/v1/channel/reset") {
            // 只处理**离线/无主**租约（幽灵占用、占用者已退出）。
            // 在线占用者受保护：否则任意本机进程一条 HTTP 就能打断用户正在用的浏览器，
            // 而"用户主动让出"有专门通道（WS `channel.release`，由当前会话本人发出）。
            const body = await readJsonBody(req, res);
            if (body === null) return true;
            const before = activeChannel.describe();
            if (before?.online) {
                audit.append("channel_reset_rejected", {
                    reason: "occupied-online",
                    activeFamily: before.family ?? null,
                    requested: typeof body?.reason === "string" ? body.reason : null,
                });
                reply(res, 409, {
                    ok: false,
                    error: {
                        code: "CHANNEL_OCCUPIED_ONLINE",
                        message: "占用者仍在线，请使用「切换到此浏览器」而不是重置",
                    },
                    channel: activeChannel.describePublic(),
                });
                return true;
            }
            const released = activeChannel.release();
            audit.append("channel_reset", {
                released,
                previousFamily: before?.family ?? null,
                reason: typeof body?.reason === "string" ? body.reason : null,
            });
            reply(res, 200, { ok: true, released });
            return true;
        }
        if (req.method === "POST" && url.pathname === "/v1/adapters/heartbeat") {
            const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
            if (adapterTokens.has(token)) {
                adapterTokens.set(token, now() + 24 * 60 * 60 * 1000);
                reply(res, 200, { ok: true });
            } else {
                reply(res, 401, { ok: false, error: { code: "DEVICE_NOT_APPROVED", message: "会话 token 无效或已过期" } });
            }
            return true;
        }
        return false;
    }

    function readJsonBody(req, res) {
        return new Promise((resolve) => {
            const chunks = [];
            let size = 0;
            req.on("data", (chunk) => {
                size += chunk.length;
                if (size > 1_000_000) {
                    req.destroy();
                    resolve(null);
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                } catch {
                    reply(res, 400, { ok: false, error: { code: "INVALID_JSON", message: "请求体不是合法 JSON" } });
                    resolve(null);
                }
            });
            req.on("error", () => resolve(null));
        });
    }

    function reply(res, status, body) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
    }

    // ------------------------------------------------------------------
    // 服务端
    // ------------------------------------------------------------------

    const startedAt = now();
    /** @type {any[]} */
    const timers = [];
    let wss = null;
    let boundAddress = null;

    return {
        async listen() {
            await autostart?.ensure?.();
            wss = createLoopbackWebSocketServer({
                port: config.port,
                path: "/extension",
                serviceName: "hongtan-agent-broker",
                now,
                // 抓取 + 硬化：退避冷却期内直接拒绝升级（建立会话前就挡住，否则 churn 依旧）
                // 状态码固定 429（服务端硬编码）：拒的是「请求过多」而非认证/业务校验，别与 401/400 语义混用
                refuseUpgrade: (request) => {
                    const extId = extIdFromOrigin(request?.headers?.origin);
                    return handshakeBackoff.isBlocked(extId) ? { reason: "legacy-client-cooldown", retryAfterSec: 60 } : null;
                },
                onHttpRequest: handleHttpRequest,
                onConnection: (peer, request) => {
                    // 抓取：把来源钉在连接上，供所有审计与退避复用（Origin 与端口都取自 request，无需额外系统调用）
                    peer._origin = String(request?.headers?.origin ?? "");
                    peer._remotePort = request?.socket?.remotePort ?? null;
                    peer._extIdFromOrigin = extIdFromOrigin(peer._origin);
                    audit.append("ws_open", { origin: peer._origin, remotePort: peer._remotePort });
                    let helloSeen = false;
                    const helloDeadline = setTimeout(() => {
                        if (!helloSeen) {
                            audit.append("hello_reject", {
                                reason: "5s 内未收到 hello",
                                origin: peer._origin,
                                extId: peer._extIdFromOrigin,
                                remotePort: peer._remotePort,
                            });
                            if (handshakeBackoff.noteFailure(peer._extIdFromOrigin)) {
                                alerts.noteLegacyProtocolClient({ extId: peer._extIdFromOrigin, origin: peer._origin });
                            }
                            peer.close(4001, "hello timeout");
                        }
                    }, 5_000);
                    peer._helloDeadline = helloDeadline;
                    // 保活：20s ping / 60s 无消息 terminate（§10.1 心跳语义）
                    let lastMessageAt = now();
                    const originalHandler = null;
                    void originalHandler;
                    const pingTimer = setInterval(() => {
                        if (!peer.isOpen) return;
                        if (now() - lastMessageAt > 60_000) {
                            audit.append("ping_timeout", {});
                            peer.close(1001, "ping timeout");
                            return;
                        }
                        peer.send({ type: "extension.ping" });
                    }, 20_000);
                    peer._pingTimer = pingTimer;
                    peer._touch = () => {
                        lastMessageAt = now();
                    };
                    peer._setHelloSeen = () => {
                        helloSeen = true;
                        clearTimeout(helloDeadline);
                    };
                },
                onMessage: (msg, peer) => {
                    peer._touch?.();
                    if (msg.type === "extension.hello") peer._setHelloSeen?.();
                    handleExtensionMessage(peer, msg);
                },
                onClose: (peer) => {
                    clearTimeout(peer._helloDeadline);
                    clearInterval(peer._pingTimer);
                    audit.append("ws_close", {});
                    if (extensionSession?.peer === peer) {
                        extensionSession = null;
                        audit.append("extension_disconnected", {});
                        alerts.noteExtensionDisconnected();
                    }
                },
            });
            await wss.listen();
            boundAddress = wss.server.address();
            audit.append("broker_start", { port: boundAddress?.port ?? config.port, version: BROKER_VERSION });

            // watchdog：账本 TTL 清理 + challenge 过期清理 + 等待扩展连接的任务重试拉起 + 告警判定（1 分钟）
            timers.push(
                setInterval(() => {
                    taskStore.sweep();
                    pairing.sweepExpired();
                    retryLaunchForWaitingTasks();
                    alerts.tick({ activeTask: taskStore.activeTask() });
                }, 60_000)
            );
        },

        async close() {
            for (const t of timers) clearInterval(t);
            tools.dispose();
            await wss?.close();
        },

        /** 实际绑定地址（port=0 时由 OS 分配；listen 后可用） */
        address: () => boundAddress,

        // 测试钩子
        _internals: {
            taskStore,
            audit,
            tools,
            pairing,
            activeChannel,
            browserManager,
            keepAwake,
            alerts,
            snapshotStore,
            sessionFacade,
            handleExtensionMessage,
            handleHello,
            verifyRegisterSignature,
            adapterTokens,
            refreshKeepAwake,
            probes: effectiveProbes,
            getExtensionSession: () => extensionSession,
            setExtensionSession: (s) => {
                extensionSession = s;
            },
        },
    };
}

// ====================================================================
// 单例启动（进程入口）
// ====================================================================

// 直接运行判定：node 直跑本文件（import.meta.main），或经 runtime-entry/adapter 以 broker
// 角色启动（standalone 产物里靠角色环境变量）。不能用 import.meta.url === argv[1] 判定：
// Bun 编译产物里所有捆绑模块的 import.meta.url 都等于入口虚拟路径，会让 adapter 进程
// 误入 broker 启动块（实测复现）
const isDirectRun = import.meta.main || process.env.HONGTAN_AGENT_ROLE === "broker";

if (isDirectRun) {
    // 单例：探测 /health 复用既有实例（EADDRINUSE 兜底退出）
    const config = loadConfig();
    const probe = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false);
    if (probe) {
        console.error(`[broker] Broker 已在运行（http://127.0.0.1:${config.port}/health），本进程退出`);
        process.exit(0);
    }

    const contracts = contractsJson;
    const identity = await loadOrCreateDeviceIdentity({ host: config.hostKey }).catch((e) => {
        console.error("[broker] 设备身份初始化失败:", e);
        return null;
    });
    if (identity) {
        console.error(`[broker] 设备身份: ${identity.deviceId}（指纹 ${identity.fingerprint}）`);
    }

    const keepAwake = createKeepAwake({ logger: console });
    const broker = createBroker({
        config,
        contracts,
        identity,
        autostart: createAutostart({ logger: console }),
        keepAwake,
    });
    broker.listen().then(() => {
        console.error(`[broker] listening on http://127.0.0.1:${config.port}`);
        console.error(`[broker]   health : GET  http://127.0.0.1:${config.port}/health`);
        console.error(`[broker]   tools  : POST http://127.0.0.1:${config.port}/v1/mcp  {tool, args}`);
        console.error(`[broker]   ws     : ws://127.0.0.1:${config.port}/extension`);
    });

    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
}
