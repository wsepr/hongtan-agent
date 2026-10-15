/**
 * [hongtan-agent] Adapter：stdio MCP Server（WorkBuddy 接入点，薄，仅协议转发）
 *
 * 职责（设计文档 §6.2 / 执行计划 S1 工作项 7）：
 * - MCP stdio（换行分隔 JSON-RPC 2.0）：initialize / tools/list / tools/call
 * - tools/list 直接来自 contracts/xhs-agent-tools-v1.json（唯一真源）
 * - tools/call 经 HTTP loopback 转发给 Broker 的 /v1/mcp
 * - Broker 自启动：探测 /health，未运行则 spawn detached 拉起单例（设计文档 §6.2）
 * - /v1/adapters/register 设备签名注册（Phase 1 对 /v1/mcp 不强制 token）
 *
 * 日志一律走 stderr（stdout 保留给 MCP 协议）。
 */

import readline from "node:readline";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./broker-server.mjs";
import { createBrokerLauncher } from "./broker-launcher.mjs";
import { loadOrCreateDeviceIdentity } from "./device-identity.mjs";
import { classifyTransportError, shouldAutoRetry } from "./mcp-retry-policy.mjs";
import { contractsFingerprint, resolveBuildId } from "./build-fingerprint.mjs";
import { AGENT_VERSION } from "./version.mjs";
// 静态 import 而非 fs 读取：standalone 产物（bun compile）不内嵌运行时 readFileSync 的文件，
// 只内嵌模块图里的资源；Node 侧 JSON import attributes 自 20.10 起稳定
import contracts from "../contracts/xhs-agent-tools-v1.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = loadConfig();

const SERVER_INFO = { name: "hongtan-agent", version: AGENT_VERSION };
const BROKER_BASE = `http://127.0.0.1:${CONFIG.port}`;
const brokerPath = path.join(__dirname, "broker-server.mjs");
const hostKey = process.env.HONGTAN_AGENT_HOST ?? "workbuddy";
const displayName = process.env.HONGTAN_AGENT_DEVICE_NAME ?? `红探 Agent (${hostKey})`;

// 运行时指纹（问题清单 4.3）：随每次 /v1/mcp 上送，broker 在 connection_status 的 runtime 块里
// 回表比对——contractsHash 不等即证明有一方是旧进程
const ADAPTER_FINGERPRINT = {
    version: AGENT_VERSION,
    buildId: resolveBuildId(),
    contractsHash: contractsFingerprint(contracts),
};

function adapterFingerprintHeaders() {
    return {
        "X-Hongtan-Adapter-Version": ADAPTER_FINGERPRINT.version,
        "X-Hongtan-Adapter-Build-Id": ADAPTER_FINGERPRINT.buildId,
        "X-Hongtan-Adapter-Contracts-Hash": ADAPTER_FINGERPRINT.contractsHash,
    };
}

// ====================================================================
// MCP 工具定义（来自 contracts；description 已内置 AI 行为约定，M2 实证基线）
// ====================================================================

const TOOLS = contracts.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
}));

/** server instructions 兜底摘要（宿主不支持 skills 时经 initialize 下发） */
function loadInstructions() {
    try {
        return fs.readFileSync(path.join(__dirname, "../skills/xhs-crawl/instructions-summary.md"), "utf8");
    } catch {
        return undefined;
    }
}

// ====================================================================
// Broker 自启动 + 设备注册
// ====================================================================

function probeHealth() {
    return fetch(`${BROKER_BASE}/health`, { signal: AbortSignal.timeout(1000) })
        .then((r) => r.ok)
        .catch(() => false);
}

/** 取 /health 的 JSON（供 contractsHash 比对）；失败返回 null */
async function probeHealthJson() {
    try {
        const resp = await fetch(`${BROKER_BASE}/health`, { signal: AbortSignal.timeout(1500) });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/**
 * ensure + 契约指纹一致性预检（问题清单 4.3）：
 * broker /health 报告的 contractsHash 与本侧不等 ⇒ 有一方是旧进程 → invalidate 重拉一次；
 * 仍不等 ⇒ 返回 stale 详情，由调用方回 RUNTIME_STALE（不做远程杀进程）。
 * 旧 broker 的 /health 无 contractsHash 字段 ⇒ 无法证伪，放行（兼容旧行为）。
 * 结果缓存 10s，避免每次工具调用都多一跳 /health。
 */
let lastCompatCheck = { at: 0, stale: null };
async function ensureCompatibleBroker() {
    if (!(await ensureBroker())) return { ok: false, stale: null };
    // 缓存命中也回读 stale 结论：RUNTIME_STALE 一经判定，整个缓存窗口内持续拦截，
    // 不给「AI 在 10s 内重试后绕过检查直打旧 broker」留窗口
    if (Date.now() - lastCompatCheck.at < 10_000) return { ok: true, stale: lastCompatCheck.stale };
    const health = await probeHealthJson();
    if (health?.contractsHash && health.contractsHash !== ADAPTER_FINGERPRINT.contractsHash) {
        launcher.invalidate();
        if (!(await ensureBroker())) return { ok: false, stale: null };
        const retry = await probeHealthJson();
        if (retry?.contractsHash && retry.contractsHash !== ADAPTER_FINGERPRINT.contractsHash) {
            lastCompatCheck = { at: Date.now(), stale: retry };
            return { ok: true, stale: retry };
        }
    }
    lastCompatCheck = { at: Date.now(), stale: null };
    return { ok: true, stale: null };
}

function runtimeStaleResult(stale) {
    return resultText(
        {
            ok: false,
            error: {
                code: "RUNTIME_STALE",
                message: `运行进程旧于当前契约（broker contractsHash=${stale.contractsHash}，adapter=${ADAPTER_FINGERPRINT.contractsHash}，pid=${stale.pid ?? "未知"}）。结束该进程后，下一次工具调用会自动重拉新版本，无需重启宿主。`,
                context: {
                    brokerContractsHash: stale.contractsHash,
                    adapterContractsHash: ADAPTER_FINGERPRINT.contractsHash,
                    brokerPid: stale.pid ?? null,
                },
            },
        },
        true
    );
}

/**
 * Broker 自启（幂等 + 可重试）：探测 /health，未运行则 spawn detached 拉起单例。
 * 失败与自愈语义见 `broker-launcher.mjs`——旧实现把「拉起失败」也永久缓存，导致此后
 * 每次调用都直接回 BROKER_UNREACHABLE、不再重试，用户只能重启宿主。
 */
const launcher = createBrokerLauncher({
    probeHealth,
    spawnBroker: () => {
        // 带角色环境变量：standalone 产物里 process.execPath 是编译后的 exe 本身，
        // runtime-entry 靠 HONGTAN_AGENT_ROLE 分流；node 模式下该变量无副作用
        spawn(process.execPath, [brokerPath], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            env: { ...process.env, HONGTAN_AGENT_ROLE: "broker" },
        }).unref();
    },
    logger: console,
});

function ensureBroker() {
    return launcher.ensure();
}

let sessionToken = null;
async function registerWithBroker() {
    try {
        const identity = await loadOrCreateDeviceIdentity({ host: hostKey, displayName });
        const timestamp = Date.now();
        const payload = Buffer.from(`hongtan-agent|register|${hostKey}|${timestamp}`, "utf8");
        const resp = await fetch(`${BROKER_BASE}/v1/adapters/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                hostKey,
                displayName,
                version: SERVER_INFO.version,
                timestamp,
                signature: identity.sign(payload),
            }),
            signal: AbortSignal.timeout(5000),
        });
        const json = await resp.json();
        if (json.ok) {
            sessionToken = json.token;
            console.error(`[adapter] 已注册（deviceId=${identity.deviceId}，指纹=${identity.fingerprint}）`);
        } else {
            console.error(`[adapter] 注册被拒（Phase 1 不影响工具调用）: ${json?.error?.message}`);
        }
    } catch (e) {
        console.error("[adapter] 注册异常（Phase 1 不影响工具调用）:", e?.message);
    }
}

// ====================================================================
// JSON-RPC over stdio（换行分隔）
// ====================================================================

function writeMessage(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * 传输层错误分类与重试判定在 `mcp-retry-policy.mjs`（纯函数，可单测）：
 * 仅「请求确定未抵达 Broker」可无条件重发；「已派发、结果未知」仅幂等只读工具
 * 可重发（requestId 复用 + Broker 侧回放兜底）；本方超时/宿主取消一律不重试，
 * 避免重复执行有副作用的工具。
 */

function resultText(payload, isError = false) {
    const result = { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    if (isError) result.isError = true;
    return result;
}

const BROKER_UNREACHABLE_RESULT = () =>
    resultText(
        {
            ok: false,
            error: {
                code: "BROKER_UNREACHABLE",
                message: "Broker 未运行且拉起失败。请手动执行 node scripts/broker-server.mjs 后重试",
            },
        },
        true
    );

const BROKER_NO_RESPONSE_RESULT = () =>
    resultText(
        {
            ok: false,
            error: {
                code: "BROKER_NO_RESPONSE",
                message:
                    "请求已送达 Broker 但未在时限内收到响应，执行结果未知。先调 xhs_task_status 确认是否已生效，不要直接重发本调用。",
                context: { possiblyExecuted: true },
            },
        },
        true
    );

async function postToolCall(tool, args, { requestId, signal } = {}) {
    const resp = await fetch(`${BROKER_BASE}/v1/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...adapterFingerprintHeaders(),
            ...(requestId ? { "X-Hongtan-Request-Id": requestId } : {}),
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({ tool, args }),
        // 单次调用必须远小于宿主 ≈60s 的放弃线（问题清单 1.1）；45s 由本方先响、产出结构化错误
        signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
    });
    const payload = await resp.json();
    return resultText(payload, payload.ok === false);
}

async function callBroker(tool, args, { signal } = {}) {
    const ready = await ensureCompatibleBroker();
    if (!ready.ok) return BROKER_UNREACHABLE_RESULT();
    if (ready.stale) return runtimeStaleResult(ready.stale);
    const requestId = crypto.randomUUID();
    try {
        return await postToolCall(tool, args, { requestId, signal });
    } catch (e) {
        const cls = classifyTransportError(e);
        // cancelled（本方 45s 超时/宿主取消）与非白名单工具的 response_unknown 都不自动重发：
        // 此时请求已送达、结果未知，统一返回结构化 BROKER_NO_RESPONSE（宿主取消的结果
        // 本就被 dispatch 丢弃，不影响该路径；本方超时是「已派发、结果未知」的典型形态）
        if (!shouldAutoRetry(cls, tool)) return BROKER_NO_RESPONSE_RESULT();
        // not_reached → Broker 已掉线：清健康缓存后重新探测/拉起；response_unknown（幂等工具）→ Broker 仍活着，直接重发
        if (cls === "not_reached") {
            launcher.invalidate();
            if (!(await ensureBroker())) return BROKER_UNREACHABLE_RESULT();
        }
        try {
            return await postToolCall(tool, args, { requestId, signal });
        } catch {
            // 重发仍失败：按首次分类给出结构化码，不产出契约外的裸错误
            return cls === "not_reached" ? BROKER_UNREACHABLE_RESULT() : BROKER_NO_RESPONSE_RESULT();
        }
    }
}

const pendingCalls = new Map();

async function dispatch(msg) {
    const { id, method, params } = msg;
    switch (method) {
        case "initialize":
            writeMessage({
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: params?.protocolVersion ?? "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: SERVER_INFO,
                    ...(loadInstructions() ? { instructions: loadInstructions() } : {}),
                },
            });
            void ensureBroker().then(registerWithBroker);
            return;
        case "notifications/initialized":
        case "notifications/roots/list_changed":
            return;
        case "notifications/cancelled": {
            // 宿主放弃某次 tools/call：abort 对应的 in-flight 请求（Broker 忙等随即终止）。
            // 宿主已不等待结果，因此不写回任何消息。
            const controller = pendingCalls.get(params?.requestId);
            if (controller) {
                controller.abort();
                pendingCalls.delete(params.requestId);
            }
            return;
        }
        case "ping":
            writeMessage({ jsonrpc: "2.0", id, result: {} });
            return;
        case "tools/list":
            writeMessage({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
            return;
        case "tools/call": {
            const controller = new AbortController();
            if (id !== undefined) pendingCalls.set(id, controller);
            try {
                const result = await callBroker(params?.name, params?.arguments ?? {}, { signal: controller.signal });
                if (!controller.signal.aborted) {
                    writeMessage({ jsonrpc: "2.0", id, result });
                }
            } finally {
                if (id !== undefined) pendingCalls.delete(id);
            }
            return;
        }
        default:
            writeMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `未知方法: ${method}` } });
    }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
        msg = JSON.parse(trimmed);
    } catch (e) {
        console.error("[adapter] 非 JSON 行已忽略:", e?.message);
        return;
    }
    if (!msg.method) return;
    dispatch(msg).catch((e) => {
        console.error("[adapter] dispatch 异常:", e);
        if (msg.id !== undefined) {
            writeMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e?.message ?? String(e) } });
        }
    });
});

console.error(`[adapter] ${SERVER_INFO.name}@${SERVER_INFO.version} 已启动（broker: ${BROKER_BASE}, host: ${hostKey}）`);
