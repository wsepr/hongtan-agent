/**
 * launcher 入口（执行计划 S13）：优先使用受管运行时，否则回退系统 Node。
 *
 * 与 runtime-entry.mjs 的分工：
 * - 本文件负责**选运行时**（解析/下载/校验 SHA-256），不关心角色；
 * - runtime-entry.mjs 负责**按角色**加载 adapter 或 broker。
 *
 * 回退链（任一环节失败都不静默降级为"能跑就行"）：
 * 1. `HONGTAN_AGENT_RUNTIME`（运维显式指定，绕过清单）；
 * 2. `<状态目录>/runtime.manifest.json` 描述的受管二进制（下载后 SHA-256 校验通过才落地）；
 *    状态目录无清单时先按版本钉死的发布地址自动获取（seeding，失败不阻断）；
 * 3. 系统 Node（PoC 期路径；无清单时即走此路）。
 *
 * 校验失败时回退的是「执行方式」，而非「跳过校验」：受管二进制校验失败时，本进程仍以系统 Node
 * 加载同一份源码，因此不存在「绕过校验拿到执行权」的路径。
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { resolveStateDirectory } from "./device-identity.mjs";
import { createRuntimeResolver } from "./runtime-resolver.mjs";
import { AGENT_VERSION } from "./version.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadRuntimeEntry() {
    // Windows 绝对路径不是合法 ESM import 说明符，必须转 file:// URL
    await import(pathToFileURL(path.join(__dirname, "runtime-entry.mjs")));
}

async function main() {
    const override = process.env.HONGTAN_AGENT_RUNTIME;
    if (override) {
        const exitCode = spawnSync(override, process.argv.slice(2), { stdio: "inherit" }).status;
        process.exit(exitCode ?? 1);
    }

    // 清单 seeding：状态目录无清单时从版本钉死的发布地址拉取（HONGTAN_AGENT_MANIFEST_SEED_URL
    // 可覆盖——测试隔离与私有部署用；URL 随 AGENT_VERSION 变化，保证拿到对应版本的清单）
    const manifestSeedUrl = process.env.HONGTAN_AGENT_MANIFEST_SEED_URL
        ?? `https://github.com/wsepr/hongtan-agent/releases/download/v${AGENT_VERSION}/runtime.manifest.json`;

    const resolver = createRuntimeResolver({
        stateDir: resolveStateDirectory(),
        version: AGENT_VERSION,
        manifestSeedUrl,
    });
    const resolved = await resolver.ensure();
    if (resolved.ok && resolved.source === "managed" && resolved.executable) {
        const child = spawnSync(resolved.executable, process.argv.slice(2), { stdio: "inherit" });
        if (child.error) {
            console.error(`[agent] 受管运行时启动失败（${child.error.message}），回退系统 Node`);
        } else {
            process.exit(child.status ?? 0);
        }
    } else if (!resolved.ok) {
        // 有清单但下载/校验失败：如实告警后仍以系统 Node 跑同一份源码
        console.error(`[agent] 运行时自动安装失败：${resolved.reason}`);
    }

    await loadRuntimeEntry();
}

main().catch((e) => {
    console.error("[agent] launcher 启动失败:", e?.message ?? e);
    process.exit(1);
});
