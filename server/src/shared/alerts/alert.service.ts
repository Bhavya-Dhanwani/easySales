// Importing modules
import mongoose from "mongoose";
import env from "../config/env.config.js";
import logger from "../config/logger.config.js";
import AuditEvent from "../models/auditEvent.model.js";

export type AlertKind = "workflow_failed" | "budget_exhausted" | "send_cap_reached" | "uncertain_send" | "complaint";

const lastSent = new Map<string, number>();
const THROTTLE_MS = 60 * 60_000;

/*
    Operational alert: always an error log + an audit event (visible in the app), and a
    POST to ALERT_WEBHOOK_URL (Slack/Discord-compatible { text }) when configured.
    ponytail: in-process throttle per org+kind per hour; move to a shared store when running many workers.
*/
export async function alert(organizationId: mongoose.Types.ObjectId | string, kind: AlertKind, message: string, metadata: Record<string, unknown> = {}) {
    const key = `${organizationId}:${kind}`;
    if (Date.now() - (lastSent.get(key) ?? 0) < THROTTLE_MS) return;
    lastSent.set(key, Date.now());

    logger.error({ organizationId: String(organizationId), kind, ...metadata }, `ALERT: ${message}`);
    await AuditEvent.create({
        organizationId, actorType: "system", actorId: "alerts", action: `alert.${kind}`, outcome: "failure", metadata: { message, ...metadata },
    }).catch((error) => logger.error(error, "Failed to record alert"));

    if (!env.ALERT_WEBHOOK_URL) return;
    try {
        await fetch(env.ALERT_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `[easySales] ${kind} (org ${organizationId}): ${message}` }),
            signal: AbortSignal.timeout(5000),
        });
    } catch (error) {
        logger.error(error, "Alert webhook delivery failed");
    }
}

// tests reset the throttle between cases
export const resetAlertThrottle = () => lastSent.clear();
