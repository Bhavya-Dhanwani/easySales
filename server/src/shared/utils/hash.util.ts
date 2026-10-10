// Importing modules
import { createHash } from "node:crypto";

// JSON with sorted keys, so logically equal payloads hash equally
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// binds an approval to the exact action payload it was granted for
export function hashPayload(payload: unknown) {
    return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
