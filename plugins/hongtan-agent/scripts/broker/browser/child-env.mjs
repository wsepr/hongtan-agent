/**
 * 浏览器子进程环境块（v2.11）——为什么必须显式构造：
 *
 * Broker 自身是被宿主以**精简环境**启动的（实测只有 32 个变量，且缺少 Windows 标准进程变量）。
 * `spawn(file, args, { detached, stdio, windowsHide })` 不传 env 时子进程继承这份残缺环境块，
 * 于是浏览器拿到的是一个「不像正常用户进程」的环境——实测（10-17 单变量实验）**仅缺
 * `ProgramFiles(x86)` 一项**，Edge 就会在启动后约 10s 判定 profile 不可信：清空
 * `extensions.settings`（9 个用户扩展 → 0）、丢弃受保护顶层键、GC `Extensions` 目录。
 * 手动打开 Edge 之所以正常，正是因为 explorer 拉起时给的是**完整标准环境**。
 *
 * 所以拉起前把「机器级 + 用户级注册表环境」（= explorer 那份环境的来源）并进来。
 * 合并按**不区分大小写**进行：Windows 环境名大小写不敏感，Broker 自带 `PROGRAMFILES`
 * 与注册表 `ProgramFiles` 若各自保留会生成重复键；冲突时 **Broker 自有值优先**
 * （它的 `PATH`/`TEMP` 是宿主已合并过的运行时值，比注册表原始值更准）。
 *
 * 纯函数（不碰系统）：注册表读取由 os-probes 的 `readSystemEnvironment` 负责。
 */

/**
 * @param {{ baseEnv?: Record<string, string>, systemEnv?: Record<string, string> }} [deps]
 * @returns {Record<string, string>} 合并后的环境块（非字符串值一律丢弃）
 */
export function mergeChildEnvironment({ baseEnv = {}, systemEnv = {} } = {}) {
    const merged = new Map();
    for (const source of [systemEnv, baseEnv]) {
        for (const [name, value] of Object.entries(source)) {
            if (!name || typeof value !== "string") continue;
            // 后写者覆盖前者：保留胜出方的原始大小写写法
            merged.set(name.toLowerCase(), { name, value });
        }
    }
    const result = {};
    for (const { name, value } of merged.values()) result[name] = value;
    return result;
}
