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

/** 标准进程环境的三处来源（顺序即优先级：后写覆盖先写）。
 *  这正是 explorer 那份环境块的上游——于是它也是「让子进程像正常用户进程」的正解。 */
const SYSTEM_ENV_ROOTS = [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
    "HKCU\\Volatile Environment",
];

/** 会话内置的「安装目录族」变量**不在**上面两处 Environment 键里——它们由会话管理器在建会话时
 *  按本表从 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion` 推导后注入进程环境。
 *  缺了它们进程环境就「不像正常用户进程」：实测 Broker 精简环境恰好缺 `ProgramFiles(x86)`，
 *  而它正是让 Edge 启动约 10s 后清理 extensions.settings / Extensions 目录的那一项（单变量实验）。 */
const INSTALL_DIRS_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion";
const INSTALL_DIR_VARS = [
    { varName: "ProgramFiles", regValue: "ProgramFilesDir" },
    { varName: "ProgramW6432", regValue: "ProgramFilesDir" },
    { varName: "ProgramFiles(x86)", regValue: "ProgramFilesDir (x86)" },
    { varName: "CommonProgramFiles", regValue: "CommonFilesDir" },
    { varName: "CommonProgramW6432", regValue: "CommonFilesDir" },
    { varName: "CommonProgramFiles(x86)", regValue: "CommonFilesDir (x86)" },
];

/** 计算机名同样由会话注入（不在 Environment 键里）。 */
const COMPUTER_NAME_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName";

/**
 * 解析 `reg query <key>`（不带 /ve，即枚举全部值）的输出。真实输出形如：
 *   HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment
 *       ComSpec    REG_EXPAND_SZ    %SystemRoot%\system32\cmd.exe
 *       Path       REG_EXPAND_SZ    %SystemRoot%\system32;%SystemRoot%
 * 值行以缩进开头，首行是键名本身——只取值行。**值名可以含空格**（`ProgramFilesDir (x86)` 这类），
 * 故不能用 `\S+` 取名字，须靠 `REG_*` 类型列定位切分。
 * @returns {Array<{name: string, type: string, value: string}>}
 */
export function parseRegValues(stdout) {
    const entries = [];
    if (typeof stdout !== "string") return entries;
    for (const line of stdout.split(/\r?\n/)) {
        if (!/^\s+\S/.test(line)) continue;
        const match = /^\s+(.+?)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
        if (!match) continue;
        entries.push({ name: match[1], type: match[2], value: match[3] });
    }
    return entries;
}

/**
 * 展开值里的 `%NAME%` 引用（注册表环境变量普遍是 REG_EXPAND_SZ）。
 * 不展开会让子进程看到字面量 `%SystemRoot%\system32`。递归上限防自引用死循环。
 * @param {string} value
 * @param {(name: string) => string | undefined} lookup
 * @param {number} [depth]
 */
export function expandEnvRefs(value, lookup, depth = 0) {
    if (typeof value !== "string" || depth >= 5) return value;
    const next = value.replace(/%([^%]+)%/g, (whole, name) => lookup(name) ?? whole);
    return next === value ? value : expandEnvRefs(next, lookup, depth + 1);
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

    /** 枚举整键（不带 /ve）。键不存在/读取失败一律空数组——环境块宁可少几项也不能崩。 */
    function regQueryAll(key) {
        if (platform !== "win32") return [];
        try {
            const result = execImpl("reg.exe", ["query", key], { encoding: "utf8", windowsHide: true });
            if (result?.error || result?.status !== 0) return [];
            return parseRegValues(result.stdout);
        } catch {
            return [];
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
         *  unpacked 天然免疫。任何失败返回 null（文件缺失/损坏/字段缺失）。
         *  方法名必须与 browserManager 的 joined 白名单键一致：曾叫 readLocalStateLastUsed 而白名单取
         *  lastUsedProfile，导致这条回退在生产静默不可达（单测注入桩故抓不到）。 */
        lastUsedProfile(userDataRoot) {
            if (!userDataRoot) return null;
            try {
                const raw = fsImpl.readFileSync(path.join(userDataRoot, "Local State"), "utf8");
                const used = JSON.parse(raw)?.profile?.last_used;
                return typeof used === "string" && used ? used : null;
            } catch {
                return null;
            }
        },

        /** 拉起浏览器前构造子进程环境块（配合 child-env.mergeChildEnvironment）：读机器级 + 用户级 +
         *  易失级注册表环境，再补出会话内置的安装目录族与计算机名——合起来就是 explorer 那份标准
         *  环境块。非 win32 或读取失败返回 {}（调用方退化为沿用 Broker 自身环境，与旧行为一致）。 */
        readSystemEnvironment() {
            if (platform !== "win32") return {};
            const collected = new Map();
            for (const root of SYSTEM_ENV_ROOTS) {
                for (const entry of regQueryAll(root)) {
                    // REG_MULTI_SZ 不是环境变量类型；丢弃无损失——Broker 自带的 PATH 会在合并时胜出
                    if (entry.type === "REG_MULTI_SZ") continue;
                    collected.set(entry.name.toLowerCase(), { name: entry.name, value: entry.value });
                }
            }

            // 安装目录族：注册表 Environment 键里没有，但正常用户进程一定带着（见 INSTALL_DIR_VARS）
            const installDirs = new Map(regQueryAll(INSTALL_DIRS_KEY).map((e) => [e.name.toLowerCase(), e.value]));
            for (const { varName, regValue } of INSTALL_DIR_VARS) {
                if (collected.has(varName.toLowerCase())) continue;
                const value = installDirs.get(regValue.toLowerCase());
                if (value) collected.set(varName.toLowerCase(), { name: varName, value });
            }

            const computerName = regQueryAll(COMPUTER_NAME_KEY).find((e) => e.name.toLowerCase() === "computername");
            if (computerName && !collected.has("computername")) {
                collected.set("computername", { name: "COMPUTERNAME", value: computerName.value });
            }

            // 注册表值普遍是 REG_EXPAND_SZ（%SystemRoot% 之类），须就地展开；用同一份集合做查表
            const lookup = (name) => collected.get(String(name).toLowerCase())?.value;
            const out = {};
            for (const { name, value } of collected.values()) out[name] = expandEnvRefs(value, lookup);
            return out;
        },
    };
}
