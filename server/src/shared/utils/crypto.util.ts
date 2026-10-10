// Importing modules
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import env from "../config/env.config.js";

// AES-256-GCM for secrets at rest (e.g. SMTP passwords): iv.tag.ciphertext, base64url
const key = () => createHash("sha256").update(env.ENCRYPTION_KEY).digest();

export function encryptSecret(plain: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(sealed: string) {
    const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
