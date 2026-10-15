/**
 * 发布前版本一致性校验：AGENT_VERSION（编译产物内的唯一版本来源）
 * === package.json 版本 === plugin.json 版本 ===（CI 时）tag。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { AGENT_VERSION } = await import(
    pathToFileURL(path.join(root, "plugins", "hongtan-agent", "scripts", "version.mjs"))
);

const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const pluginVersion = JSON.parse(
    fs.readFileSync(path.join(root, "plugins", "hongtan-agent", ".codebuddy-plugin", "plugin.json"), "utf8"),
).version;

const mismatches = [];
if (AGENT_VERSION !== packageVersion) mismatches.push(`version.mjs (${AGENT_VERSION}) ≠ package.json (${packageVersion})`);
if (AGENT_VERSION !== pluginVersion) mismatches.push(`version.mjs (${AGENT_VERSION}) ≠ plugin.json (${pluginVersion})`);

// 仅 CI（tag 触发）时校验 tag；允许预发布后缀（v0.1.0-test.1 ↔ 0.1.0），与 release.yml 的
// prerelease 判定同口径。本地执行无 GITHUB_REF_NAME 则跳过
const refName = process.env.GITHUB_REF_NAME;
if (refName && !new RegExp(`^v${AGENT_VERSION}(-|$)`).test(refName)) {
    mismatches.push(`version.mjs (${AGENT_VERSION}) 与 tag (${refName}) 不匹配`);
}

if (mismatches.length > 0) {
    console.error("[hongtan-agent] 版本不一致：\n  " + mismatches.join("\n  "));
    process.exit(1);
}
console.log(`[hongtan-agent] 版本一致：${AGENT_VERSION}`);
