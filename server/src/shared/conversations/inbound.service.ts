// Importing modules
import mongoose from "mongoose";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { audit } from "../audit/audit.service.js";
import NotFound from "../errors/NotFound.error.js";
import Lead from "../models/lead.model.js";
import { cancelPendingOutbound } from "./followups.service.js";

type Id = mongoose.Types.ObjectId;

/*
    Records an inbound email exactly once (eventKey dedupes provider redelivery) and
    starts the reply workflow for it.
*/
export async function recordInbound(
    organizationId: Id, conversationId: Id,
    email: { from?: string; subject?: string; body: string; eventKey: string; autoSubmitted?: boolean; providerMessageId?: string },
    actor: { type: "user" | "system"; id: string },
) {
    const conversation = await Conversation.findOne({ organizationId, _id: conversationId });
    if (!conversation) throw new NotFound("Conversation not found");

    const idempotencyKey = `inbound:${email.eventKey}`;
    // the same email can arrive twice under different event ids: its Message-ID dedupes it too
    let message = await Message.findOne({ organizationId, $or: [{ idempotencyKey }, ...(email.providerMessageId ? [{ providerMessageId: email.providerMessageId }] : [])] });
    const duplicate = Boolean(message);
    if (!message) {
        message = await Message.create({
            organizationId, conversationId, leadId: conversation.leadId, direction: "inbound", kind: "inbound",
            from: email.from, subject: email.subject, body: email.body, status: "received", idempotencyKey,
            providerMessageId: email.providerMessageId,
        });
        const now = new Date();
        // any reply stops the automated sequence immediately, before the AI even reads it
        await Conversation.updateOne(
            { organizationId, _id: conversationId, status: { $ne: "suppressed" } },
            { lastMessageAt: now, lastInboundAt: now, status: "open" },
        );
        await cancelPendingOutbound(organizationId, { conversationId }, "Prospect replied", ["follow_up"]);
        await Lead.updateOne({ organizationId, _id: conversation.leadId, outreachStatus: { $in: ["not_started", "eligible", "active"] } }, { outreachStatus: "replied" });
        await audit({
            organizationId, actorType: actor.type, actorId: actor.id, action: "message.received",
            targetType: "message", targetId: message._id.toString(), outcome: "success",
        });
    }

    const { workflow } = await startWorkflow({
        organizationId, type: "conversation.reply", entityType: "conversation", entityId: conversationId,
        input: { inboundMessageId: message._id.toString(), autoSubmitted: Boolean(email.autoSubmitted) }, idempotencyKey: `reply:${message._id}`,
        actor: { type: actor.type === "user" ? "user" : "system", id: actor.id },
    });
    return { message, workflowId: workflow._id, duplicate };
}
