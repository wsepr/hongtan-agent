/**
 * 统一入口（执行计划 §2.1）：按 HOST 角色拉起 adapter 或 broker。
 *
 * 用法：
 *   node scripts/runtime-entry.mjs          # 默认 adapter（stdio MCP）
 *   HONGTAN_AGENT_ROLE=broker node scripts/runtime-entry.mjs
 *
 * 动态 import 必须用字面量相对路径：standalone 发布产物（bun build --compile）里
 * import.meta.url 指向内嵌虚拟文件系统，拼绝对路径会断；字面量会被静态打包。
 */

if (process.env.HONGTAN_AGENT_ROLE === "broker") {
    await import("./broker-server.mjs");
} else {
    await import("./mcp-server.mjs");
}
