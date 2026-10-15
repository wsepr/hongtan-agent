/**
 * [hongtan-agent] 传输层错误分类与重试策略（纯函数，供 mcp-server 与单测使用）
 *
 * 三类语义（问题清单 1.4）：
 * - not_reached：请求确定未抵达 Broker（连接被拒/地址不可用）→ 可安全重发。
 * - response_unknown：请求可能已派发、结果未知（响应头/体超时、连接重置等）
 *   → 仅幂等只读工具允许自动重发，其余必须返回 BROKER_NO_RESPONSE 让 AI 先查状态。
 * - cancelled：本方主动放弃（自身超时或宿主取消）→ 不重试，避免重复执行有副作用的工具。
 *
 * undici 的响应头超时抛的是顶层 TypeError（cause = HeadersTimeoutError），
 * 因此必须沿 cause 链逐层判定，不能只看顶层。
 */

const NOT_REACHED_CODES = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "ENOTFOUND", "EACCES"]);
// 连接建立失败（未送达）也算 not_reached
const NOT_REACHED_NAMES = new Set(["UND_ERR_CONNECT_TIMEOUT"]);
const RESPONSE_UNKNOWN_CODES = new Set([
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
]);
const RESPONSE_UNKNOWN_NAMES = new Set(["HeadersTimeoutError", "BodyTimeoutError"]);

const MAX_CAUSE_DEPTH = 5;

export function classifyTransportError(error) {
    let cur = error;
    for (let depth = 0; cur && depth <= MAX_CAUSE_DEPTH; depth += 1) {
        if (NOT_REACHED_CODES.has(cur.code) || NOT_REACHED_NAMES.has(cur.name)) return "not_reached";
        if (RESPONSE_UNKNOWN_CODES.has(cur.code) || RESPONSE_UNKNOWN_NAMES.has(cur.name)) return "response_unknown";
        if (cur.name === "TimeoutError" || cur.name === "AbortError") return "cancelled";
        cur = cur.cause;
    }
    return "response_unknown";
}

export const IDEMPOTENT_TOOLS = new Set([
    "xhs_connection_status",
    "xhs_list_datasets",
    "xhs_task_status",
    "xhs_task_list",
    "xhs_wait_for_task",
]);

export function shouldAutoRetry(classification, tool) {
    if (classification === "not_reached") return true;
    if (classification === "response_unknown") return IDEMPOTENT_TOOLS.has(tool);
    return false;
}
