/**
 * append-only 审计日志（设计文档 §11）——JSONL，一行一事件，只增不改。
 * 记录：任务生命周期、连接事件、配对/批准/撤销、浏览器拉起（S2 起）、配额拒绝。
 */

import fs from "node:fs";
import path from "node:path";

export function createAudit({ filePath, fsImpl = fs, now = () => Date.now() } = {}) {
    function append(event, details = {}) {
        if (!filePath) return;
        try {
            fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
            fsImpl.appendFileSync(
                filePath,
                JSON.stringify({ ts: now(), event, ...details }) + "\n"
            );
        } catch {
            /* 审计失败不阻断主流程 */
        }
    }
    return { append };
}
