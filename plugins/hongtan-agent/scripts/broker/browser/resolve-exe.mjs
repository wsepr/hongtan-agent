/**
 * 浏览器 exe 路径解析（设计文档 §10.7 层 2）——按 OS 用系统机制解析，不硬编码扫描。
 *
 * Windows：App Paths 注册表（HKLM/HKCU）→ 默认浏览器反查 → 标准安装路径兜底；
 * macOS：不需要路径（open -b <bundleId>）；
 * Linux：PATH 命令序列。
 *
 * 全部探测函数注入（registryQuery / fileExists / which / env），可单测。
 */

import { BROWSER_FAMILIES } from "./family-table.mjs";

export const BROWSER_UNRESOLVABLE = "BROWSER_UNRESOLVABLE";

function expandWinRoot(env, parts) {
    // 与 family-table 的 `${VAR}` 模板口径一致：${VAR} 查环境变量，其余为字面段
    return parts
        .map((part) => {
            const match = /^\$\{([A-Za-z_][A-Za-z0-9_()]*)\}$/.exec(part);
            if (!match) return part;
            const name = match[1];
            if (name === "HOME") return env.HOME ?? env.USERPROFILE ?? "";
            return env[name] ?? "";
        })
        .join("\\");
}

/**
 * @param {object} deps
 * @param {(exeName: string) => string | null} deps.queryAppPath  App Paths 注册表默认值查询（HKLM→HKCU 由实现内部处理）
 * @param {(progId: string) => string | null} deps.queryDefaultBrowserCommand  默认浏览器 ProgId → command
 * @param {(path: string) => boolean} deps.fileExists
 * @param {Record<string, string>} [deps.env]
 * @param {string} [deps.platform]
 */
export function resolveExe({ family, queryAppPath, queryDefaultBrowserCommand, fileExists, env = process.env, platform = process.platform, logger = console }) {
    const entry = BROWSER_FAMILIES[family];
    if (!entry) {
        return { ok: false, code: BROWSER_UNRESOLVABLE, message: `未知浏览器家族: ${family}` };
    }

    if (platform === "darwin") {
        // macOS 不解析路径：open -b <bundleId>
        if (!entry.bundleId) {
            return { ok: false, code: BROWSER_UNRESOLVABLE, message: `家族 ${family} 在 macOS 无 bundleId` };
        }
        return { ok: true, kind: "open-b", bundleId: entry.bundleId };
    }

    if (platform === "linux") {
        for (const cmd of entry.linuxCommands) {
            if (fileExists(`/usr/bin/${cmd}`) || fileExists(`/usr/local/bin/${cmd}`)) {
                return { ok: true, kind: "exe", exe: cmd };
            }
        }
        return { ok: false, code: BROWSER_UNRESOLVABLE, message: `PATH 中未找到 ${entry.linuxCommands.join("/")}` };
    }

    // Windows：层 2.1 App Paths 注册表（Chrome/Edge 均注册；per-user 安装在 HKCU）
    if (entry.appPathsExe) {
        const fromRegistry = queryAppPath?.(entry.appPathsExe);
        if (fromRegistry && fileExists(fromRegistry)) {
            return { ok: true, kind: "exe", exe: fromRegistry, source: "app-paths" };
        }
    }

    // 层 2.2 默认浏览器反查（UserChoice → ProgId → command）
    for (const progId of entry.defaultBrowserProgIds) {
        const command = queryDefaultBrowserCommand?.(progId);
        if (command) {
            const exe = extractExeFromCommand(command);
            if (exe && fileExists(exe)) {
                return { ok: true, kind: "exe", exe, source: "default-browser" };
            }
        }
    }

    // 层 2.3 标准三路径兜底
    if (platform === "win32") {
        for (const root of BROWSER_FAMILIES[family].userDataRoots.win32) {
            // userDataRoots 里的 win32 项以 User Data 结尾，exe 在其上两级
            const userDataTable = expandWinRoot(env, root);
            const base = userDataTable.replace(/[\\/]User Data[\\/]?$/i, "");
            for (const exeName of entry.exeNames) {
                const candidate = `${base}\\Application\\${exeName}`;
                if (fileExists(candidate)) {
                    return { ok: true, kind: "exe", exe: candidate, source: "standard-path" };
                }
            }
        }
    }

    return { ok: false, code: BROWSER_UNRESOLVABLE, message: `未能解析 ${entry.label} 的可执行文件路径` };
}

/** 从注册表 command（如 "C:\...\chrome.exe" -- "%1"）提取 exe 路径 */
export function extractExeFromCommand(command) {
    const match = /^"([^"]+)"|^(\S+)/.exec(String(command ?? "").trim());
    if (!match) return null;
    return (match[1] ?? match[2] ?? "").trim() || null;
}
