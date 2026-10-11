// Importing modules
import Organization from "../models/organization.model.js";
import { isEnabled } from "../flags/flags.service.js";
import mongoose from "mongoose";
import Message from "../models/message.model.js";
import Approval from "../models/approval.model.js";
import Conversation from "../models/conversation.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import { evaluate, PolicyResult } from "../policy/policy.engine.js";
import { findProhibitedClaims, getCurrentPolicy, isSuppressed, startOfUtcDay } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { hashPayload } from "../utils/hash.util.js";
import { alert } from "../alerts/alert.service.js";
import Campaign from "../models/campaign.model.js";

type Id = mongoose.Types.ObjectId;

const APPROVAL_TTL_MS = 7 * 24 * 3600_000;

export interface OutboundRequest {
    organizationId: Id;
    lead: {
        _id: Id;
        isTest?: boolean | null;
        contact?: { email?: string | null } | null;
        status?: string | null;
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
    campaignId?: Id;
    // threading headers for replies
    inReplyTo?: string;
    references?: string[];
    // personalisation claims with their evidence check (from the outreach agent)
    claims?: { claim: string; evidenceUrl?: string; verified: boolean }[];
    experimentId?: Id;
    variantId?: string;
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

    // idempotency: the same logical send returns the original outcome (a saved draft is promoted instead)
    const existing = await Message.findOne({ organizationId, idempotencyKey: req.idempotencyKey }).lean();
    if (existing && existing.status !== "draft") {
        return {
            status: existing.status === "pending_approval" ? "pending_approval" : existing.status === "rejected" ? "rejected" : "queued",
            messageId: existing._id,
            approvalId: existing.approvalId ?? undefined,
            reasons: [],
        };
    }

    const to = req.lead.contact?.email ?? "";
    const { config: policy, version } = await getCurrentPolicy(organizationId);
    // a human writing their own message is the approval; every other rule still applies
    const config = req.actor.type === "user" ? { ...policy, outreach: { ...policy.outreach, autoSend: true } } : policy;
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
        const sentStates = { $in: ["queued", "sending", "sent", "delivered", "uncertain"] };
        const [newContactsToday, sentLastHour] = await Promise.all([
            Message.countDocuments({ organizationId, direction: "outbound", kind: "outreach", status: sentStates, createdAt: { $gte: startOfUtcDay() } }),
            Message.countDocuments({ organizationId, direction: "outbound", kind: { $in: ["outreach", "follow_up"] }, status: sentStates, createdAt: { $gte: new Date(Date.now() - 3600_000) } }),
        ]);
        result = evaluate({
            type: "outreach.send",
            channel: "email",
            isFollowUp: req.kind === "follow_up",
            followUpsSent: conversation?.followUpsSent ?? 0,
            lastOutboundAt: conversation?.lastOutboundAt ?? null,
            // the onboarding test lead is the user themself: it rehearses the path without a real prospect
            leadQualified: req.lead.status === "qualified" || Boolean(req.lead.isTest),
            hasConsentBasis: Boolean(req.lead.consent?.basis && req.lead.consent.basis !== "none"),
            recipientSuppressed: suppressed,
            newContactsToday,
            sentLastHour,
            containsProhibitedClaim: prohibitedHits.length > 0,
        }, config);
    }
    // nobody real is contacted before the workspace is activated; the test lead is the user themself
    if (!req.lead.isTest && !(await Organization.exists({ _id: organizationId, activatedAt: { $ne: null } }))) {
        result = { decision: "deny", reasons: ["Workspace is not activated yet: finish onboarding and activate it"] };
    }
    if (result.reasons.some((r) => r.startsWith("Daily new-contact limit"))) {
        await alert(organizationId, "send_cap_reached", "Daily new-contact limit reached; further outreach is denied until tomorrow.");
    }
    if (prohibitedHits.length) result.reasons.push(`Prohibited phrases: ${prohibitedHits.join(", ")}`);
    // escalations never bypass a denial, they only turn an allow into a human review
    const escalations = [
        req.forceApprovalReason,
        req.actor.type === "agent" && !(await isEnabled(organizationId, "auto_send")) ? "Autonomous sending is not enabled for this workspace yet" : undefined,
        req.claims?.some((c) => !c.verified) ? "A personalisation claim is not backed by research evidence" : undefined,
        req.campaignId && req.actor.type === "agent" && !(await Campaign.exists({ organizationId, _id: req.campaignId, autoSend: true })) ? "Campaign requires approval for each message" : undefined,
    ].filter((r): r is string => Boolean(r));
    if (escalations.length && result.decision === "allow") result = { decision: "needs_approval", reasons: escalations };

    const status = result.decision === "allow" ? "queued" : result.decision === "needs_approval" ? "pending_approval" : "rejected";

    const fields = {
        organizationId, conversationId: req.conversationId, leadId: req.lead._id,
        direction: "outbound", kind: req.kind, to, subject: req.subject, body: req.body,
        status, idempotencyKey: req.idempotencyKey, campaignId: req.campaignId,
        inReplyTo: req.inReplyTo, references: req.references, claims: req.claims ?? existing?.claims,
        experimentId: req.experimentId ?? existing?.experimentId, variantId: req.variantId ?? existing?.variantId,
        error: status === "rejected" ? result.reasons.join("; ") : undefined,
    };
    const message = existing
        ? (await Message.findOneAndUpdate({ organizationId, _id: existing._id, status: "draft" }, fields, { new: true }))!
        : await Message.create(fields);

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
