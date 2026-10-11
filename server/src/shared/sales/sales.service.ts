// Importing modules
import mongoose from "mongoose";
import { z } from "zod";
import Lead from "../models/lead.model.js";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
import Workflow from "../models/workflow.model.js";
import Approval from "../models/approval.model.js";
import Proposal from "../models/proposal.model.js";
import Prototype from "../models/prototype.model.js";
import SalesDecision from "../models/salesDecision.model.js";
import { IntegrationConnection, Meeting } from "../models/integration.model.js";
import { getCurrentPolicy, isSuppressed } from "../policy/policy.service.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { proposeOutbound } from "../outbound/outbound.service.js";
import { cancelPendingOutbound } from "../conversations/followups.service.js";
import { latestRequirements, openQuestionsOf } from "../requirements/requirements.service.js";
import { requestPrototype } from "../prototypes/prototype.service.js";
import { reviseProposal } from "../proposals/proposal.service.js";
import { offerableSlots } from "../integrations/calendar.service.js";
import { APP_VERSION, recordStage } from "../analytics/analytics.service.js";
import { hashPayload } from "../utils/hash.util.js";
import { audit } from "../audit/audit.service.js";
import logger from "../config/logger.config.js";
import { runAgent } from "../../agents/runAgent.js";
import { draftOutreach } from "../../agents/outreach.agent.js";
import { UNTRUSTED_RULES, untrusted } from "../../agents/prompts.js";
import { ensureConversation, loadProfile } from "../../agents/graphs/common.js";
import type { Requirements } from "../../agents/requirements.agent.js";
import { authorize, candidates, Candidate, canTransition, Facts, fingerprint, SALES_ACTIONS, salesState } from "./engine.js";
import Conflict from "../errors/Conflict.error.js";
import NotFound from "../errors/NotFound.error.js";

type Id = mongoose.Types.ObjectId;
const oid = (v: Id | string) => new mongoose.Types.ObjectId(String(v));

/* ------------------------------- facts ------------------------------- */

// everything the decision needs, read fresh from records (never from an earlier decision)
export async function loadFacts(organizationId: Id, leadId: Id): Promise<Facts> {
    const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const [conversation, req, proto, proposal, meeting, calendar, pendingApprovals, runningWork, queuedMessages, suppressed, { config }] = await Promise.all([
        Conversation.findOne({ organizationId, leadId }).lean(),
        latestRequirements(organizationId, leadId),
        Prototype.findOne({ organizationId, opportunityId: leadId }).sort({ createdAt: -1 }).lean(),
        Proposal.findOne({ organizationId, leadId }).sort({ version: -1 }).lean(),
        Meeting.exists({ organizationId, leadId, status: { $in: ["booked", "rescheduled"] }, start: { $gt: new Date() } }),
        IntegrationConnection.exists({ organizationId, provider: "google_calendar", status: "connected" }),
        Approval.countDocuments({ organizationId, leadId, status: "pending" }),
        Workflow.countDocuments({ organizationId, entityId: leadId, status: { $in: ["queued", "running"] }, type: { $ne: "sales.evaluate" } }),
        Message.countDocuments({ organizationId, leadId, direction: "outbound", status: { $in: ["queued", "sending"] } }),
        isSuppressed(organizationId, lead.contact?.email),
        getCurrentPolicy(organizationId),
    ]);
    const lastInbound = await Message.findOne({ organizationId, leadId, direction: "inbound" }).sort({ createdAt: -1 }).lean();
    const lastOutbound = await Message.findOne({ organizationId, leadId, direction: "outbound", status: { $in: ["sent", "delivered"] } }).sort({ sentAt: -1 }).lean();
    return {
        leadStatus: lead.status, stage: lead.opportunityStage, outreachStatus: lead.outreachStatus, consentBasis: lead.consent?.basis ?? null,
        hasEmail: Boolean(lead.contact?.email), researched: lead.research?.status === "done", isTest: Boolean(lead.isTest),
        paused: Boolean(lead.automation?.paused), suppressed, conversationStatus: conversation?.status ?? null,
        lastIntent: lastInbound?.intent ?? null, lastInboundId: lastInbound ? String(lastInbound._id) : null,
        lastInboundText: lastInbound?.body?.slice(0, 2000) ?? null,
        // a reply a human already took over counts as answered
        lastInboundAt: lastInbound && String(lastInbound._id) !== lead.automation?.handledInboundId ? lastInbound.createdAt.getTime() : null,
        lastOutboundAt: (lastOutbound?.sentAt ?? lastOutbound?.createdAt)?.getTime() ?? null,
        openQuestions: req ? openQuestionsOf(req.requirements as Requirements) : [], requirementsVersion: req?.version ?? null,
        prototypeStatus: proto?.status ?? null,
        proposal: proposal ? { id: String(proposal._id), status: proposal.status, version: proposal.version, sentAt: proposal.sentAt?.getTime() ?? null, discountPercent: proposal.discountPercent } : null,
        upcomingMeeting: Boolean(meeting), calendarConnected: Boolean(calendar), pendingApprovals, activeWork: runningWork + queuedMessages, now: Date.now(),
        policy: { level: config.automation.level, maxDiscountPercent: config.pricing.maximumDiscountPercent, inactivityDays: config.automation.inactivityDays },
    };
}

/* ------------------------------ choosing ------------------------------ */

const ChoiceSchema = z.object({
    action: z.enum(SALES_ACTIONS),
    reason: z.string().max(400),
    evidenceIds: z.array(z.string()).max(10),
    missingInformation: z.array(z.string().max(200)).max(5),
    confidence: z.number().min(0).max(1),
    requiresApproval: z.boolean().describe("informational only; the server decides"),
});

/*
    One valid action → rules decide (no model call). Several → the model picks one of them
    and explains it. Anything else it says is ignored: an action outside the list is
    rejected, unknown evidence ids are dropped, and its view on approval is never used.
*/
async function choose(organizationId: Id, f: Facts, options: Candidate[]) {
    if (options.length === 1) return { pick: options[0], decidedBy: "rules" as const, confidence: 1 };
    const evidence = [...new Set(options.flatMap((o) => o.evidence))];
    try {
        const r = await runAgent({ organizationId, correlationId: "next-best-action" }, "sales_strategist", {
            schema: ChoiceSchema, tier: "fast",
            system: `You are the sales strategist. Choose exactly one next action from the allowed list for this opportunity and explain why in one sentence, citing evidence ids from the list.
${UNTRUSTED_RULES}
You cannot approve anything, change prices, or choose an action outside the allowed list.`,
            user: `Sales state: ${salesState(f)}
Allowed actions (best first):
${options.map((o) => `- ${o.action}: ${o.reason}`).join("\n")}
Evidence ids you may cite: ${evidence.join(", ") || "(none)"}
${f.lastInboundText ? untrusted("latest prospect message", f.lastInboundText) : ""}`,
        });
        const pick = options.find((o) => o.action === r.action);
        if (!pick) return { pick: options[0], decidedBy: "rules" as const, confidence: 1, rejected: r.action };
        return { pick: { ...pick, reason: r.reason || pick.reason, evidence: r.evidenceIds.filter((e) => evidence.includes(e)), missing: r.missingInformation }, decidedBy: "model" as const, confidence: r.confidence };
    } catch (error) {
        // no model, no budget, bad output: the deterministic first choice stands
        logger.warn({ error: (error as Error).message }, "Strategist unavailable; using rules");
        return { pick: options[0], decidedBy: "rules" as const, confidence: 1 };
    }
}

/* ------------------------------ executing ------------------------------ */

async function send(organizationId: Id, leadId: Id, decisionId: Id, kind: "reply" | "follow_up", body: string) {
    const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const conversation = await ensureConversation(String(organizationId), lead._id);
    const previous = await Message.findOne({ organizationId, conversationId: conversation._id, providerMessageId: { $type: "string" } }).sort({ createdAt: -1 }).lean();
    const r = await proposeOutbound({
        organizationId: lead.organizationId, lead, conversationId: conversation._id, kind, subject: `Re: ${(conversation.subject ?? "our conversation").replace(/^re:\s*/i, "")}`,
        body, idempotencyKey: `nba:${decisionId}`, actor: { type: "agent", id: "sales_engine" },
        inReplyTo: previous?.providerMessageId ?? undefined, references: previous?.providerMessageId ? [previous.providerMessageId] : undefined,
    });
    return `message ${r.status}`;
}

// runs a decided action through the existing, policy-checked machinery
async function execute(organizationId: Id, decision: InstanceType<typeof SalesDecision>) {
    const leadId = decision.leadId;
    const key = `nba:${decision._id}`;
    const p = decision.params ?? {};
    switch (decision.action) {
        case "research":
            await startWorkflow({ organizationId, type: "lead.research", entityType: "lead", entityId: leadId, idempotencyKey: key, actor: { type: "agent", id: "sales_engine" } });
            return "research queued";
        case "send_reply":
            await startWorkflow({ organizationId, type: "lead.pipeline", entityType: "lead", entityId: leadId, idempotencyKey: key, actor: { type: "agent", id: "sales_engine" } });
            return "first outreach drafted through policy";
        case "follow_up": {
            const lead = (await Lead.findOne({ organizationId, _id: leadId }))!;
            const conv = await Conversation.findOne({ organizationId, leadId }).lean();
            const email = await draftOutreach({ organizationId, correlationId: key }, lead, lead.research ?? {}, await loadProfile(String(organizationId)), { followUpNumber: (conv?.followUpsSent ?? 0) + 1, previousSubject: conv?.subject ?? undefined });
            return send(organizationId, leadId, decision._id, "follow_up", email.body);
        }
        case "ask_question": {
            const qs = (p.questions as string[] | undefined) ?? [];
            return send(organizationId, leadId, decision._id, "reply", `Thanks for the details. A few quick questions so we scope this correctly:\n\n${qs.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
        }
        case "schedule_meeting": {
            const profile = await loadProfile(String(organizationId)) as { meetingLink?: string };
            const slots = await offerableSlots(organizationId);
            const body = slots?.length ? `Happy to talk. These times are free on our side:\n\n${slots.map((s) => `- ${s}`).join("\n")}\n\nWhich suits you?`
                : profile.meetingLink ? `Happy to talk. Pick any time that suits you here: ${profile.meetingLink}`
                    : "Happy to talk. Which days and times work best for you this week?";
            return send(organizationId, leadId, decision._id, "reply", body);
        }
        case "build_prototype": {
            const r = await requestPrototype(organizationId, leadId, { idempotencyKey: key, userId: "sales_engine" });
            return r.prototype ? `demo ${r.decision === "allow" ? "building" : "awaiting approval"}` : `demo not eligible: ${r.reasons.join("; ")}`;
        }
        case "prepare_proposal":
            if (p.reviseProposalId) {
                // the price is computed by the pricing engine; the revision still needs sending approval
                await reviseProposal(organizationId, String(p.reviseProposalId), { discountPercent: Number(p.discountPercent), note: `Discount of ${p.discountPercent}% requested by the prospect` }, "sales_engine");
                return "proposal revision drafted";
            }
            return "ready for a proposal: prepare it in the opportunity workspace";
        case "escalate":
            await setPaused(organizationId, leadId, true, "sales_engine", decision.reason);
            await Conversation.updateOne({ organizationId, leadId, status: { $in: ["open", "waiting"] } }, { status: "needs_review" });
            return "handed to a human; automation paused";
        case "close_lost": {
            const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
            if (!lead || !canTransition(lead.opportunityStage, "lost", "agent")) return "transition not allowed";
            await Lead.updateOne({ organizationId, _id: leadId }, { opportunityStage: "lost", outreachStatus: "closed" });
            await cancelPendingOutbound(organizationId, { leadId }, "Opportunity closed as lost", ["outreach", "follow_up", "reply", "proposal"]);
            await recordStage(organizationId, leadId, "lost", { via: "sales_engine", evidence: decision.evidenceIds });
            return "closed as lost; pending messages cancelled";
        }
        default: {
            if (decision.nextEvaluationAt) {
                const at = decision.nextEvaluationAt;
                const { workflow, created } = await startWorkflow({ organizationId, type: "sales.evaluate", entityType: "lead", entityId: leadId, input: { trigger: "timer" }, idempotencyKey: `nba:${leadId}:timer:${at.toISOString().slice(0, 13)}`, actor: { type: "system", id: "sales_engine" } });
                if (created) await Workflow.updateOne({ organizationId, _id: workflow._id }, { nextRunAt: at });
            }
            return "waiting";
        }
    }
}

/*
    Evaluate → decide → authorize (server-side only) → execute or ask a human. Keyed by the
    triggering event: the same event never yields a second decision or action.
*/
export async function evaluate(organizationId: Id, leadId: Id, trigger: string, eventKey: string) {
    const idempotencyKey = `${trigger}:${eventKey}`;
    const existing = await SalesDecision.findOne({ organizationId, leadId, idempotencyKey }).lean();
    if (existing) return existing;
    const f = await loadFacts(organizationId, leadId);
    const options = candidates(f);
    const { pick, decidedBy, confidence, rejected } = await choose(organizationId, f, options) as Awaited<ReturnType<typeof choose>> & { rejected?: string };
    const auth = authorize(pick.action, f);
    let decision;
    try {
        decision = await SalesDecision.create({
            organizationId, leadId, trigger, idempotencyKey, state: salesState(f), action: pick.action, reason: pick.reason, evidenceIds: pick.evidence,
            missingInformation: pick.missing ?? [], confidence, decidedBy, rejectedSuggestion: rejected, candidates: options.map((o) => o.action), params: pick.params ?? {},
            policyDecision: auth.decision, policyReason: auth.reason, fingerprint: fingerprint(f), autonomyLevel: f.policy.level, workflowVersion: APP_VERSION,
            nextEvaluationAt: pick.nextEvaluationAt ? new Date(pick.nextEvaluationAt) : undefined,
        });
    } catch (error) {
        if ((error as { code?: number }).code === 11000) return (await SalesDecision.findOne({ organizationId, idempotencyKey }).lean())!;
        throw error;
    }

    if (auth.decision === "blocked") {
        Object.assign(decision, { status: "skipped", outcome: auth.reason, completedAt: new Date() });
    } else if (auth.decision === "approval_required") {
        const payload = { decisionId: String(decision._id), leadId: String(leadId), action: decision.action, params: decision.params, fingerprint: decision.fingerprint };
        const approval = await Approval.create({
            organizationId, actionType: "sales.action", targetType: "decision", targetId: decision._id, leadId,
            payload, payloadHash: hashPayload(payload), policyVersion: 0, reasons: [`${decision.action.replace(/_/g, " ")}: ${decision.reason}`, auth.reason],
            requestedBy: "agent:sales_engine", expiresAt: new Date(Date.now() + 3 * 86400_000),
        });
        decision.approvalId = approval._id;
    } else {
        try {
            decision.outcome = await execute(organizationId, decision);
            Object.assign(decision, { status: decision.action === "wait" || decision.action === "escalate" ? "completed" : "queued", completedAt: new Date() });
        } catch (error) {
            Object.assign(decision, { status: "failed", outcome: (error as Error).message.slice(0, 300) });
        }
    }
    await decision.save();
    await audit({
        organizationId, actorType: "agent", actorId: "sales_engine", action: "sales.decision", targetType: "lead", targetId: String(leadId),
        decision: auth.decision === "allowed" ? "allow" : auth.decision === "blocked" ? "deny" : "needs_approval", outcome: decision.status === "failed" ? "failure" : "success",
        metadata: { trigger, action: decision.action, reason: decision.reason, decidedBy, decisionId: String(decision._id) },
    });
    return decision.toObject();
}

/*
    A human approved a decision. It runs only if the opportunity is still in the state that was
    reviewed and the hard stops still allow it; otherwise the approval is refused as stale.
*/
export async function executeApprovedDecision(organizationId: Id, decisionId: Id) {
    const decision = await SalesDecision.findOne({ organizationId, _id: decisionId, status: "proposed" });
    if (!decision) throw new Conflict("This action was already handled");
    const f = await loadFacts(organizationId, decision.leadId);
    // the decision's own approval is what we are deciding; do not count it as "waiting"
    const now = { ...f, pendingApprovals: 0 };
    if (fingerprint(now) !== decision.fingerprint) {
        Object.assign(decision, { status: "skipped", outcome: "Opportunity changed since review; re-evaluate", completedAt: new Date() });
        await decision.save();
        throw new Conflict("The opportunity changed since this was reviewed. It was re-queued for a fresh decision.");
    }
    if (authorize(decision.action, now).decision === "blocked") throw new Conflict("This action is no longer allowed (opted out, closed or paused)");
    try {
        decision.outcome = await execute(organizationId, decision);
        Object.assign(decision, { status: "queued", completedAt: new Date() });
    } catch (error) {
        Object.assign(decision, { status: "failed", outcome: (error as Error).message.slice(0, 300) });
    }
    await decision.save();
}

/* ------------------------------ controls ------------------------------ */

export async function setPaused(organizationId: Id, leadId: Id, paused: boolean, actorId: string, reason?: string) {
    const last = paused ? null : await Message.findOne({ organizationId, leadId, direction: "inbound" }, { _id: 1 }).sort({ createdAt: -1 }).lean();
    await Lead.updateOne({ organizationId, _id: leadId }, paused
        ? { automation: { paused: true, pausedAt: new Date(), pausedBy: actorId, reason } }
        : { automation: { paused: false, handledInboundId: last ? String(last._id) : undefined } });
    if (paused) await Approval.updateMany({ organizationId, leadId, actionType: "sales.action", status: "pending" }, { status: "expired" });
    await audit({ organizationId, actorType: actorId === "sales_engine" ? "agent" : "user", actorId, action: paused ? "automation.paused" : "automation.resumed", targetType: "lead", targetId: String(leadId), outcome: "success", metadata: { reason } });
}

/*
    Business events → a durable, idempotent evaluation job (only for workspaces that turned on
    event-driven automation). The event key makes duplicates no-ops.
*/
export async function emitSalesEvent(organizationId: Id | string, leadId: Id | string, type: string, eventKey: string) {
    try {
        const { config } = await getCurrentPolicy(organizationId);
        if (!config.automation.eventDriven) return;
        const lead = await Lead.exists({ organizationId, _id: leadId, isTest: { $ne: true } });
        if (!lead) return;
        await startWorkflow({
            organizationId: oid(organizationId), type: "sales.evaluate", entityType: "lead", entityId: oid(leadId), input: { trigger: type, eventKey },
            idempotencyKey: `nba:${leadId}:${type}:${eventKey}`, actor: { type: "system", id: "events" },
        });
    } catch (error) {
        logger.warn({ type, error: (error as Error).message }, "Sales event not queued");
    }
}

// opportunities with no activity for the workspace's inactivity window get one "inactive" event per week
export async function scanInactivity(now = new Date()) {
    const convs = await Conversation.find({ status: { $in: ["open", "waiting"] } }, { organizationId: 1, leadId: 1, lastInboundAt: 1, lastOutboundAt: 1 })
        .sort({ updatedAt: 1 }).limit(500).setOptions({ crossTenant: true }).lean();
    const week = `${now.getUTCFullYear()}-${Math.floor(now.getTime() / (7 * 86400_000))}`;
    for (const c of convs) {
        const last = Math.max(c.lastInboundAt?.getTime() ?? 0, c.lastOutboundAt?.getTime() ?? 0);
        if (!last) continue;
        const { config } = await getCurrentPolicy(c.organizationId);
        if (config.automation.eventDriven && now.getTime() - last > config.automation.inactivityDays * 86400_000) {
            await emitSalesEvent(c.organizationId, c.leadId, "opportunity.inactive", week);
        }
    }
}
