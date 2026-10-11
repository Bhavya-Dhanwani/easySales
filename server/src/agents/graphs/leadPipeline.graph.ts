// Importing modules
import { variantFor } from "../../shared/experiments/experiment.service.js";
import mongoose from "mongoose";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import Lead from "../../shared/models/lead.model.js";
import Message from "../../shared/models/message.model.js";
import Workflow from "../../shared/models/workflow.model.js";
import Campaign from "../../shared/models/campaign.model.js";
import { runResearch } from "../../shared/research/research.service.js";
import { proposeOutbound } from "../../shared/outbound/outbound.service.js";
import { draftOutreach } from "../outreach.agent.js";
import { ensureConversation, getCheckpointer, loadProfile, markStep } from "./common.js";

export const LeadPipelineState = Annotation.Root({
    organizationId: Annotation<string>,
    leadId: Annotation<string>,
    workflowId: Annotation<string>,
    correlationId: Annotation<string>,
    campaignId: Annotation<string | undefined>,
    outcome: Annotation<string>,
    messageId: Annotation<string | undefined>,
    approvalId: Annotation<string | undefined>,
    sendStatus: Annotation<string | undefined>,
});

type S = typeof LeadPipelineState.State;

const ctxOf = (s: S) => ({ organizationId: s.organizationId, workflowId: s.workflowId, correlationId: s.correlationId });

async function getLead(s: S) {
    const lead = await Lead.findOne({ organizationId: s.organizationId, _id: s.leadId });
    if (!lead) throw new Error("Lead no longer exists");
    return lead;
}

// 1. Research + deterministic qualification (skipped if this lead already has a report)
async function research(s: S) {
    await markStep(s.organizationId, s.workflowId, "research");
    const lead = await getLead(s);
    if (lead.research?.status !== "done") {
        const wf = await Workflow.findOne({ organizationId: s.organizationId, _id: s.workflowId }, { createdAt: 1 }).lean();
        await runResearch({ organizationId: s.organizationId, leadId: s.leadId, workflowId: s.workflowId, correlationId: s.correlationId, requestedAt: wf?.createdAt ?? new Date() });
    }
    const fresh = await getLead(s);
    // the onboarding rehearsal always goes on to draft (its only recipient is the user)
    return { outcome: fresh.isTest ? "test" : fresh.status };
}

// 3. Draft a first-touch email and pass it through the policy gate
async function draft(s: S) {
    await markStep(s.organizationId, s.workflowId, "draft_outreach");
    const lead = await getLead(s);
    const idempotencyKey = `wf:${s.workflowId}:outreach`;

    // re-run safety: if the message was already proposed, do not call the model again
    const existing = await Message.findOne({ organizationId: s.organizationId, idempotencyKey }).lean();
    if (existing) {
        return { messageId: existing._id.toString(), approvalId: existing.approvalId?.toString(), sendStatus: existing.status };
    }

    const profile = await loadProfile(s.organizationId);
    const campaign = s.campaignId ? await Campaign.findOne({ organizationId: s.organizationId, _id: s.campaignId }).lean() : null;
    if (campaign && campaign.status !== "active") return { sendStatus: "rejected", outcome: "campaign_not_active" };
    const variant = await variantFor(s.organizationId, lead._id, campaign?._id);
    const email = await draftOutreach(ctxOf(s), lead, lead.research ?? {}, profile, { objective: campaign?.objective || undefined, variant: variant ?? undefined });
    const conversation = await ensureConversation(s.organizationId, lead._id);
    if (!conversation.subject) conversation.subject = email.subject;
    if (campaign && !conversation.campaignId) conversation.campaignId = campaign._id;
    await conversation.save();

    await markStep(s.organizationId, s.workflowId, "policy_check");
    const result = await proposeOutbound({
        organizationId: lead.organizationId, lead, conversationId: conversation._id,
        kind: "outreach", subject: email.subject, body: email.body, idempotencyKey,
        workflowId: new mongoose.Types.ObjectId(s.workflowId),
        correlationId: s.correlationId, actor: { type: "agent", id: "outreach" },
        campaignId: campaign?._id, claims: email.claims,
        experimentId: variant?.experimentId, variantId: variant?.variantId,
    });

    return {
        messageId: result.messageId.toString(),
        approvalId: result.approvalId?.toString(),
        sendStatus: result.status,
        outcome: result.status === "queued" ? "outreach_queued" : result.status === "rejected" ? "outreach_blocked" : "awaiting_approval",
    };
}

// 4. Pause durably until a human decides (resumed by the approvals service)
async function awaitApproval(s: S) {
    await markStep(s.organizationId, s.workflowId, "awaiting_approval");
    const decision = interrupt({ approvalId: s.approvalId, messageId: s.messageId }) as { decision: "approved" | "rejected" };
    return { outcome: decision.decision === "approved" ? "outreach_approved" : "outreach_rejected" };
}

export async function buildLeadPipeline() {
    return new StateGraph(LeadPipelineState)
        .addNode("research", research)
        .addNode("draft", draft)
        .addNode("await_approval", awaitApproval)
        .addEdge(START, "research")
        .addConditionalEdges("research", (s: S) => (s.outcome === "qualified" || s.outcome === "test" ? "draft" : END), ["draft", END])
        .addConditionalEdges("draft", (s: S) => (s.sendStatus === "pending_approval" ? "await_approval" : END), ["await_approval", END])
        .addEdge("await_approval", END)
        .compile({ checkpointer: await getCheckpointer() });
}
