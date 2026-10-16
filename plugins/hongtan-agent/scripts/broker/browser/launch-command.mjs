/**
 * 拉起命令构造（设计文档 §10.7 层 2/安全边界）——纯函数。
 *
 * 安全约束：
 * - URL 白名单：仅 xiaohongshu.com 域内 URL 或空白页（防被滥用为钓鱼跳转）；
 * - 只接受引导期记录的 exe/bundle 与 profile，不接受任意路径/参数；
 * - 幂等语义：浏览器已运行时该命令等效开窗，无害。
 */

export const LAUNCH_DEBOUNCE_MS = 30_000;

function isXiaohongshuUrl(url) {
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === "https:" &&
            (parsed.hostname === "xiaohongshu.com" || parsed.hostname.endsWith(".xiaohongshu.com"))
        );
    } catch {
        return false;
    }
}

/**
 * 校验拉起 URL。仅允许 https 小红书域内 URL 或 null（空白页）。
 * @returns {{ok: true, url: string | null} | {ok: false, message: string}}
 */
export function validateLaunchUrl(url) {
    if (url === null || url === undefined || url === "") return { ok: true, url: null };
    if (typeof url === "string" && isXiaohongshuUrl(url)) return { ok: true, url };
    return { ok: false, message: `拉起 URL 不在白名单内（仅允许 xiaohongshu.com 域内 https URL 或空白页）: ${url}` };
}

/**
 * 构造拉起命令。
 * @returns {{ok: true, command: {file: string, args: string[]}} | {ok: false, message: string}}
 */
export function buildLaunchCommand({ resolvedExe, profileDir, url }) {
    const urlCheck = validateLaunchUrl(url);
    if (!urlCheck.ok) return urlCheck;
    if (!resolvedExe?.ok) {
        return { ok: false, message: "浏览器 exe 未解析，无法构造拉起命令" };
    }

    if (resolvedExe.kind === "open-b") {
        // macOS：open -b <bundleId> --args --profile-directory=... [url]
        // --args 仅冷启动生效；运行中场景走幂等开窗（由浏览器自身处理），不受影响
        const args = ["-b", resolvedExe.bundleId];
        const innerArgs = [`--profile-directory=${profileDir ?? "Default"}`];
        if (urlCheck.url) innerArgs.push(urlCheck.url);
        args.push("--args", ...innerArgs);
        return { ok: true, command: { file: "open", args } };
    }

    // --start-maximized 仅冷启动生效（交接给已运行实例时被忽略）：提高冷启动窗口变大概率，
    // 不解决 Windows 前台锁——前台化的主要保障仍是扩展连上后的 activateWindow
    const args = [`--profile-directory=${profileDir ?? "Default"}`, "--start-maximized"];
    if (urlCheck.url) args.push(urlCheck.url);
    return { ok: true, command: { file: resolvedExe.exe, args } };
}
