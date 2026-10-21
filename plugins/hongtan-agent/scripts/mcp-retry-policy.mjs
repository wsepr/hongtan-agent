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

/**
 * 数据读取工具：幂等只读，但单次响应最大 800k。超时后自动重发会重复拉取大响应，
 * 因此刻意不放进 IDEMPOTENT_TOOLS；由 BROKER_NO_RESPONSE 指引 AI 用更小范围手动重试。
 */
export const DATA_READ_TOOLS = new Set([
    "xhs_dataset_overview",
    "xhs_list_articles",
    "xhs_read_articles",
]);

/** BROKER_NO_RESPONSE 的 AI 指引：读类与启动/等待/取消类必须给不同处置 */
export function brokerNoResponseMessage(tool) {
    if (DATA_READ_TOOLS.has(tool)) {
        return "请求已送达 Broker 但未在时限内完成或已被取消，执行结果未知。读类调用若确需继续，可用更小范围（更少 articleIds、更小 pageSize/commentLimit）重试一次。";
    }
    return "请求已送达 Broker 但未在时限内收到响应，执行结果未知。先调 xhs_task_status 确认是否已生效，禁止直接重发等待/启动/取消类调用。";
}

export function shouldAutoRetry(classification, tool) {
    if (classification === "not_reached") return true;
    if (classification === "response_unknown") return IDEMPOTENT_TOOLS.has(tool);
    return false;
}
