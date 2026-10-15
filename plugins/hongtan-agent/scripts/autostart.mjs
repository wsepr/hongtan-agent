/**
 * 开机自启注册（设计文档 §10.7 环②，执行计划 S2 工作项 6 / R6）。
 *
 * Windows：HKCU Run 键（reg add，幂等覆盖）；macOS/Linux 留 Phase 3。
 * Broker 启动时调用；安全软件可能拦截（R6），失败仅记录不阻塞。
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "HongtanAgent";

export function createAutostart({
    platform = process.platform,
    execFileImpl = execFile,
    env = process.env,
    logger = console,
} = {}) {
    return {
        /** 幂等注册开机自启（每次 Broker 启动调用，覆盖写入最新路径） */
        async ensure() {
            if (platform !== "win32") {
                return { ok: false, unsupported: true };
            }
            const brokerPath = fileURLToPath(new URL("../broker-server.mjs", import.meta.url));
            const command = `"${process.execPath}" "${brokerPath}"`;
            try {
                await new Promise((resolve, reject) => {
                    execFileImpl("reg.exe", ["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", command, "/f"], (err) => (err ? reject(err) : resolve()));
                });
                logger.info?.("[autostart] 已注册开机自启（HKCU Run）");
                return { ok: true };
            } catch (e) {
                // R6：部分安全软件拦截注册表写入——提示用户手动放行，不阻塞
                logger.warn?.("[autostart] 开机自启注册失败（可能被安全软件拦截，需手动放行）:", e?.message ?? e);
                return { ok: false, error: e?.message ?? String(e) };
            }
        },

        async remove() {
            if (platform !== "win32") return { ok: false, unsupported: true };
            try {
                await new Promise((resolve, reject) => {
                    execFileImpl("reg.exe", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"], (err) => (err ? reject(err) : resolve()));
                });
                return { ok: true };
            } catch (e) {
                return { ok: false, error: e?.message ?? String(e) };
            }
        },

        _valueName: VALUE_NAME,
        _runKey: RUN_KEY,
        _brokerUrl: () => pathToFileURL(path.resolve(fileURLToPath(new URL("../broker-server.mjs", import.meta.url)))),
    };
}
