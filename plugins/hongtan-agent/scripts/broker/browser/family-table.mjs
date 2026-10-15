/**
 * 浏览器家族表（设计文档 §10.7 层 1/层 2）。
 *
 * 「扩展在哪个浏览器里就拉哪个」——家族由扩展经 extension.hello 上报（层 1），
 * 本表只回答「该家族的 exe/bundle/命令与 User Data 根在哪里」（层 2/层 3）。
 * 国产 Chromium 套壳做成可扩展表项，而非 if-else。
 */

/**
 * @type {Record<string, {
 *   label: string,
 *   appPathsExe: string | null,
 *   defaultBrowserProgIds: string[],
 *   exeNames: string[],
 *   bundleId: string | null,
 *   linuxCommands: string[],
 *   userDataRoots: { win32: string[], darwin: string[], linux: string[] }
 * }>}
 */
export const BROWSER_FAMILIES = {
    chrome: {
        label: "Google Chrome",
        appPathsExe: "chrome.exe",
        defaultBrowserProgIds: ["ChromeHTML"],
        exeNames: ["chrome.exe"],
        bundleId: "com.google.Chrome",
        linuxCommands: ["google-chrome-stable", "google-chrome"],
        userDataRoots: {
            win32: [
                ["${LOCALAPPDATA}", "Google", "Chrome", "User Data"],
                ["${PROGRAMFILES}", "Google", "Chrome", "User Data"],
                ["${ProgramFiles(x86)}", "Google", "Chrome", "User Data"],
            ],
            darwin: [["${HOME}", "Library", "Application Support", "Google", "Chrome"]],
            linux: [["${HOME}", ".config", "google-chrome"]],
        },
    },
    edge: {
        label: "Microsoft Edge",
        appPathsExe: "msedge.exe",
        defaultBrowserProgIds: ["MSEdgeHTM"],
        exeNames: ["msedge.exe"],
        bundleId: "com.microsoft.edgemac",
        linuxCommands: ["microsoft-edge-stable", "microsoft-edge"],
        userDataRoots: {
            win32: [
                ["${LOCALAPPDATA}", "Microsoft", "Edge", "User Data"],
                ["${PROGRAMFILES}", "Microsoft", "Edge", "User Data"],
                ["${ProgramFiles(x86)}", "Microsoft", "Edge", "User Data"],
            ],
            darwin: [["${HOME}", "Library", "Application Support", "Microsoft Edge"]],
            linux: [["${HOME}", ".config", "microsoft-edge"]],
        },
    },
    chromium: {
        label: "Chromium",
        appPathsExe: "chromium.exe",
        defaultBrowserProgIds: [],
        exeNames: ["chromium.exe"],
        bundleId: null,
        linuxCommands: ["chromium-browser", "chromium"],
        userDataRoots: {
            win32: [["${LOCALAPPDATA}", "Chromium", "User Data"]],
            darwin: [["${HOME}", "Library", "Application Support", "Chromium"]],
            linux: [["${HOME}", ".config", "chromium"]],
        },
    },
};

export function isKnownFamily(family) {
    return Object.hasOwn(BROWSER_FAMILIES, family);
}

/** 展开路径段：`${VAR}` 形式查环境变量，其余为字面段 */
function expandPart(part, env, platform) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_()]*)\}$/.exec(part);
    if (match) {
        const name = match[1];
        if (name === "HOME") return env.HOME ?? env.USERPROFILE ?? "";
        return env[name] ?? "";
    }
    void platform;
    return part;
}

/** 解析 User Data 根候选路径（按平台 + 环境变量展开；不检查存在性，由调用方探测） */
export function userDataRootCandidates(family, platform, env = process.env) {
    const entry = BROWSER_FAMILIES[family];
    if (!entry) return [];
    const separator = platform === "win32" ? "\\" : "/";
    const roots = entry.userDataRoots[platform] ?? [];
    return roots
        .map((parts) => parts.map((part) => expandPart(part, env, platform)).join(separator))
        .filter((p) => p && !p.includes("${"));
}
