// Importing modules
import mongoose from "mongoose";
import AuditEvent from "../models/auditEvent.model.js";
import logger from "../config/logger.config.js";

export interface AuditInput {
    organizationId: mongoose.Types.ObjectId | string;
    actorType: "user" | "agent" | "system";
    actorId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    decision?: "allow" | "needs_approval" | "deny" | null;
    outcome: "success" | "failure" | "pending" | "uncertain" | "denied";
    policyVersion?: number;
    correlationId?: string;
    metadata?: Record<string, unknown>;
}

// writes one append-only audit event; audit failures are logged loudly but never swallowed silently
export async function audit(event: AuditInput) {
    try {
        await AuditEvent.create(event);
    } catch (error) {
        logger.error({ error, event }, "Failed to write audit event");
        throw error;
    }
}
