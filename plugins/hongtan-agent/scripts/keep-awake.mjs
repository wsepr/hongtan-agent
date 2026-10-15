/**
 * 任务期间阻止系统休眠（设计文档 §10.7 环①，执行计划 D2）。
 *
 * Windows 实现派生 PowerShell 宿主进程循环调用
 * SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)；任务进入终态即杀进程释放。
 * 非 Windows 平台为 no-op（macOS/Linux 的休眠管理留 Phase 3）。
 *
 * 方案未真机验证（执行计划风险 D2）：失败时降级为 onboarding 提示，不阻塞任务。
 */

import { spawn } from "node:child_process";

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

const POWERSHELL_SCRIPT = `
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
while ($true) {
  [Win32.Power]::SetThreadExecutionState(${ES_CONTINUOUS + ES_SYSTEM_REQUIRED}) | Out-Null
  Start-Sleep -Seconds 60
}
`;

export function createKeepAwake({
    platform = process.platform,
    spawnImpl = spawn,
    logger = console,
} = {}) {
    /** @type {any} */
    let child = null;
    let acquireCount = 0;

    return {
        /** 任务进入 running 时调用（幂等：引用计数） */
        acquire(reason = "task-running") {
            acquireCount += 1;
            if (child) return { ok: true, alreadyHeld: true };
            if (platform !== "win32") {
                logger.info?.("[keep-awake] 非 Windows 平台暂不实现阻止休眠");
                return { ok: false, unsupported: true };
            }
            try {
                child = spawnImpl(
                    "powershell.exe",
                    ["-NoProfile", "-WindowStyle", "Hidden", "-Command", POWERSHELL_SCRIPT],
                    { detached: false, stdio: "ignore", windowsHide: true }
                );
                child.on("error", (e) => {
                    logger.warn?.("[keep-awake] 保活进程创建失败（D2 降级）:", e?.message ?? e);
                    child = null;
                });
                logger.info?.(`[keep-awake] 已阻止系统休眠 (${reason})`);
                return { ok: true };
            } catch (e) {
                logger.warn?.("[keep-awake] 保活进程创建异常（D2 降级）:", e?.message ?? e);
                child = null;
                return { ok: false, error: e?.message ?? String(e) };
            }
        },

        /** 任务进入终态时调用（引用计数归零即释放） */
        release() {
            acquireCount = Math.max(0, acquireCount - 1);
            if (acquireCount > 0 || !child) return { ok: true, released: false };
            try {
                child.kill();
                logger.info?.("[keep-awake] 已释放休眠阻止");
            } catch {
                /* 进程已退出 */
            }
            child = null;
            acquireCount = 0;
            return { ok: true, released: true };
        },

        isHeld() {
            return child !== null;
        },
    };
}
