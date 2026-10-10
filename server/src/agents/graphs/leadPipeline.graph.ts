// Importing modules
import mongoose from "mongoose";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import Lead from "../../shared/models/lead.model.js";
import Message from "../../shared/models/message.model.js";
import { getCurrentPolicy } from "../../shared/policy/policy.service.js";
import { proposeOutbound } from "../../shared/outbound/outbound.service.js";
import { researchLead } from "../research.agent.js";
import { qualifyLead } from "../qualification.agent.js";
import { draftOutreach } from "../outreach.agent.js";
import { ensureConversation, getCheckpointer, loadProfile, markStep } from "./common.js";

export const LeadPipelineState = Annotation.Root({
    organizationId: Annotation<string>,
    leadId: Annotation<string>,
    workflowId: Annotation<string>,
    correlationId: Annotation<string>,
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

// 1. Research the company (skipped if already done — nodes are safe to re-run)
async function research(s: S) {
    await markStep(s.organizationId, s.workflowId, "research");
    const lead = await getLead(s);
    if (lead.research?.status === "done") return {};

    lead.set("research.status", "running");
    await lead.save();

    const profile = await loadProfile(s.organizationId);
    try {
        const r = await researchLead(ctxOf(s), { company: lead.company, contact: lead.contact ?? undefined }, profile);
        lead.set("research", { status: "done", summary: r.summary, needs: r.needs, evidence: r.evidence, researchedAt: new Date() });
        if (!lead.company.industry && r.industry) lead.set("company.industry", r.industry);
        if (!lead.company.size && r.size) lead.set("company.size", r.size);
        await lead.save();
    } catch (error) {
        lead.set("research.status", "failed");
        await lead.save();
        throw error;
    }
    return {};
}

// 2. Score against the ICP; deterministic rules decide the status
async function qualify(s: S) {
    await markStep(s.organizationId, s.workflowId, "qualify");
    const lead = await getLead(s);
    const profile = await loadProfile(s.organizationId);
    const { config } = await getCurrentPolicy(s.organizationId);

    const q = await qualifyLead(ctxOf(s), lead, lead.research ?? {}, profile, config.qualification.minimumScore);
    lead.set("qualification", q);
    if (q.status === "qualified") {
        if (lead.opportunityStage === "new") lead.opportunityStage = "qualified";
        if (lead.outreachStatus === "not_started") lead.outreachStatus = "eligible";
    }
    await lead.save();
    return { outcome: q.status };
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
    const email = await draftOutreach(ctxOf(s), lead, lead.research ?? {}, profile);
    const conversation = await ensureConversation(s.organizationId, lead._id);
    if (!conversation.subject) {
        conversation.subject = email.subject;
        await conversation.save();
    }

    await markStep(s.organizationId, s.workflowId, "policy_check");
    const result = await proposeOutbound({
        organizationId: lead.organizationId, lead, conversationId: conversation._id,
        kind: "outreach", subject: email.subject, body: email.body, idempotencyKey,
        workflowId: new mongoose.Types.ObjectId(s.workflowId),
        correlationId: s.correlationId, actor: { type: "agent", id: "outreach" },
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
        .addNode("qualify", qualify)
        .addNode("draft", draft)
        .addNode("await_approval", awaitApproval)
        .addEdge(START, "research")
        .addEdge("research", "qualify")
        .addConditionalEdges("qualify", (s: S) => (s.outcome === "qualified" ? "draft" : END), ["draft", END])
        .addConditionalEdges("draft", (s: S) => (s.sendStatus === "pending_approval" ? "await_approval" : END), ["await_approval", END])
        .addEdge("await_approval", END)
        .compile({ checkpointer: await getCheckpointer() });
}
