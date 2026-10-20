/**
 * 设备配对（设计文档 §6.1 / §7，D1 简化互信模型）：
 * 「插件批准 deviceId，Broker 持钥签名」——插件下发 challenge，Broker 用设备私钥
 * 签名应答，插件验签并核对批准列表。批准列表本身存插件侧（chrome.storage），
 * Broker 只负责签名与记录扩展上报的 approved 状态。
 *
 * 依赖注入 cryptoImpl/now，可单测。
 */

import crypto from "node:crypto";
import { buildProofPayload, deviceIdFromRawKey } from "../device-identity.mjs";

/** 协议版本（v3：续跑下线 / 中断终态化 / 单任务上限口径，双端严格等值） */
export const PROTOCOL_VERSION = 2;
export const CHALLENGE_TTL_MS = 30_000;

export function createPairing({ identity, now = () => Date.now(), challengeTtlMs = CHALLENGE_TTL_MS, logger = console } = {}) {
    /** @type {Map<string, {nonce: string, expiresAt: number, extId: string|null}>} */
    const pendingChallenges = new Map();

    function verifyChallenge(challenge) {
        if (!challenge || typeof challenge !== "object") return "challenge 非法";
        if (typeof challenge.challengeId !== "string" || typeof challenge.nonce !== "string") {
            return "challenge 字段缺失";
        }
        if (challenge.protocolVersion !== PROTOCOL_VERSION) return "PROTOCOL_VERSION_MISMATCH";
        if (now() > (challenge.expiresAt ?? 0)) return "challenge 已过期";
        return null;
    }

    return {
        /** 生成 proof 应答（无身份/挑战非法时返回 proof.error 消息） */
        respondToChallenge(challenge, extId) {
            const invalid = verifyChallenge(challenge);
            if (invalid) {
                logger.warn?.(`[broker] challenge 拒绝: ${invalid}`);
                return {
                    type: "session.proof.error",
                    challengeId: String(challenge?.challengeId ?? ""),
                    code: invalid === "PROTOCOL_VERSION_MISMATCH" ? "PROTOCOL_VERSION_MISMATCH" : "AUTH_FAILED",
                    message: invalid,
                };
            }
            if (!identity) {
                return {
                    type: "session.proof.error",
                    challengeId: challenge.challengeId,
                    code: "AUTH_FAILED",
                    message: "Broker 设备身份未初始化",
                };
            }
            pendingChallenges.set(challenge.challengeId, {
                nonce: challenge.nonce,
                expiresAt: challenge.expiresAt,
                extId: extId ?? null,
            });
            const payload = buildProofPayload({
                deviceId: identity.deviceId,
                challengeId: challenge.challengeId,
                nonce: challenge.nonce,
                extId: extId ?? "",
                protocolVersion: PROTOCOL_VERSION,
            });
            return {
                type: "session.proof",
                challengeId: challenge.challengeId,
                deviceId: identity.deviceId,
                publicKey: identity.publicKey,
                hostKey: identity.host,
                displayName: identity.displayName,
                signature: identity.sign(payload),
                protocolVersion: PROTOCOL_VERSION,
            };
        },

        /** 清理过期 challenge（watchdog 调用） */
        sweepExpired() {
            const t = now();
            for (const [id, c] of pendingChallenges) {
                if (c.expiresAt < t) pendingChallenges.delete(id);
            }
        },

        /** 供测试：由私钥推导 deviceId（与插件侧一致） */
        get deviceId() {
            return identity?.deviceId ?? null;
        },

        get fingerprint() {
            return identity?.fingerprint ?? null;
        },

        get hostKey() {
            return identity?.host ?? null;
        },

        get displayName() {
            return identity?.displayName ?? null;
        },

        _crypto: crypto,
        _deviceIdFromRawKey: deviceIdFromRawKey,
    };
}
