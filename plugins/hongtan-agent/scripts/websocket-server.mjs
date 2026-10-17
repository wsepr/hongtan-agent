/**
 * 零依赖 loopback WebSocket 服务端（仅 Node 路径，裁剪自 MediaClaw-Agent 的
 * plugins/mediaclaw/scripts/websocket-server.mjs，Apache-2.0 License，
 * 版权与许可声明按裁剪约定保留在本文件头）。
 *
 * 职责：帧编解码、Origin 白名单（仅 chrome-extension://）、单帧 ≤1MB、
 * 消息速率限制 ~180 条/分钟、仅绑定 127.0.0.1。
 *
 * Copyright 2025 MediaClaw-Agent contributors (Apache-2.0)
 * Modifications copyright (c) 2026 红探 (xhs-analyze) — trimmed to the Node path only.
 */

import crypto from "node:crypto";
import http from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES_PER_MINUTE = 180;

function isAllowedWebSocketOrigin(origin) {
    const normalized = String(origin || "").trim();
    // 浏览器扩展不一定发送 Origin 头（MV3 SW 场景稳定发送 chrome-extension://）；
    // 允许空 Origin 以兼容 curl 等调试工具，仅回环监听兜底
    return !normalized || normalized.startsWith("chrome-extension://");
}

function encodeFrame(payload, opcode = 0x1) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    const header = [];
    header.push(0x80 | opcode);
    if (body.length < 126) {
        header.push(body.length);
    } else if (body.length <= 0xffff) {
        header.push(126, (body.length >> 8) & 0xff, body.length & 0xff);
    } else {
        const size = Buffer.alloc(8);
        size.writeBigUInt64BE(BigInt(body.length));
        header.push(127, ...size);
    }
    return Buffer.concat([Buffer.from(header), body]);
}

function createSocketPeer(socket, handlers = {}) {
    // 限流窗口取注入时钟（§4.2.3：判定用时间不得在逻辑深处直调 Date.now()）；
    // createSocketPeer 是模块级函数，时钟必须由工厂沿 handlers 传入
    const now = handlers.now ?? (() => Date.now());
    let buffer = Buffer.alloc(0);
    let closed = false;
    let closeNotified = false;
    const messageTimes = [];

    function sendRaw(payload, opcode = 0x1) {
        if (closed || socket.destroyed) return false;
        socket.write(encodeFrame(payload, opcode));
        return true;
    }

    const peer = {
        send(payload) {
            return sendRaw(JSON.stringify(payload));
        },
        close(code = 1000, reason = "") {
            if (closed) return;
            const body = Buffer.alloc(2 + Buffer.byteLength(reason));
            body.writeUInt16BE(code, 0);
            body.write(reason, 2);
            sendRaw(body, 0x8);
            socket.end();
            closed = true;
        },
        get isOpen() {
            return !closed && !socket.destroyed;
        },
    };

    function consumeFrames() {
        while (buffer.length >= 2) {
            const first = buffer[0];
            const second = buffer[1];
            const opcode = first & 0x0f;
            const masked = Boolean(second & 0x80);
            let length = second & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                const largeLength = buffer.readBigUInt64BE(2);
                if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                    peer.close(1009, "Frame too large");
                    return;
                }
                length = Number(largeLength);
                offset = 10;
            }

            const maskBytes = masked ? 4 : 0;
            if (!masked || length > MAX_CLIENT_FRAME_BYTES) {
                peer.close(1009, "Invalid or oversized client frame");
                return;
            }
            const frameEnd = offset + maskBytes + length;
            if (buffer.length < frameEnd) return;
            const mask = masked ? buffer.subarray(offset, offset + 4) : null;
            const payload = Buffer.from(buffer.subarray(offset + maskBytes, frameEnd));
            buffer = buffer.subarray(frameEnd);

            if (mask) {
                for (let index = 0; index < payload.length; index += 1) {
                    payload[index] ^= mask[index % 4];
                }
            }

            if (opcode === 0x8) {
                peer.close();
                return;
            }
            if (opcode === 0x9) {
                sendRaw(payload, 0x0a);
                continue;
            }
            if (opcode !== 0x1) continue;

            const currentTime = now();
            while (messageTimes.length && messageTimes[0] <= currentTime - 60_000) {
                messageTimes.shift();
            }
            if (messageTimes.length >= MAX_MESSAGES_PER_MINUTE) {
                peer.close(1008, "Message rate limit exceeded");
                return;
            }
            messageTimes.push(currentTime);

            try {
                handlers.onMessage?.(JSON.parse(payload.toString("utf8")), peer);
            } catch (error) {
                handlers.onMalformedMessage?.(error, peer);
            }
        }
    }

    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        consumeFrames();
    });
    socket.on("close", () => {
        closed = true;
        if (!closeNotified) {
            closeNotified = true;
            handlers.onClose?.(peer);
        }
    });
    socket.on("error", (error) => {
        handlers.onError?.(error, peer);
    });

    return peer;
}

export function createLoopbackWebSocketServer({
    port = 17373,
    path = "/extension",
    serviceName = "hongtan-agent-broker",
    onHttpRequest,
    onConnection,
    onMessage,
    onClose,
    refuseUpgrade,
    logger = console,
    now = () => Date.now(),
} = {}) {
    const server = http.createServer((request, response) => {
        void handleHttpRequest(request, response);
    });

    async function handleHttpRequest(request, response) {
        // 宿主回调优先：Broker 的 /health 扩展（§11.3：队列深度、扩展最近心跳、最近 N 个任务摘要、
        // 版本与运行时长）必须能覆盖本模块的极简健康响应。原先 /health 在上面的分支被直接短路，
        // 导致真实路径上永远只返回 {ok, service, websocketPath}，§11.3 的扩展字段根本不可达。
        try {
            if (await onHttpRequest?.(request, response)) {
                return;
            }
        } catch (error) {
            logger.error?.("[broker] HTTP request failed:", error);
            if (!response.headersSent) {
                response.writeHead(500, { "content-type": "application/json" });
            }
            response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            return;
        }
        // 无宿主回调（或宿主未处理）时的兜底：极简健康响应 + 404
        if (request.method === "GET" && (request.url === "/health" || request.url === "/")) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, service: serviceName, websocketPath: path }));
            return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "not_found" }));
    }

    server.on("upgrade", (request, socket) => {
        let requestUrl;
        try {
            requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
        } catch {
            socket.destroy();
            return;
        }
        if (
            requestUrl.pathname !== path ||
            String(request.headers.upgrade || "").toLowerCase() !== "websocket"
        ) {
            socket.destroy();
            return;
        }
        if (!isAllowedWebSocketOrigin(request.headers.origin)) {
            socket.destroy();
            return;
        }
        // 抓取 + 硬化：退避冷却期内必须在建立会话之前拒连，否则「每 1–3s 连一次」的 churn 依旧存在。
        // 以 HTTP 429 表达（升级前本就是 HTTP 语义），未提供钩子时零影响。
        const refusal = refuseUpgrade?.(request);
        if (refusal) {
            const body = JSON.stringify({ ok: false, error: refusal.reason ?? "upgrade_refused" });
            socket.write(
                [
                    "HTTP/1.1 429 Too Many Requests",
                    "Connection: close",
                    `Retry-After: ${refusal.retryAfterSec ?? 60}`,
                    "content-type: application/json",
                    `content-length: ${Buffer.byteLength(body)}`,
                    "",
                    body,
                ].join("\r\n")
            );
            socket.destroy();
            return;
        }
        const key = String(request.headers["sec-websocket-key"] || "");
        if (!key) {
            socket.destroy();
            return;
        }
        const accept = crypto
            .createHash("sha1")
            .update(key + WEBSOCKET_GUID)
            .digest("base64");
        socket.write(
            [
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${accept}`,
                "\r\n",
            ].join("\r\n")
        );
        const peer = createSocketPeer(socket, {
            now,
            onMessage,
            onClose,
            onMalformedMessage(error) {
                logger.error?.("[broker] invalid extension message:", error?.message);
            },
            onError(error) {
                logger.error?.("[broker] extension socket error:", error?.message);
            },
        });
        onConnection?.(peer, request);
    });

    return {
        async listen() {
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, "127.0.0.1", () => {
                    server.off("error", reject);
                    resolve();
                });
            });
            return { host: "127.0.0.1", port, path };
        },
        async close() {
            // fetch（undici）的 keep-alive 空闲连接会无限期阻塞 server.close()，
            // 必须主动断开（Node 18.2+）
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
        server,
    };
}
