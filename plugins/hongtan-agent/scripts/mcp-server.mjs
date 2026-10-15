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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./broker-server.mjs";
import { createBrokerLauncher } from "./broker-launcher.mjs";
import { loadOrCreateDeviceIdentity } from "./device-identity.mjs";
import { AGENT_VERSION } from "./version.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = loadConfig();

const SERVER_INFO = { name: "hongtan-agent", version: AGENT_VERSION };
const BROKER_BASE = `http://127.0.0.1:${CONFIG.port}`;
const brokerPath = path.join(__dirname, "broker-server.mjs");
const contractsPath = path.join(__dirname, "../contracts/xhs-agent-tools-v1.json");

const contracts = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
const hostKey = process.env.HONGTAN_AGENT_HOST ?? "workbuddy";
const displayName = process.env.HONGTAN_AGENT_DEVICE_NAME ?? `红探 Agent (${hostKey})`;

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
 * 连不上 Broker（进程被杀/崩溃/尚未就绪）与「请求已送出但响应超时」要区别对待：
 * 前者可安全重试（重新拉起 + 重发），后者重试可能**重复执行**一个有副作用的工具
 * （如 `xhs_start_crawl` 起两个任务），故超时/取消一律不重试，如实把错误抛给宿主。
 */
function isConnectionFailure(error) {
    if (!error) return false;
    if (error.name === "TimeoutError" || error.name === "AbortError") return false;
    return true;
}

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

async function postToolCall(tool, args) {
    const resp = await fetch(`${BROKER_BASE}/v1/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({ tool, args }),
        // wait_for_task 最长 300s；留出协议层余量
        signal: AbortSignal.timeout(330_000),
    });
    const payload = await resp.json();
    return resultText(payload, payload.ok === false);
}

async function callBroker(tool, args) {
    if (!(await ensureBroker())) return BROKER_UNREACHABLE_RESULT();
    try {
        return await postToolCall(tool, args);
    } catch (e) {
        if (!isConnectionFailure(e)) {
            return resultText({ ok: false, error: { code: "BROKER_ERROR", message: e?.message ?? String(e) } }, true);
        }
        // 连接被拒 → Broker 已掉线：清健康缓存后重新探测/拉起，并重发一次
        launcher.invalidate();
        if (!(await ensureBroker())) return BROKER_UNREACHABLE_RESULT();
        try {
            return await postToolCall(tool, args);
        } catch (e2) {
            return resultText({ ok: false, error: { code: "BROKER_ERROR", message: e2?.message ?? String(e2) } }, true);
        }
    }
}

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
        case "notifications/cancelled":
        case "notifications/roots/list_changed":
            return;
        case "ping":
            writeMessage({ jsonrpc: "2.0", id, result: {} });
            return;
        case "tools/list":
            writeMessage({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
            return;
        case "tools/call": {
            const result = await callBroker(params?.name, params?.arguments ?? {});
            writeMessage({ jsonrpc: "2.0", id, result });
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
