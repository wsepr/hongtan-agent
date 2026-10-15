import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeManifest } from "./create-runtime-manifest.mjs";

const CHECKSUMS = [
    "aaa111 *hongtan-agent-win32-x64.exe",
    "bbb222  hongtan-agent-darwin-arm64",
    "ccc333 hongtan-agent-linux-x64",
].join("\n");

test("输出红探 schema：三平台键 + url/executable/sha256", () => {
    const manifest = createRuntimeManifest({ version: "0.1.0", checksums: CHECKSUMS });

    assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-arm64", "linux-x64", "win32-x64"]);
    const win = manifest.platforms["win32-x64"];
    assert.equal(
        win.url,
        "https://github.com/wsepr/hongtan-agent/releases/download/v0.1.0/hongtan-agent-win32-x64.exe",
    );
    assert.equal(win.executable, "hongtan-agent-win32-x64.exe");
    assert.equal(win.sha256, "aaa111");
    assert.equal(manifest.platforms["linux-x64"].executable, "hongtan-agent-linux-x64");
});

test("sha256 统一小写；version 进入 url 与顶层字段", () => {
    const manifest = createRuntimeManifest({
        version: "0.2.0",
        checksums: "AAAA1111  hongtan-agent-win32-x64.exe\nbbbb2222 hongtan-agent-darwin-arm64\ncccc3333 hongtan-agent-linux-x64",
    });

    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.platforms["win32-x64"].sha256, "aaaa1111");
    assert.ok(manifest.platforms["darwin-arm64"].url.includes("/v0.2.0/"));
});

test("缺任一平台哈希即抛错（哈希必须来自真实产物，不许手抄缺省）", () => {
    assert.throws(
        () => createRuntimeManifest({ version: "0.1.0", checksums: "aaa111 hongtan-agent-win32-x64.exe" }),
        /missing checksum for hongtan-agent-darwin-arm64/,
    );
    assert.throws(() => createRuntimeManifest({ version: "0.1.0", checksums: "" }), /missing checksum/);
});
