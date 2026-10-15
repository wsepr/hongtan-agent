/**
 * profile 反查（设计文档 §10.7 层 3）——extId 反查「装了扩展且登录」的 profile。
 *
 * 在 User Data 根下扫 <profile>/Extensions/<extId>/（profile ∈ Default, Profile 1…）；
 * extId 经 chrome.runtime.id 上报，不硬编码。
 * 目录探测函数注入（listDirectories / pathExists），可单测。
 */

const CANDIDATE_PROFILES = ["Default", "Profile 1", "Profile 2", "Profile 3", "Profile 4", "Profile 5"];

/**
 * @returns {{ok: true, profileDir: string, source: string} | {ok: false, message: string}}
 */
export function resolveProfile({ userDataRoot, extId, joinPath, listDirectories, pathExists, logger = console }) {
    if (!userDataRoot || !extId) {
        return { ok: false, message: "userDataRoot 与 extId 均不能为空" };
    }
    if (!pathExists(userDataRoot)) {
        return { ok: false, message: `User Data 根不存在: ${userDataRoot}` };
    }

    // 1. 候选 profile 名优先（Default → Profile N）
    for (const profile of CANDIDATE_PROFILES) {
        const extDir = joinPath(userDataRoot, profile, "Extensions", extId);
        if (pathExists(extDir)) {
            return { ok: true, profileDir: profile, source: "candidate-scan" };
        }
    }

    // 2. 兜底：枚举 User Data 下的目录逐个探测
    const dirs = listDirectories?.(userDataRoot) ?? [];
    for (const dir of dirs) {
        if (CANDIDATE_PROFILES.includes(dir)) continue;
        const extDir = joinPath(userDataRoot, dir, "Extensions", extId);
        if (pathExists(extDir)) {
            return { ok: true, profileDir: dir, source: "full-scan" };
        }
    }

    return { ok: false, message: `未在任何 profile 下找到扩展 ${extId}（扩展未安装或为便携版）` };
}
