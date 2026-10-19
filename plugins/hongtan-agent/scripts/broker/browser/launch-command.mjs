/**
 * 拉起命令构造（设计文档 §10.7 层 2/安全边界）——纯函数。
 *
 * 安全约束：
 * - URL 白名单：仅 xiaohongshu.com 域内 URL 或空白页（防被滥用为钓鱼跳转）；
 * - 只接受引导期记录的 exe/bundle 与 profile，不接受任意路径/参数；
 * - 幂等语义：浏览器已运行时该命令等效开窗，无害。
 */

export const LAUNCH_DEBOUNCE_MS = 30_000;

/**
 * 消遮挡 / 消节流开关（《抓取窗口前台化与后台不停摆 实施方案》方案 C）。
 *
 * 背景（M3 实测）：抓取窗口一旦被判 `hidden`，懒加载与定时器会停摆（不是变慢而是暂停）。
 * 真机实测对照（同机、同遮挡动作）：
 * - 不带开关：`visibility=hidden` + 停摆；
 * - 带开关：遮挡期间 `visibility` 恒为 `visible`，页面心跳精确 1/s（无节流衰减），
 *   任务在全程遮挡下从 3 篇跑到 5 篇、评论 53→255 并正常终态。
 *
 * 关键前提：这些开关**只在该浏览器进程启动时生效**。浏览器已在运行时，命令会被交给已有实例
 * 而开关被忽略——那部分场景（用户日常自己开着浏览器）由 `xhs_activate_window` 的
 * OS 级前台化兜底（见 activate-window.mjs）。Broker 的 skip 判定已保证"真正 spawn 时
 * 浏览器没在跑"，故此处不再引入 `--user-data-dir`（指向默认根同样会被交接，给不了额外保证）。
 *
 * 连带后果（已在设计文档 §10.7 声明）：该会话所有标签页都不被后台降级，CPU/耗电略增。
 */
export const ANTI_THROTTLE_SWITCHES = [
    // 关掉 Windows 原生窗口遮挡跟踪：被别的窗口盖住时不再把页面判成 hidden
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
];

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
 * 构造拉起命令。v2.10：profileDir 为 null/空 = 裸拉起——不带 --profile-directory，
 * 浏览器按「最近使用的 profile」启动（unpacked 扩展场景 profile 反查失败的回退，§10.7 层 3）。
 * @returns {{ok: true, command: {file: string, args: string[]}} | {ok: false, message: string}}
 */
export function buildLaunchCommand({ resolvedExe, profileDir, url }) {
    const urlCheck = validateLaunchUrl(url);
    if (!urlCheck.ok) return urlCheck;
    if (!resolvedExe?.ok) {
        return { ok: false, message: "浏览器 exe 未解析，无法构造拉起命令" };
    }

    if (resolvedExe.kind === "open-b") {
        // macOS：open -b <bundleId> --args [...]（--args 仅冷启动生效；运行中场景走幂等开窗，由浏览器自身处理）
        const args = ["-b", resolvedExe.bundleId];
        const innerArgs = [...ANTI_THROTTLE_SWITCHES];
        if (profileDir) innerArgs.push(`--profile-directory=${profileDir}`);
        if (urlCheck.url) innerArgs.push(urlCheck.url);
        args.push("--args", ...innerArgs);
        return { ok: true, command: { file: "open", args } };
    }

    // --start-maximized 仅冷启动生效（交接给已运行实例时被忽略）：提高冷启动窗口变大概率。
    // 前台化的真正保障是 Broker 的 OS 级调用（Windows 前台锁会让 Chromium 自身的激活请求失效，
    // 只闪任务栏，见 activate-window.mjs），而不是这个参数。
    const args = [...ANTI_THROTTLE_SWITCHES];
    if (profileDir) args.push(`--profile-directory=${profileDir}`);
    args.push("--start-maximized");
    if (urlCheck.url) args.push(urlCheck.url);
    return { ok: true, command: { file: resolvedExe.exe, args } };
}
