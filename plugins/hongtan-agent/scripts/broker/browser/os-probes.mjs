/**
 * 浏览器解析的真实 OS 探针（设计文档 §10.7 层 2 / 层 3）——把纯函数模块的注入点接到系统机制上。
 *
 * 为什么必须单独成文件：`resolve-exe.mjs` / `resolve-profile.mjs` 只接受**注入**的探测函数
 * （为了可单测），如果生产装配不供给实现，那么
 *   - 层 2.1 App Paths 注册表、层 2.2 默认浏览器反查 → `queryAppPath?.()` / `queryDefaultBrowserCommand?.()` 恒 undefined，
 *   - 层 3 的「枚举 User Data 下目录」兜底 → `listDirectories?.() ?? []` 恒空数组，
 * 三者**在真实路径上全部不可达**：只剩层 2.3「标准安装路径兜底」。于是浏览器装在非标准位置
 * （如 `D:\Apps\Chrome`）或 profile 名不在 `Default` / `Profile 1..5` 时，`ensureResolved()` 失败
 * → `ensureRunning()` 只能记 `browser_launch_error`，而**无人值守的物理底线（P8：Broker 负责拉起浏览器）失效**。
 * 单测全绿却掩盖断链，因为测试自己注入了探针。
 *
 * 实现只用系统自带命令，不引入依赖，也不做「硬编码扫描」以外的猜测：
 * - `queryAppPath`：`reg query <HKLM|HKCU>\...\App Paths\<exe> /ve`（HKLM → HKCU，与设计一致）；
 * - `queryDefaultBrowserCommand`：`reg query HKCR\<ProgId>\shell\open\command /ve`；
 * - `listDirectories`：`fs.readdirSync` 只回目录名（供 resolve-profile 的兜底扫描）。
 *
 * 探测失败一律返回 null / 空数组（不抛错）：解析不出来时由调用方按错误码如实上报，
 * 不能让一次注册表读取异常崩掉整个 Broker。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BROWSER_FAMILIES } from "./family-table.mjs";

/** App Paths 查询顺序：机器级（HKLM）→ 用户级（HKCU，per-user 安装落在这里）。
 *  仅这两处，不额外猜 WOW6432Node 等镜像视图——设计文档 §10.7 层 2.1 只声明了 HKLM/HKCU。 */
const APP_PATHS_ROOTS = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];

/**
 * 从 `reg query <key> /ve` 的输出里取默认值（**原样返回**，不做去引号）。
 * 真实输出形如：
 *   HKEY_LOCAL_MACHINE\...\App Paths\chrome.exe
 *       (Default)    REG_SZ    C:\Program Files\Google\Chrome\Application\chrome.exe
 * 命令值（`shell\open\command`）本身就含引号与参数，必须原样交给 `extractExeFromCommand`，
 * 故去引号只在需要纯路径的调用点（`queryAppPath`）做。
 * @returns {string | null}
 */
export function parseRegDefaultValue(stdout) {
    if (typeof stdout !== "string") return null;
    for (const line of stdout.split(/\r?\n/)) {
        const match = /\bREG_(?:EXPAND_)?SZ\b[ \t]+(.+?)[ \t]*$/.exec(line);
        if (!match) continue;
        const value = match[1].trim();
        if (value) return value;
    }
    return null;
}

/** 剥掉「整值被一对引号包裹」的外层引号（App Paths 里注册的路径可能带引号） */
function stripSurroundingQuotes(value) {
    const match = /^"(.*)"$/.exec(value);
    return match ? match[1].trim() : value;
}

/**
 * @param {object} [deps]
 * @param {string} [deps.platform]
 * @param {typeof fs} [deps.fsImpl]
 * @param {typeof spawnSync} [deps.execImpl]
 */
export function createOsProbes({ platform = process.platform, fsImpl = fs, execImpl = spawnSync } = {}) {
    function regQuery(key) {
        if (platform !== "win32") return null;
        try {
            const result = execImpl("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
            if (result?.error || result?.status !== 0) return null;
            return parseRegDefaultValue(result.stdout);
        } catch {
            // reg.exe 缺失/被安全软件拦截等：按「解析不出来」处理，由调用方按错误码上报
            return null;
        }
    }

    return {
        /** 层 2.1：App Paths 注册表（HKLM → HKCU）；此处只要纯路径，故剥外层引号 */
        queryAppPath(exeName) {
            if (!exeName) return null;
            for (const root of APP_PATHS_ROOTS) {
                const value = regQuery(`${root}\\${exeName}`);
                if (value) return stripSurroundingQuotes(value);
            }
            return null;
        },

        /** 层 2.2：默认浏览器 ProgId → `shell\open\command`（HKCR 是 HKLM+HKCU 的合并视图），原样返回命令行 */
        queryDefaultBrowserCommand(progId) {
            if (!progId) return null;
            return regQuery(`HKCR\\${progId}\\shell\\open\\command`);
        },

        /** 拉起前置判定（《常驻工作区设计方案》§5.2）：目标家族浏览器进程是否在运行。
         *  win32 首发（tasklist）；darwin/linux 未实现一律 null——调用方按「探测不可用 → 照旧 spawn」回退。
         *  注意假阳性面：Edge 后台/更新/crashpad 子进程也会命中映像名——本探测只作「暂缓拉起」信号，
         *  由 browserManager 的 30s 升级定时器兜底（到期仍未回连才强制拉起）。 */
        isBrowserProcessRunning(family) {
            if (platform !== "win32") return null;
            const exeName = BROWSER_FAMILIES[family]?.exeNames?.[0];
            if (!exeName) return null;
            try {
                const result = execImpl("tasklist", ["/FI", `IMAGENAME eq ${exeName}`, "/NH"], {
                    encoding: "utf8",
                    windowsHide: true,
                });
                if (result?.error || result?.status !== 0) return null;
                // 未运行时 tasklist 输出「信息: 没有运行的任务...」；按映像名出现与否判定（不依赖语言）
                return String(result.stdout ?? "").includes(exeName);
            } catch {
                return null;
            }
        },

        /** 层 3 兜底：枚举目录（只要目录名，与 resolve-profile 的口径一致）；排序保证判定可复现 */
        listDirectories(root) {
            try {
                return fsImpl
                    .readdirSync(root, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name)
                    .sort();
            } catch {
                return [];
            }
        },

        /** 层 3 回退（v2.10）：读 Local State 的 profile.last_used——开发者模式「加载已解压的扩展程序」
         *  不会在 Extensions/<extId> 下生成目录，精确反查必然失败；Local State 三平台均在 User Data 根下且对
         *  unpacked 天然免疫。任何失败返回 null（文件缺失/损坏/字段缺失）。 */
        readLocalStateLastUsed(userDataRoot) {
            if (!userDataRoot) return null;
            try {
                const raw = fsImpl.readFileSync(path.join(userDataRoot, "Local State"), "utf8");
                const used = JSON.parse(raw)?.profile?.last_used;
                return typeof used === "string" && used ? used : null;
            } catch {
                return null;
            }
        },
    };
}
