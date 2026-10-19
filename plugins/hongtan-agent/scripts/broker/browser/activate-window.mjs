/**
 * OS 级窗口前台化（《抓取窗口前台化与后台不停摆 实施方案》方案 B）。
 *
 * 为什么必须由 Broker 做：扩展侧 `chrome.windows.update({focused:true})` 在 Windows 上被
 * **Chromium 自身的 focus-stealing prevention** 拒绝（实测：只闪任务栏、窗口纹丝不动；
 * `minimized→normal+focused`、`fullscreen→normal+focused` 等状态转换 hack 亦全部失败）。
 * 而由与前台应用**没有任何血缘关系**的后台进程直接调 Win32 `ShowWindowAsync(SW_RESTORE)` +
 * `SetForegroundWindow`，实测可以真正把窗口切到系统前台（且不需要 ALT 注入 hack）。
 *
 * 打包约束：standalone 运行时（bun compile）不内嵌「运行期 readFileSync 读取的文件」，
 * 故 PowerShell 脚本以本模块内的**静态字符串常量**随包，不落 .ps1 文件。
 *
 * 安全约束（SECURITY.md §5.1）：只针对引导期固化的浏览器家族的窗口；脚本走 `-EncodedCommand`
 * （base64/UTF-16LE），参数只经环境变量传入——命令行与脚本正文里都不出现不可信文本，无拼接注入面。
 */

import { spawn } from "node:child_process";
import { BROWSER_FAMILIES } from "./family-table.mjs";

/** 目标窗口类名（Chromium 系顶层窗口统一类名；注意 IDE/Electron 应用也是这个类名 → 必须叠加进程名白名单） */
const CHROMIUM_WINDOW_CLASS = "Chrome_WidgetWin_1";

/**
 * Windows 侧 PowerShell 脚本（PS 5.1 兼容）。约定：
 * - 入参只从环境变量读：HONGTAN_AW_PROCNAMES（`|` 分隔的映像名）、HONGTAN_AW_HINT（标题子串，可空）、
 *   HONGTAN_AW_SETTLE_MS（置前后复核等待）；
 * - stdout **只输出一行 JSON** `{ok, reason, hwnd, candidates}`（不含标题：PS 5.1 管道编码会破坏非 ASCII）；
 * - 失败不抛到 stdout，一律以 `{ok:false, reason}` 表达，便于 Node 侧统一处置。
 */
export const WINDOWS_ACTIVATE_SCRIPT = `$ErrorActionPreference = 'Stop'
$procNames = $env:HONGTAN_AW_PROCNAMES
$hint = $env:HONGTAN_AW_HINT
$settle = 600
if ($env:HONGTAN_AW_SETTLE_MS) { try { $settle = [int]$env:HONGTAN_AW_SETTLE_MS } catch { } }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public class HongtanForeground {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);

    static readonly List<string> hits = new List<string>();
    static HashSet<string> procs;

    public static string[] ListCandidates(string names) {
        procs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string raw in names.Split('|')) {
            string name = raw.Trim();
            if (name.Length == 0) continue;
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            procs.Add(name);
        }
        hits.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            StringBuilder cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (cls.ToString() != "${CHROMIUM_WINDOW_CLASS}") return true;
            if (!IsWindowVisible(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string proc;
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { return true; }
            if (!procs.Contains(proc)) return true;
            StringBuilder title = new StringBuilder(512);
            GetWindowText(h, title, 512);
            hits.Add(((long)h).ToString("x") + "|" + title.ToString());
            return true;
        }, IntPtr.Zero);
        return hits.ToArray();
    }

    public static bool Activate(long hwnd, int settleMs) {
        IntPtr h = new IntPtr(hwnd);
        ShowWindowAsync(h, 9);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(settleMs);
        if (GetForegroundWindow() == h) return true;
        BringWindowToTop(h);
        SetForegroundWindow(h);
        System.Threading.Thread.Sleep(settleMs);
        return GetForegroundWindow() == h;
    }
}
'@

function Write-Verdict([bool]$ok, [string]$reason, [string]$hwnd, [int]$candidates) {
    @{ ok = $ok; reason = $reason; hwnd = $hwnd; candidates = $candidates } | ConvertTo-Json -Compress
}

try {
    $all = @([HongtanForeground]::ListCandidates($procNames))
    if ($all.Count -eq 0) { Write-Verdict $false 'window-not-found' '' 0; exit 0 }

    $matched = @()
    if ($hint) {
        foreach ($line in $all) {
            $title = ($line -split '\\|', 2)[1]
            if ($title -and $title.ToLower().Contains($hint.ToLower())) { $matched += $line }
        }
        if ($matched.Count -eq 0) { Write-Verdict $false 'window-not-found' '' $all.Count; exit 0 }
    } else {
        $matched = $all
    }

    if ($matched.Count -gt 1) { Write-Verdict $false 'ambiguous-window' '' $matched.Count; exit 0 }

    $hwndHex = ($matched[0] -split '\\|', 2)[0]
    $ok = [HongtanForeground]::Activate([Convert]::ToInt64($hwndHex, 16), $settle)
    if ($ok) { Write-Verdict $true 'foreground-ok' $hwndHex $all.Count }
    else { Write-Verdict $false 'foreground-denied' $hwndHex $all.Count }
} catch {
    Write-Verdict $false 'helper-failed' '' 0
}
`;

/** 供 `-EncodedCommand` 使用：脚本按 UTF-16LE 编码后 base64（避免命令行引号/转义问题） */
export function buildWindowsEncodedCommand(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_SETTLE_MS = 600;

/**
 * 执行一个捕获型子进程（区别于拉起浏览器用的 detached+ignore 风格：这里必须读 stdout）。
 * 超时强杀；spawn 抛错/`error` 事件（如 ENOENT）原样回报给调用方判定。
 */
function defaultSpawnCapture(file, args, options) {
    return spawn(file, args, options);
}

function runCapture(spawnCapture, file, args, { env, timeoutMs }) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawnCapture(file, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            resolve({ error: e, stdout: "", stderr: "", code: null });
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        /** 先声明后赋值：finish 会引用它，避免任何「事件早于定时器赋值」的引用错误（防御性，当前调用顺序下不可达） */
        let timer = null;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        timer = setTimeout(() => {
            // 先判定超时再杀子进程：kill 会（同步）触发 close，避免 close 抢先以「正常结束」收尾
            finish({ error: new Error(`helper 超时（${timeoutMs}ms）`), stdout, stderr, code: null, timedOut: true });
            try {
                child.kill();
            } catch {
                /* 已退出 */
            }
        }, timeoutMs);
        child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (e) => finish({ error: e, stdout, stderr, code: null }));
        child.on("close", (code) => finish({ error: null, stdout, stderr, code }));
    });
}

/** 从 helper 的 stdout 取最后一行 JSON（PS 可能夹带空行/BOM） */
export function parseHelperOutput(stdout) {
    if (typeof stdout !== "string" || stdout.trim() === "") return null;
    const line = stdout
        .split(/\r?\n/)
        .map((l) => l.replace(/^\uFEFF/, "").trim())
        .filter((l) => l !== "")
        .pop();
    if (!line) return null;
    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function failureFromCapture(result) {
    if (result?.error) {
        return { ok: false, reason: result.timedOut ? "timeout" : "helper-failed", detail: result.error.message };
    }
    return {
        ok: false,
        reason: "helper-failed",
        detail: String(result?.stderr ?? "").slice(0, 200) || `exit=${result?.code}`,
    };
}

/**
 * @param {object} options
 * @param {string} options.family 浏览器家族（chrome/edge/chromium，来自 browser.json 固化值）
 * @param {string|null} [options.titleHint] 目标窗口标题子串（可空 → 要求候选唯一）
 * @param {string} [options.platform]
 * @param {Function} [options.spawnCapture]
 * @param {Record<string,string>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.settleMs]
 * @returns {Promise<{ok: boolean, reason: string, hwnd?: string, candidates?: number, method?: string, detail?: string}>}
 */
export async function activateWindowOS({
    family,
    titleHint = null,
    platform = process.platform,
    spawnCapture = defaultSpawnCapture,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    settleMs = DEFAULT_SETTLE_MS,
} = {}) {
    const entry = BROWSER_FAMILIES[family];
    if (!entry) return { ok: false, reason: "unknown-family", detail: `未知浏览器家族: ${family}` };
    const hint = typeof titleHint === "string" ? titleHint.trim() : "";

    if (platform === "win32") {
        const procNames = entry.exeNames ?? [];
        if (procNames.length === 0) return { ok: false, reason: "unknown-family" };
        const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", buildWindowsEncodedCommand(WINDOWS_ACTIVATE_SCRIPT)];
        const childEnv = {
            ...env,
            HONGTAN_AW_PROCNAMES: procNames.join("|"),
            HONGTAN_AW_HINT: hint,
            HONGTAN_AW_SETTLE_MS: String(settleMs),
        };
        // pwsh 不保证存在（Windows PowerShell 5.1 才是必装项），逐个回退
        for (const shell of ["pwsh", "powershell.exe"]) {
            const result = await runCapture(spawnCapture, shell, args, { env: childEnv, timeoutMs });
            if (result.error?.code === "ENOENT") continue;
            if (result.error) return failureFromCapture(result);
            const parsed = parseHelperOutput(result.stdout);
            if (!parsed) return failureFromCapture(result);
            const ok = parsed.ok === true;
            return {
                ok,
                // reason 缺失时按 ok 补默认值：否则会产出 {ok:true, reason:"helper-failed"} 这类自相矛盾出参
                reason: typeof parsed.reason === "string" && parsed.reason !== "" ? parsed.reason : ok ? "foreground-ok" : "helper-failed",
                hwnd: typeof parsed.hwnd === "string" && parsed.hwnd !== "" ? parsed.hwnd : undefined,
                candidates: Number.isFinite(parsed.candidates) ? parsed.candidates : undefined,
                method: shell === "pwsh" ? "pwsh" : "powershell",
            };
        }
        return { ok: false, reason: "helper-missing", detail: "pwsh 与 powershell.exe 均不可用" };
    }

    if (platform === "darwin") {
        const label = entry.label;
        if (!label) return { ok: false, reason: "unknown-family" };
        // macOS 无 Windows 那种前台锁：任意进程可 activate 应用；但只能拉整个应用，精确到窗口需辅助功能权限
        const result = await runCapture(spawnCapture, "osascript", ["-e", `tell application "${label}" to activate`], {
            env,
            timeoutMs,
        });
        if (result.error?.code === "ENOENT") return { ok: false, reason: "helper-missing", detail: "osascript 不可用" };
        if (result.error) return failureFromCapture(result);
        if (result.code !== 0) return failureFromCapture(result);
        return { ok: true, reason: "foreground-ok", method: "osascript" };
    }

    // Linux：Wayland 从设计上禁止外部进程设置焦点，诚实降级；X11 走 wmctrl / xdotool
    if (env.WAYLAND_DISPLAY) {
        return { ok: false, reason: "unsupported-platform", detail: "wayland 不允许外部进程激活窗口" };
    }
    if (!hint) {
        // 无标题提示：与 Windows 分支同口径——先枚举候选并要求唯一，否则不猜
        // （否则可能把用户自有的浏览器窗口抢到前台，与"抢焦点只在必要时"的约束相悖）
        const cls = entry.linuxCommands?.[0] ?? entry.exeNames?.[0] ?? "";
        const search = await runCapture(spawnCapture, "xdotool", ["search", "--class", cls], { env, timeoutMs });
        if (search.error?.code === "ENOENT") return { ok: false, reason: "helper-missing", detail: "xdotool 不可用" };
        if (search.error) return failureFromCapture(search);
        const ids = String(search.stdout ?? "")
            .split(/\s+/)
            .filter((value) => value !== "");
        if (ids.length === 0) return { ok: false, reason: "window-not-found", candidates: 0 };
        if (ids.length > 1) return { ok: false, reason: "ambiguous-window", candidates: ids.length };
        const activate = await runCapture(spawnCapture, "xdotool", ["windowactivate", "--sync", ids[0]], { env, timeoutMs });
        if (activate.error) return failureFromCapture(activate);
        return activate.code === 0 ? { ok: true, reason: "foreground-ok", method: "xdotool" } : failureFromCapture(activate);
    }
    const attempts = [
        { file: "wmctrl", args: ["-a", hint] },
        { file: "xdotool", args: ["search", "--name", hint, "windowactivate", "--sync"] },
    ];
    let missing = true;
    for (const attempt of attempts) {
        const result = await runCapture(spawnCapture, attempt.file, attempt.args, { env, timeoutMs });
        if (result.error?.code === "ENOENT") continue;
        missing = false;
        if (result.error) return failureFromCapture(result);
        if (result.code === 0) return { ok: true, reason: "foreground-ok", method: attempt.file };
        if (attempt.file === attempts[attempts.length - 1].file) return failureFromCapture(result);
    }
    return missing
        ? { ok: false, reason: "helper-missing", detail: "wmctrl / xdotool 均不可用" }
        : { ok: false, reason: "foreground-denied" };
}
