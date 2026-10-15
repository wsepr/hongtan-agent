/**
 * 统一入口（执行计划 §2.1）：按 HOST 角色拉起 adapter 或 broker。
 *
 * 用法：
 *   node scripts/runtime-entry.mjs          # 默认 adapter（stdio MCP）
 *   HONGTAN_AGENT_ROLE=broker node scripts/runtime-entry.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const role = process.env.HONGTAN_AGENT_ROLE ?? "adapter";

if (role === "broker") {
    await import(path.join(__dirname, "broker-server.mjs"));
} else {
    await import(path.join(__dirname, "mcp-server.mjs"));
}
