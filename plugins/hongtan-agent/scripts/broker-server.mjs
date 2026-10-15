/**
 * [hongtan-agent] Broker：本机常驻单例进程（执行计划 S1/S2 装配层）
 *
 * 职责（设计文档 §5/§6/§10）：
 * - WebSocket 服务端（ws://127.0.0.1:17373/extension）：challenge/proof 配对 + hello + 心跳 + 命令白名单
 * - HTTP loopback：GET /health + POST /v1/mcp（工具执行）+ /v1/adapters/register|heartbeat
 * - 任务账本（24h TTL）+ 配额 + 审计日志 + 浏览器幂等拉起 + 任务期阻止休眠 + 开机自启
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
import { createQuota } from "./broker/quota.mjs";
import { createActionLimiter } from "./broker/rate-limit.mjs";
import { createAlertMonitor } from "./broker/alerts.mjs";
import { createAudit } from "./broker/audit.mjs";
import { createPairing } from "./broker/pairing.mjs";
import { createToolExecutor, buildTaskLaunchUrl } from "./broker/tools.mjs";
import { createBrowserManager } from "./broker/browser/index.mjs";
import { createOsProbes } from "./broker/browser/os-probes.mjs";
import { loadOrCreateDeviceIdentity, resolveStateDirectory } from "./device-identity.mjs";
import { createKeepAwake } from "./keep-awake.mjs";
import { createAutostart } from "./autostart.mjs";
// 静态 import 而非 fs 读取：standalone 产物（bun compile）不内嵌运行时 readFileSync 的文件
import contractsJson from "../contracts/xhs-agent-tools-v1.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BROKER_VERSION = "0.1.0";

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
        minIntervalMs: Number(env.HONGTAN_AGENT_MIN_INTERVAL_MS ?? 10 * 60 * 1000),
        maxTasks24h: Number(env.HONGTAN_AGENT_MAX_TASKS_24H ?? 24),
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

    const audit = createAudit({ filePath: config.auditPath, now });
    // §11.6 告警监控：把「会静默自愈」的问题升级为可归因告警（离线超时 / 心跳停摆 / 恢复耗尽 / 连接风暴）
    const alerts = createAlertMonitor({ now, audit, logger, thresholds: config.alertThresholds });
    const taskStore = createTaskStore({
        ledgerPath: config.ledgerPath,
        now,
        logger,
        // 账本任何变更后重算保活（§10.7 环①）：挂在账本层，避免新增转移路径时漏掉
        onChanged: () => refreshKeepAwake(),
    });
    const quota = createQuota({ now, minIntervalMs: config.minIntervalMs, maxPer24h: config.maxTasks24h });
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
    });

    /** @type {{peer: any, extId: string, version: string, browserFamily: string, agentEnabled: boolean, deviceApproved: boolean, device: any, vip: any, helloAt: number} | null} */
    let extensionSession = null;
    let extensionLastSeenAt = 0;
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
     * ensureRunning 自带 30s 防抖，故 1 分钟一轮不会造成拉起风暴。
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
            });
        } catch (e) {
            logger.warn?.("[broker] 重试拉起浏览器失败:", e?.message ?? e);
        }
    }

    const sessionFacade = {
        isConnected: () => !!(extensionSession?.peer?.isOpen),
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
                      onboarding: buildOnboardingHint(),
                  }
                : { connected: false, onboarding: buildOnboardingHint() },
        sendTaskStart: (task, { resume = false } = {}) =>
            sendToExtension({
                type: "task.start",
                taskId: task.id,
                kind: task.kind,
                params: task.params,
                // 显式续接（§8.3）：带 resumeOf 的 task.start 让插件把暂停中的任务推回 running
                ...(resume ? { resumeOf: task.id } : {}),
            }),
        sendTaskCancel: (taskId) => sendToExtension({ type: "task.cancel", taskId }),
        syncRequest: (action, params, timeoutMs) =>
            new Promise((resolve) => {
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
            }),
    };

    function buildOnboardingHint() {
        if (!extensionSession) {
            return "请打开安装红探插件的浏览器，并在红探插件设置 →「Agent 接管」中开启开关";
        }
        if (!extensionSession.agentEnabled) {
            return "请在红探插件设置 →「Agent 接管」中开启开关";
        }
        if (!extensionSession.deviceApproved) {
            return "请在红探插件设置 →「Agent 接管」→ 设备管理中核对本机指纹并点击批准";
        }
        return null;
    }

    const tools = createToolExecutor({
        contracts,
        taskStore,
        quota,
        audit,
        session: sessionFacade,
        browserManager,
        rateLimiter: actionLimiter,
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
            if (sessionFacade.sendTaskStart(task)) {
                taskStore.setState(task, "running");
                audit.append("task_dispatched", { taskId: task.id, via: "hello-redelivery" });
            }
        }
    }

    // ------------------------------------------------------------------
    // WS 会话处理
    // ------------------------------------------------------------------

    function handleExtensionMessage(peer, msg) {
        extensionLastSeenAt = now();

        // 未完成 hello：仅接受 challenge/proof 与 hello
        if (!extensionSession || extensionSession.peer !== peer) {
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
            if (msg.type === "session.proof.error") {
                audit.append("session_proof_error", { code: msg.code, message: msg.message });
                return;
            }
            // hello 前的其余消息一律忽略（白名单外不响应）
            audit.append("ws_message_before_hello", { type: msg?.type ?? "unknown" });
            return;
        }

        switch (msg.type) {
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
        // 撤销留痕（§11.1）：同一设备此前已批准、本次重连却报告未批准 → 判定为插件侧已撤销
        if (
            extensionSession &&
            extensionSession.deviceId &&
            msg.deviceId === extensionSession.deviceId &&
            extensionSession.deviceApproved === true &&
            msg.deviceApproved === false
        ) {
            audit.append("device_revoked", { deviceId: msg.deviceId, extId: msg.extId ?? null });
        }
        if (extensionSession && extensionSession.peer && extensionSession.peer !== peer) {
            audit.append("kicked_old", { extId: extensionSession.extId });
            alerts.noteKickedOld();
            try {
                extensionSession.peer.close(4000, "replaced");
            } catch {
                /* 旧连接已死 */
            }
        }
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
                uptimeSec: Math.round((now() - startedAt) / 1000),
                extension: {
                    connected: sessionFacade.isConnected(),
                    lastSeenAt: extensionLastSeenAt || null,
                },
                tasks: { active: taskStore.activeCount(), total: taskStore.size() },
                activeTaskId: active?.id ?? null,
                browser: browserManager.getStatus(),
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
            const result = await tools.executeTool(body.tool, body.args);
            reply(res, 200, result);
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
                onHttpRequest: handleHttpRequest,
                onConnection: (peer) => {
                    audit.append("ws_open", {});
                    let helloSeen = false;
                    const helloDeadline = setTimeout(() => {
                        if (!helloSeen) {
                            audit.append("hello_reject", { reason: "5s 内未收到 hello" });
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
            quota,
            audit,
            tools,
            pairing,
            browserManager,
            keepAwake,
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
