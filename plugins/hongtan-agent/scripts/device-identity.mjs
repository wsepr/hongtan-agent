/**
 * ed25519 设备身份（裁剪自 MediaClaw-Agent 的 scripts/device-identity.mjs，Apache-2.0，
 * 版权与许可声明按裁剪约定保留在本文件头）。
 *
 * 与 MediaClaw 的差异（D1 落地形态）：设备私钥由 Broker 持有（%APPDATA%\红探 Agent\），
 * deviceId = sha256(raw 公钥) 前 24 位（raw = SPKI DER 末 32 字节），与插件侧
 * plugin/src/background/agent/protocol.ts 的验签逻辑一致。
 *
 * Copyright 2025 MediaClaw-Agent contributors (Apache-2.0)
 * Modifications copyright (c) 2026 红探 (xhs-analyze) — adapted to raw-key deviceId convention.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function resolveStateDirectory(env = process.env) {
    if (env.HONGTAN_AGENT_STATE_DIR) {
        return path.resolve(env.HONGTAN_AGENT_STATE_DIR);
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support", "红探 Agent");
    }
    if (process.platform === "win32" && env.APPDATA) {
        return path.join(env.APPDATA, "红探 Agent");
    }
    return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hongtan-agent");
}

export function rawKeyFromSpki(spkiBase64) {
    const der = Buffer.from(spkiBase64, "base64");
    if (der.length < 32) throw new Error("publicKey 长度非法");
    // 复制出独立缓冲区，避免视图别名
    return Buffer.from(der.subarray(der.length - 32));
}

export function deviceIdFromRawKey(rawKey) {
    return `device_${crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 24)}`;
}

export function fingerprintFromRawKey(rawKey) {
    const hex = crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 32);
    return (hex.match(/.{1,4}/g) ?? []).join("-");
}

/** proof 签名载荷（canonical string；与插件侧 protocol.ts 的 buildProofPayload 逐字节一致） */
export function buildProofPayload({ deviceId, challengeId, nonce, extId, protocolVersion }) {
    return Buffer.from(
        [
            "hongtan-agent",
            "proof",
            String(deviceId || "").trim(),
            String(challengeId || "").trim(),
            String(nonce || "").trim(),
            String(extId || "").trim(),
            String(protocolVersion || "").trim(),
        ].join("\n"),
        "utf8"
    );
}

export async function loadOrCreateDeviceIdentity({
    stateDirectory = resolveStateDirectory(),
    host = "workbuddy",
    displayName,
} = {}) {
    const filePath = path.join(stateDirectory, "device-identity.json");
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(stateDirectory, 0o700).catch(() => {});

    let stored = null;
    try {
        stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
        stored = null;
    }

    if (!stored?.privateKeyPem || !stored?.publicKey) {
        const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
        const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
        stored = {
            version: 1,
            publicKey: publicKeyBase64,
            privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
            host,
            displayName: displayName ?? `红探 Agent (${host})`,
            createdAt: new Date().toISOString(),
        };
        await fs.writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    await fs.chmod(filePath, 0o600).catch(() => {});

    const privateKey = crypto.createPrivateKey(stored.privateKeyPem);
    const rawKey = rawKeyFromSpki(stored.publicKey);
    return {
        deviceId: deviceIdFromRawKey(rawKey),
        publicKey: stored.publicKey,
        rawKey,
        fingerprint: fingerprintFromRawKey(rawKey),
        host: stored.host ?? host,
        displayName: stored.displayName ?? displayName ?? `红探 Agent (${host})`,
        createdAt: stored.createdAt,
        sign(payload) {
            return crypto.sign(null, payload, privateKey).toString("base64");
        },
    };
}
