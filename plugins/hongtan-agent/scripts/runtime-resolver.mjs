/**
 * 运行时解析与自动下载（设计文档 §13「launcher」行 / 执行计划 S13）。
 *
 * 目标：用户无需自装 Node —— launcher 按平台下载 standalone 运行时二进制，
 * **校验 SHA-256 后才落地并执行**；校验不通过一律拒绝（绝不执行未校验字节）。
 *
 * 形态契约（`<状态目录>/runtime.manifest.json`，由发布方在 Release 生成）：
 * ```json
 * {
 *   "version": "0.1.0",
 *   "platforms": {
 *     "win32-x64": { "url": "https://…/hongtan-agent.exe", "sha256": "<hex>", "executable": "hongtan-agent.exe" }
 *   }
 * }
 * ```
 * - 状态目录无清单时按 `manifestSeedUrl`（版本钉死的发布地址）自动获取并缓存；
 * - 二进制按「**单文件可执行**」约定（不含压缩包，故无需解包逻辑）；
 * - 未提供当前平台条目 → 回退调用方已有的系统 Node 路径（不阻断 PoC 期的 `node` 用法）。
 *
 * 依赖注入（fetch/fs/hash/platform），可单测；下载走 `<exe>.part` + 原子 rename，
 * 中途失败不会留下「半个可执行文件」被下次误用。
 */

import crypto from "node:crypto";
import fsImplDefault from "node:fs";
import path from "node:path";

export const RUNTIME_MANIFEST_NAME = "runtime.manifest.json";
/** 受管运行时的落地目录（状态目录下） */
export const RUNTIME_DIR_NAME = "runtime";

/** 平台键（与 manifest.platforms 的键一致）：`<platform>-<arch>` */
export function platformKey(platform = process.platform, arch = process.arch) {
    return `${platform}-${arch}`;
}

export function sha256Hex(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * 读取运行时清单（缺失/损坏一律视为「无清单」→ 回退系统 Node，不抛错）。
 */
export function readRuntimeManifest({ stateDir, fsImpl = fsImplDefault }) {
    const manifestPath = path.join(stateDir, RUNTIME_MANIFEST_NAME);
    try {
        const raw = fsImpl.readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || typeof parsed.platforms !== "object") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function createRuntimeResolver({
    stateDir,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    fsImpl = fsImplDefault,
    logger = console,
    version = null,
    manifestSeedUrl = null,
} = {}) {
    const key = platformKey(platform, arch);

    function manifestEntry(manifest) {
        const entry = manifest?.platforms?.[key];
        if (!entry || !isNonEmptyString(entry.url) || !isNonEmptyString(entry.executable)) return null;
        return {
            url: entry.url,
            sha256: isNonEmptyString(entry.sha256) ? entry.sha256.toLowerCase() : null,
            executable: path.basename(entry.executable),
            version: isNonEmptyString(manifest.version) ? manifest.version : null,
        };
    }

    /**
     * 清单 seeding：状态目录无清单时从发布地址拉取（版本钉死，防漂移）。
     * 写入走 .part + 原子 rename；失败抛错由调用方决定降级（非致命）。
     */
    async function seedManifest() {
        const manifestPath = path.join(stateDir, RUNTIME_MANIFEST_NAME);
        const response = await fetchImpl(manifestSeedUrl);
        if (!response?.ok) {
            throw new Error(`HTTP ${response?.status ?? "?"}`);
        }
        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("清单不是合法 JSON");
        }
        if (!parsed || typeof parsed !== "object" || typeof parsed.platforms !== "object") {
            throw new Error("清单缺少 platforms 字段");
        }
        fsImpl.mkdirSync(stateDir, { recursive: true });
        const part = `${manifestPath}.part`;
        fsImpl.writeFileSync(part, text);
        fsImpl.renameSync(part, manifestPath);
    }

    function managedPath(entry) {
        return path.join(stateDir, RUNTIME_DIR_NAME, entry.executable);
    }

    /** 校验文件哈希；无期望哈希时返回"未知"（调用方决定是否接受） */
    function verifyFile(filePath, expectedSha256) {
        if (!expectedSha256) return { ok: false, unknown: true };
        try {
            const bytes = fsImpl.readFileSync(filePath);
            return { ok: sha256Hex(bytes) === expectedSha256, unknown: false };
        } catch {
            return { ok: false, unknown: false };
        }
    }

    async function download(entry) {
        const dir = path.join(stateDir, RUNTIME_DIR_NAME);
        const target = path.join(dir, entry.executable);
        const part = `${target}.part`;
        fsImpl.mkdirSync(dir, { recursive: true });

        const response = await fetchImpl(entry.url);
        if (!response?.ok) {
            throw new Error(`下载运行时失败（HTTP ${response?.status ?? "?"}）`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());

        const actual = sha256Hex(bytes);
        if (!entry.sha256 || actual !== entry.sha256) {
            // 校验失败：临时文件都不留（避免下次被当成"已下载"而跳过校验）
            try {
                fsImpl.rmSync(part, { force: true });
            } catch {
                /* 清理失败无害 */
            }
            throw new Error(
                entry.sha256
                    ? `运行时 SHA-256 校验失败（期望 ${entry.sha256}，实际 ${actual}），已拒绝安装`
                    : "运行时清单缺少 sha256，拒绝安装未校验的二进制"
            );
        }

        fsImpl.writeFileSync(part, bytes);
        fsImpl.renameSync(part, target);
        try {
            fsImpl.chmodSync(target, 0o755);
        } catch {
            /* Windows 上无意义 */
        }
        logger.info?.(`[agent] 已安装运行时 v${entry.version ?? "?"}（SHA-256 校验通过）`);
        return target;
    }

    return {
        platformKey: key,
        /**
         * 解析可用运行时：
         * 1. 受管二进制已存在且哈希匹配 → 直接复用；
         * 2. 已存在但哈希不匹配（被篡改/损坏）→ 删除后重新下载；
         * 3. 缺失 → 按清单下载 + 校验 + 原子落地。
         *
         * @returns {{ok: true, source: "managed"|"system-node", executable: string|null, version: string|null}
         *          | {ok: false, reason: string}}
         */
        async ensure() {
            let manifest = readRuntimeManifest({ stateDir, fsImpl });
            if (!manifest && manifestSeedUrl) {
                try {
                    await seedManifest();
                    manifest = readRuntimeManifest({ stateDir, fsImpl });
                    logger.info?.(`[agent] 已从发布地址获取运行时清单${version ? `（v${version}）` : ""}`);
                } catch (e) {
                    // seeding 失败不阻断：回退系统 Node（与无清单时同语义）
                    logger.warn?.(`[agent] 运行时清单自动获取失败：${e?.message ?? String(e)}`);
                }
            }
            const entry = manifestEntry(manifest);
            if (!entry) {
                return {
                    ok: true,
                    source: "system-node",
                    executable: null,
                    version: null,
                    reason: manifest ? `清单无当前平台条目（${key}）` : "无运行时清单",
                };
            }

            const target = managedPath(entry);
            const existing = verifyFile(target, entry.sha256);
            if (existing.ok) {
                return { ok: true, source: "managed", executable: target, version: entry.version };
            }
            if (!existing.unknown && fsImpl.existsSync(target)) {
                logger.warn?.("[agent] 受管运行时校验不通过，重新下载");
                try {
                    fsImpl.rmSync(target, { force: true });
                } catch {
                    /* 删不掉会在下载落地时被覆盖 */
                }
            }

            try {
                const installed = await download(entry);
                return { ok: true, source: "managed", executable: installed, version: entry.version };
            } catch (e) {
                // 下载/校验失败：如实返回，由调用方决定回退系统 Node 还是直接报错退出
                return { ok: false, reason: e?.message ?? String(e) };
            }
        },
    };
}
