/**
 * 发布期工具：由 Release 产物的 checksums.txt 生成 `runtime.manifest.json`。
 *
 * 消费端契约见 plugins/hongtan-agent/scripts/runtime-resolver.mjs——每个平台条目
 * 必须含 `url` + `executable` + `sha256`，平台键为 Node 约定 `<platform>-<arch>`。
 * 哈希必须来自真实构建产物（checksums.txt），缺任一平台即抛错，杜绝手抄。
 *
 * 本脚本属发布链路，不随接入包分发给用户。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_BASE = "https://github.com/wsepr/hongtan-agent/releases/download";

const TARGETS = {
    "win32-x64": "hongtan-agent-win32-x64.exe",
    "darwin-arm64": "hongtan-agent-darwin-arm64",
    "linux-x64": "hongtan-agent-linux-x64",
};

export function createRuntimeManifest({ version, checksums, releaseBase = RELEASE_BASE }) {
    const checksumByAsset = new Map(
        String(checksums || "")
            .split(/\r?\n/)
            .map((line) => /^(\S+)\s+\*?(.+)$/.exec(line.trim()))
            .filter(Boolean)
            .map((match) => [match[2], match[1].toLowerCase()]),
    );
    const platforms = {};
    for (const [platform, asset] of Object.entries(TARGETS)) {
        const sha256 = checksumByAsset.get(asset);
        if (!sha256) throw new Error(`missing checksum for ${asset}`);
        platforms[platform] = {
            url: `${releaseBase}/v${version}/${asset}`,
            sha256,
            executable: path.basename(asset),
        };
    }
    return { version, platforms };
}

async function main() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const outputPath = path.resolve(process.argv[2] || path.join(root, "dist", "runtime.manifest.json"));
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const checksums = await fs.readFile(path.join(path.dirname(outputPath), "checksums.txt"), "utf8");
    const manifest = createRuntimeManifest({ version: packageJson.version, checksums });
    await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
