// Importing modules
import { emitSalesEvent } from "../../shared/sales/sales.service.js";
import { offerableSlots } from "../../shared/integrations/calendar.service.js";
import { recordStage } from "../../shared/analytics/analytics.service.js";
import mongoose from "mongoose";
import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import Lead from "../../shared/models/lead.model.js";
import Message from "../../shared/models/message.model.js";
import Conversation from "../../shared/models/conversation.model.js";
import { getCurrentPolicy, suppressEmail } from "../../shared/policy/policy.service.js";
import { cancelPendingOutbound } from "../../shared/conversations/followups.service.js";
import { addBusinessDays } from "../../shared/conversations/schedule.js";
import { alert } from "../../shared/alerts/alert.service.js";
import { proposeOutbound } from "../../shared/outbound/outbound.service.js";
import { audit } from "../../shared/audit/audit.service.js";
import { handleInbound, isAutoReply, isOptOut } from "../conversation.agent.js";
import { getCheckpointer, loadProfile, markStep } from "./common.js";

export const ConversationReplyState = Annotation.Root({
    organizationId: Annotation<string>,
    conversationId: Annotation<string>,
    inboundMessageId: Annotation<string>,
    workflowId: Annotation<string>,
    correlationId: Annotation<string>,
    autoSubmitted: Annotation<boolean | undefined>,
    intent: Annotation<string | undefined>,
    outcome: Annotation<string>,
    reply: Annotation<string | undefined>,
    needsHuman: Annotation<boolean | undefined>,
    messageId: Annotation<string | undefined>,
    approvalId: Annotation<string | undefined>,
    sendStatus: Annotation<string | undefined>,
});

type S = typeof ConversationReplyState.State;

// stop all contact: suppression is written immediately and is never undone by an agent
async function stopContact(s: S, conversationId: mongoose.Types.ObjectId, leadId: mongoose.Types.ObjectId, email: string | undefined | null, reason: "opt_out" | "complaint", source: string) {
    if (email) await suppressEmail(s.organizationId, email, reason, source);
    await Conversation.updateOne({ organizationId: s.organizationId, _id: conversationId }, { status: "suppressed", conversationState: "closed", $unset: { nextActionAt: 1 } });
    await Lead.updateOne({ organizationId: s.organizationId, _id: leadId }, { outreachStatus: "opted_out" });
    // anything still waiting to go out to this person is cancelled, on every thread
    await cancelPendingOutbound(s.organizationId, { leadId }, reason === "complaint" ? "Recipient complained" : "Recipient opted out", ["outreach", "follow_up", "reply", "proposal"]);
    if (reason === "complaint") await alert(s.organizationId, "complaint", "A prospect complained about being contacted; all outreach to them has stopped.", { leadId: String(leadId) });
    await audit({
        organizationId: s.organizationId, actorType: "agent", actorId: "conversation", action: "suppression.add",
        targetType: "lead", targetId: leadId.toString(), outcome: "success", correlationId: s.correlationId, metadata: { source, reason },
    });
}

// 1. Classify the reply, update the CRM, decide the next permitted action
async function classifyInbound(s: S) {
    await markStep(s.organizationId, s.workflowId, "classify_reply");
    const conversation = await Conversation.findOne({ organizationId: s.organizationId, _id: s.conversationId });
    if (!conversation) throw new Error("Conversation no longer exists");
    const lead = await Lead.findOne({ organizationId: s.organizationId, _id: conversation.leadId });
    if (!lead) throw new Error("Lead no longer exists");
    const inbound = await Message.findOne({ organizationId: s.organizationId, _id: s.inboundMessageId });
    if (!inbound) throw new Error("Inbound message missing");

    // explicit opt-outs never wait for (or reach) the model
    if (isOptOut(inbound.body)) {
        inbound.intent = "opt_out";
        await inbound.save();
        await stopContact(s, conversation._id, lead._id, lead.contact?.email, "opt_out", "keyword");
        return { outcome: "opted_out" };
    }
    // auto-replies are recorded but never answered: pause the sequence instead
    if (s.autoSubmitted || isAutoReply(inbound.subject)) {
        inbound.intent = "out_of_office";
        await inbound.save();
        await Conversation.updateOne({ organizationId: s.organizationId, _id: conversation._id, status: { $ne: "suppressed" } }, { status: "waiting", lastIntent: "out_of_office", nextActionAt: addBusinessDays(new Date(), 3) });
        return { outcome: "auto_reply_paused" };
    }

    const thread = await Message.find({ organizationId: s.organizationId, conversationId: conversation._id, status: { $in: ["sent", "delivered", "received"] } })
        .sort({ createdAt: -1 }).limit(20).lean();
    const profile = await loadProfile(s.organizationId);
    const { config } = await getCurrentPolicy(s.organizationId);
    const result = await handleInbound(
        { organizationId: s.organizationId, workflowId: s.workflowId, correlationId: s.correlationId },
        lead, thread.reverse(), profile, config.pricing.currency,
        // real free slots from the connected calendar (null when none): the agent never invents times
        await offerableSlots(s.organizationId),
    );

    inbound.intent = result.intent;
    inbound.set("classification", { confidence: result.confidence, requiresHuman: result.needsHuman, recommendedAction: result.recommendedAction });
    await inbound.save();
    conversation.summary = result.summary;
    conversation.lastIntent = result.intent;

    if (result.intent === "opt_out" || result.intent === "complaint") {
        await conversation.save();
        await stopContact(s, conversation._id, lead._id, lead.contact?.email, result.intent, "classifier");
        return { outcome: result.intent === "complaint" ? "complaint_suppressed" : "opted_out" };
    }

    // structured memory: facts extracted from the prospect's own words
    const facts = (field: string) => result.extractedFacts.filter((f) => f.field === field).map((f) => f.value);
    const needs = new Set([...(lead.requirements?.needs ?? []), ...facts("need")]);
    lead.set("requirements", {
        needs: [...needs].slice(0, 20),
        budget: facts("budget")[0] || lead.requirements?.budget,
        timeline: facts("timeline")[0] || lead.requirements?.timeline,
    });
    lead.outreachStatus = "replied";
    if (["interested", "meeting_request", "pricing_question", "objection"].includes(result.intent)) {
        if (["new", "qualified"].includes(lead.opportunityStage)) lead.opportunityStage = "discovery";
        await recordStage(s.organizationId, lead._id, "positive_reply", { intent: result.intent });
        // the business's bar for an opportunity: genuine interest from an ICP-qualified lead
        if (lead.status === "qualified" && result.intent !== "objection") await recordStage(s.organizationId, lead._id, "qualified_opportunity", { via: result.intent });
        conversation.conversationState = result.intent === "meeting_request" ? "meeting_pending" : "engaged";
    }

    let reply: string | undefined = result.reply || undefined;
    if (result.intent === "not_interested") {
        lead.outreachStatus = "closed";
        conversation.status = "closed";
        conversation.conversationState = "closed";
        reply = undefined;
    } else if (result.intent === "out_of_office") {
        const back = Date.parse(result.returnDate);
        conversation.status = "waiting";
        conversation.nextActionAt = Number.isNaN(back) || back < Date.now() ? addBusinessDays(new Date(), 5) : addBusinessDays(new Date(back), 1);
        reply = undefined;
    } else if (result.needsHuman && !reply) {
        // nothing safe to say automatically: a human picks it up from the review queue
        conversation.status = "needs_review";
    }
    await lead.save();
    await conversation.save();

    return { outcome: result.intent, reply, needsHuman: result.needsHuman, intent: result.intent };
}

// every processed reply (or opt-out) lets the next-best-action engine re-evaluate, once per message
async function classify(s: S) {
    const out = await classifyInbound(s);
    const conv = await Conversation.findOne({ organizationId: s.organizationId, _id: s.conversationId }, { leadId: 1 }).lean();
    if (conv) await emitSalesEvent(s.organizationId, conv.leadId, out.outcome === "opted_out" ? "conversation.opted_out" : "conversation.reply_received", s.inboundMessageId);
    return out;
}

// 2. Send the reply through the policy gate
async function respond(s: S) {
    await markStep(s.organizationId, s.workflowId, "policy_check");
    const conversation = await Conversation.findOne({ organizationId: s.organizationId, _id: s.conversationId });
    const lead = conversation && await Lead.findOne({ organizationId: s.organizationId, _id: conversation.leadId });
    if (!conversation || !lead) throw new Error("Conversation no longer exists");

    // thread the reply under the prospect's message
    const inbound = await Message.findOne({ organizationId: s.organizationId, _id: s.inboundMessageId }, { providerMessageId: 1 }).lean();
    const result = await proposeOutbound({
        organizationId: lead.organizationId, lead, conversationId: conversation._id, kind: "reply",
        subject: conversation.subject ? `Re: ${conversation.subject.replace(/^re:\s*/i, "")}` : "Re: our conversation",
        body: s.reply ?? "", idempotencyKey: `wf:${s.workflowId}:reply`,
        workflowId: new mongoose.Types.ObjectId(s.workflowId), correlationId: s.correlationId,
        actor: { type: "agent", id: "conversation" },
        forceApprovalReason: s.needsHuman ? `Needs a human: ${s.intent === "pricing_question" ? "pricing question" : s.intent === "unclear" ? "unclear intent" : "low confidence or escalation"}` : undefined,
        inReplyTo: inbound?.providerMessageId ?? undefined,
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
