// Importing modules
import mongoose from "mongoose";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import Lead from "../../shared/models/lead.model.js";
import Message from "../../shared/models/message.model.js";
import Conversation from "../../shared/models/conversation.model.js";
import Suppression from "../../shared/models/suppression.model.js";
import { normalizeEmail } from "../../shared/policy/policy.service.js";
import { proposeOutbound } from "../../shared/outbound/outbound.service.js";
import { audit } from "../../shared/audit/audit.service.js";
import { handleInbound, isOptOut } from "../conversation.agent.js";
import { getCheckpointer, loadProfile, markStep } from "./common.js";

export const ConversationReplyState = Annotation.Root({
    organizationId: Annotation<string>,
    conversationId: Annotation<string>,
    inboundMessageId: Annotation<string>,
    workflowId: Annotation<string>,
    correlationId: Annotation<string>,
    outcome: Annotation<string>,
    reply: Annotation<string | undefined>,
    needsHuman: Annotation<boolean | undefined>,
    messageId: Annotation<string | undefined>,
    approvalId: Annotation<string | undefined>,
    sendStatus: Annotation<string | undefined>,
});

type S = typeof ConversationReplyState.State;

// suppression is written immediately and is never undone by an agent
async function optOut(s: S, conversationId: mongoose.Types.ObjectId, leadId: mongoose.Types.ObjectId, email: string | undefined | null, source: string) {
    if (email) {
        await Suppression.updateOne(
            { organizationId: s.organizationId, channel: "email", value: normalizeEmail(email) },
            { $setOnInsert: { organizationId: s.organizationId, channel: "email", value: normalizeEmail(email), reason: "opt_out", source } },
            { upsert: true },
        );
    }
    await Conversation.updateOne({ organizationId: s.organizationId, _id: conversationId }, { status: "suppressed" });
    await Lead.updateOne({ organizationId: s.organizationId, _id: leadId }, { outreachStatus: "opted_out" });
    // anything still waiting to go out to this person is cancelled
    await Message.updateMany(
        { organizationId: s.organizationId, leadId, direction: "outbound", status: { $in: ["queued", "pending_approval"] } },
        { status: "rejected", error: "Recipient opted out" },
    );
    await audit({
        organizationId: s.organizationId, actorType: "agent", actorId: "conversation", action: "suppression.add",
        targetType: "lead", targetId: leadId.toString(), outcome: "success", correlationId: s.correlationId, metadata: { source },
    });
}

// 1. Classify the reply, update the CRM, draft an answer
async function classify(s: S) {
    await markStep(s.organizationId, s.workflowId, "classify_reply");
    const conversation = await Conversation.findOne({ organizationId: s.organizationId, _id: s.conversationId });
    if (!conversation) throw new Error("Conversation no longer exists");
    const lead = await Lead.findOne({ organizationId: s.organizationId, _id: conversation.leadId });
    if (!lead) throw new Error("Lead no longer exists");
    const inbound = await Message.findOne({ organizationId: s.organizationId, _id: s.inboundMessageId });
    if (!inbound) throw new Error("Inbound message missing");

    // explicit opt-outs never reach the model
    if (isOptOut(inbound.body)) {
        inbound.intent = "opt_out";
        await inbound.save();
        await optOut(s, conversation._id, lead._id, lead.contact?.email, "keyword");
        return { outcome: "opted_out" };
    }

    const thread = await Message.find({ organizationId: s.organizationId, conversationId: conversation._id, status: { $in: ["sent", "received"] } })
        .sort({ createdAt: -1 }).limit(20).lean();
    const profile = await loadProfile(s.organizationId);
    const result = await handleInbound(
        { organizationId: s.organizationId, workflowId: s.workflowId, correlationId: s.correlationId },
        lead, thread.reverse(), profile,
    );

    inbound.intent = result.intent;
    await inbound.save();
    conversation.summary = result.summary;
    conversation.lastIntent = result.intent;

    if (result.intent === "opt_out") {
        await conversation.save();
        await optOut(s, conversation._id, lead._id, lead.contact?.email, "classifier");
        return { outcome: "opted_out" };
    }

    // merging extracted requirements into the lead (structured memory, not transcript guessing)
    const needs = new Set([...(lead.requirements?.needs ?? []), ...result.requirements.needs]);
    lead.set("requirements", {
        needs: [...needs].slice(0, 20),
        budget: result.requirements.budget || lead.requirements?.budget,
        timeline: result.requirements.timeline || lead.requirements?.timeline,
    });
    lead.outreachStatus = "replied";
    if (["interested", "question", "meeting_request"].includes(result.intent) && ["new", "qualified"].includes(lead.opportunityStage)) {
        lead.opportunityStage = "discovery";
    }
    if (result.intent === "not_interested") {
        lead.outreachStatus = "closed";
        conversation.status = "closed";
    }
    await lead.save();
    await conversation.save();

    return { outcome: result.intent, reply: result.reply || undefined, needsHuman: result.needsHuman };
}

// 2. Send the reply through the policy gate
async function respond(s: S) {
    await markStep(s.organizationId, s.workflowId, "policy_check");
    const conversation = await Conversation.findOne({ organizationId: s.organizationId, _id: s.conversationId });
    const lead = conversation && await Lead.findOne({ organizationId: s.organizationId, _id: conversation.leadId });
    if (!conversation || !lead) throw new Error("Conversation no longer exists");

    const result = await proposeOutbound({
        organizationId: lead.organizationId, lead, conversationId: conversation._id, kind: "reply",
        subject: conversation.subject ? `Re: ${conversation.subject.replace(/^re:\s*/i, "")}` : "Re: our conversation",
        body: s.reply ?? "", idempotencyKey: `wf:${s.workflowId}:reply`,
        workflowId: new mongoose.Types.ObjectId(s.workflowId), correlationId: s.correlationId,
        actor: { type: "agent", id: "conversation" },
        forceApprovalReason: s.needsHuman ? "Prospect asked about something that needs a human (pricing, terms or unapproved facts)" : undefined,
    });
    return { messageId: result.messageId.toString(), approvalId: result.approvalId?.toString(), sendStatus: result.status };
}

// 3. Durable pause for human approval
async function awaitApproval(s: S) {
    await markStep(s.organizationId, s.workflowId, "awaiting_approval");
    const decision = interrupt({ approvalId: s.approvalId, messageId: s.messageId }) as { decision: "approved" | "rejected" };
    return { outcome: decision.decision === "approved" ? "reply_approved" : "reply_rejected" };
}

export async function buildConversationReply() {
    return new StateGraph(ConversationReplyState)
        .addNode("classify", classify)
        .addNode("respond", respond)
        .addNode("await_approval", awaitApproval)
        .addEdge(START, "classify")
        .addConditionalEdges("classify", (s: S) => (s.reply ? "respond" : END), ["respond", END])
        .addConditionalEdges("respond", (s: S) => (s.sendStatus === "pending_approval" ? "await_approval" : END), ["await_approval", END])
        .addEdge("await_approval", END)
        .compile({ checkpointer: await getCheckpointer() });
}
