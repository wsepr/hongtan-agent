/**
 * [hongtan-agent] 运行时指纹（问题清单 4.2/4.3）：让「正在运行的是哪份代码」可自证。
 *
 * - contractsHash：对**各自 import 进来的契约对象**做 JSON.stringify 后取 sha256 前 12 位。
 *   broker 与 adapter import 的是同一磁盘 JSON，序列化键序一致 ⇒ 哈希可比；
 *   不等即证明有一方是旧进程（改契约不重启不生效，用哈希一眼可辨）。
 * - buildId：发布链路经 HONGTAN_BUILD_ID 注入；dev 未注入时回退 scripts 目录最新 .mjs
 *   的 mtime（standalone 产物里退化为 exe 自身 mtime——语义在契约中注明，避免假阳性）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function sha256Hex(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function contractsFingerprint(contracts) {
    return sha256Hex(JSON.stringify(contracts ?? null)).slice(0, 12);
}

export function resolveBuildId({ env = process.env, moduleUrl = import.meta.url } = {}) {
    if (env.HONGTAN_BUILD_ID) return env.HONGTAN_BUILD_ID;
    try {
        const dir = path.dirname(fileURLToPath(moduleUrl));
        let latest = 0;
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith(".mjs")) continue;
            const m = fs.statSync(path.join(dir, name)).mtimeMs;
            if (m > latest) latest = m;
        }
        return latest > 0 ? `dev-${Math.floor(latest).toString(36)}` : "dev-unknown";
    } catch {
        return "dev-unknown";
    }
}
