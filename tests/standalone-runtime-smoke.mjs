/**
 * standalone 运行时冒烟（CI 对 `bun build --compile` 产物实跑）：
 * adapter（stdio MCP）+ Broker 自启 + 设备身份（ed25519）在编译产物里可用。
 *
 * 注意：initialize 会触发 adapter 幂等拉起 Broker（detached），smoke 结束杀掉 adapter
 * 后 Broker 可能残留——CI runner 用后即弃，无碍；本地复跑请换端口或先杀进程。
 *
 * 用法：node tests/standalone-runtime-smoke.mjs dist/<asset>
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { AGENT_VERSION } = await import(
    path.join(root, "plugins", "hongtan-agent", "scripts", "version.mjs")
);
const { BROKER_VERSION } = await import(
    path.join(root, "plugins", "hongtan-agent", "scripts", "broker-server.mjs")
);
const contracts = JSON.parse(
    fs.readFileSync(path.join(root, "plugins", "hongtan-agent", "contracts", "xhs-agent-tools-v1.json"), "utf8"),
);

const binary = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "standalone runtime path is required");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBrokerHealth(port, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            const body = await response.json();
            if (response.ok && body?.ok) return body;
        } catch (error) {
            lastError = error;
        }
        await delay(100);
    }
    throw new Error(`standalone Broker health check timed out: ${lastError?.message || "no response"}`);
}

const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "hongtan-agent-smoke-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const child = spawn(binary, [], {
    env: {
        ...process.env,
        HONGTAN_AGENT_HOST: "workbuddy",
        HONGTAN_AGENT_PORT: String(port),
        HONGTAN_AGENT_STATE_DIR: stateDirectory,
    },
    stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

/** 逐行解析 stdio JSON-RPC，取到指定 id 的响应为止 */
async function waitForResponse(id, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                if (message?.id === id) return message;
            } catch { /* 非 JSON 行忽略 */ }
        }
        await delay(50);
    }
    throw new Error(`standalone runtime 未在时限内响应 id=${id}，stderr: ${stderr}`);
}

async function stopChild() {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, delay(2_000)]);
}

try {
    child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
    })}\n`);

    const init = await waitForResponse(1);
    assert.ok(init.result, `initialize 失败: ${stderr}`);
    assert.equal(init.result.serverInfo?.name, "hongtan-agent");
    assert.equal(init.result.serverInfo?.version, AGENT_VERSION);

    // ed25519 设备身份：initialize 后 adapter/Broker 侧会加载或创建设备身份文件
    // （编译产物下 crypto.ed25519 的可用性就是这道断言要抓的回归）
    const identityPath = path.join(stateDirectory, "device-identity.json");
    const identityDeadline = Date.now() + 15_000;
    while (Date.now() < identityDeadline && !fs.existsSync(identityPath)) {
        await delay(100);
    }
    assert.ok(fs.existsSync(identityPath), "initialize 后应生成 device-identity.json");

    // Broker 自启（detached）后 loopback HTTP 可达
    const health = await waitForBrokerHealth(port);
    assert.equal(health.version, BROKER_VERSION);

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const tools = await waitForResponse(2);
    const toolNames = (tools.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(toolNames, contracts.tools.map((t) => t.name).sort());

    console.log("Standalone runtime MCP / Broker / device-identity smoke test passed.");
} finally {
    await stopChild();
    // Broker 可能残留并持有 state dir 句柄；清理尽力而为
    await rm(stateDirectory, { recursive: true, force: true }).catch(() => {});
}
