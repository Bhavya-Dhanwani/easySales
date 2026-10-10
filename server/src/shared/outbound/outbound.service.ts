// Importing modules
import mongoose from "mongoose";
import Message from "../models/message.model.js";
import Approval from "../models/approval.model.js";
import Conversation from "../models/conversation.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import { evaluate, PolicyResult } from "../policy/policy.engine.js";
import { findProhibitedClaims, getCurrentPolicy, isSuppressed, startOfUtcDay } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { hashPayload } from "../utils/hash.util.js";

type Id = mongoose.Types.ObjectId;

const APPROVAL_TTL_MS = 7 * 24 * 3600_000;

export interface OutboundRequest {
    organizationId: Id;
    lead: {
        _id: Id;
        contact?: { email?: string | null } | null;
        qualification?: { status?: string | null } | null;
        consent?: { basis?: string | null } | null;
    };
    conversationId: Id;
    kind: "outreach" | "follow_up" | "reply";
    subject: string;
    body: string;
    idempotencyKey: string;
    workflowId?: Id;
    correlationId?: string;
    actor: { type: "agent" | "user"; id: string };
    // an agent can escalate on its own (e.g. pricing question) even when policy would allow
    forceApprovalReason?: string;
}

export interface OutboundResult {
    status: "queued" | "pending_approval" | "rejected";
    messageId: Id;
    approvalId?: Id;
    reasons: string[];
}

// the canonical payload an approval is bound to
export const messagePayload = (m: { to?: string | null; subject?: string | null; body: string }) => ({
    to: m.to ?? "", subject: m.subject ?? "", body: m.body,
});

/*
    The single gate every agent- or user-initiated outbound message passes through:
    reason (agent) -> authorize (policy engine) -> execute (outbox dispatcher).
    Idempotent per idempotencyKey, so retries and graph re-runs never double-send.
*/
export async function proposeOutbound(req: OutboundRequest): Promise<OutboundResult> {

    const { organizationId } = req;

    // idempotency: the same logical send returns the original outcome
    const existing = await Message.findOne({ organizationId, idempotencyKey: req.idempotencyKey }).lean();
    if (existing) {
        return {
            status: existing.status === "pending_approval" ? "pending_approval" : existing.status === "rejected" ? "rejected" : "queued",
            messageId: existing._id,
            approvalId: existing.approvalId ?? undefined,
            reasons: [],
        };
    }

    const to = req.lead.contact?.email ?? "";
    const { config, version } = await getCurrentPolicy(organizationId);
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    const prohibitedHits = findProhibitedClaims(`${req.subject}\n${req.body}`, profile?.prohibitedClaims ?? []);
    const suppressed = await isSuppressed(organizationId, to);

    let result: PolicyResult;
    if (!to) {
        result = { decision: "deny", reasons: ["Lead has no contact email"] };
    } else if (req.kind === "reply") {
        result = evaluate({ type: "reply.send", recipientSuppressed: suppressed, containsProhibitedClaim: prohibitedHits.length > 0 }, config);
    } else {
        const conversation = await Conversation.findOne({ organizationId, _id: req.conversationId }).lean();
        const newContactsToday = await Message.countDocuments({
            organizationId, direction: "outbound", kind: "outreach",
            status: { $in: ["queued", "sending", "sent", "uncertain"] }, createdAt: { $gte: startOfUtcDay() },
        });
        result = evaluate({
            type: "outreach.send",
            channel: "email",
            isFollowUp: req.kind === "follow_up",
            followUpsSent: conversation?.followUpsSent ?? 0,
            lastOutboundAt: conversation?.lastOutboundAt ?? null,
            leadQualified: req.lead.qualification?.status === "qualified",
            hasConsentBasis: Boolean(req.lead.consent?.basis && req.lead.consent.basis !== "none"),
            recipientSuppressed: suppressed,
            newContactsToday,
            containsProhibitedClaim: prohibitedHits.length > 0,
        }, config);
    }
    if (prohibitedHits.length) result.reasons.push(`Prohibited phrases: ${prohibitedHits.join(", ")}`);
    if (req.forceApprovalReason && result.decision === "allow") result = { decision: "needs_approval", reasons: [req.forceApprovalReason] };

    const status = result.decision === "allow" ? "queued" : result.decision === "needs_approval" ? "pending_approval" : "rejected";

    const message = await Message.create({
        organizationId, conversationId: req.conversationId, leadId: req.lead._id,
        direction: "outbound", kind: req.kind, to, subject: req.subject, body: req.body,
        status, idempotencyKey: req.idempotencyKey,
        error: status === "rejected" ? result.reasons.join("; ") : undefined,
    });

    let approvalId: Id | undefined;
    if (status === "pending_approval") {
        const payload = messagePayload(message);
        const approval = await Approval.create({
            organizationId, actionType: req.kind === "reply" ? "reply.send" : "outreach.send",
            targetType: "message", targetId: message._id, leadId: req.lead._id, workflowId: req.workflowId,
            payload, payloadHash: hashPayload(payload), policyVersion: version, reasons: result.reasons,
            requestedBy: req.actor.type === "agent" ? `agent:${req.actor.id}` : `user:${req.actor.id}`,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        });
        approvalId = approval._id;
        await Message.updateOne({ organizationId, _id: message._id }, { approvalId });
    }

    await audit({
        organizationId, actorType: req.actor.type, actorId: req.actor.id,
        action: req.kind === "reply" ? "reply.send" : "outreach.send",
        targetType: "message", targetId: message._id.toString(),
        decision: result.decision, outcome: status === "queued" ? "success" : status === "rejected" ? "denied" : "pending",
        policyVersion: version, correlationId: req.correlationId,
        metadata: { reasons: result.reasons, to },
    });

    return { status, messageId: message._id, approvalId, reasons: result.reasons };

}
