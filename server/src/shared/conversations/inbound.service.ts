// Importing modules
import mongoose from "mongoose";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { audit } from "../audit/audit.service.js";
import NotFound from "../errors/NotFound.error.js";

type Id = mongoose.Types.ObjectId;

/*
    Records an inbound email exactly once (eventKey dedupes provider redelivery) and
    starts the reply workflow for it.
*/
export async function recordInbound(
    organizationId: Id, conversationId: Id,
    email: { from?: string; subject?: string; body: string; eventKey: string },
    actor: { type: "user" | "system"; id: string },
) {
    const conversation = await Conversation.findOne({ organizationId, _id: conversationId });
    if (!conversation) throw new NotFound("Conversation not found");

    const idempotencyKey = `inbound:${email.eventKey}`;
    let message = await Message.findOne({ organizationId, idempotencyKey });
    const duplicate = Boolean(message);
    if (!message) {
        message = await Message.create({
            organizationId, conversationId, leadId: conversation.leadId, direction: "inbound", kind: "inbound",
            from: email.from, subject: email.subject, body: email.body, status: "received", idempotencyKey,
        });
        const now = new Date();
        // a reply re-opens the thread (and stops follow-ups), unless the contact is suppressed
        await Conversation.updateOne(
            { organizationId, _id: conversationId, status: { $ne: "suppressed" } },
            { lastMessageAt: now, status: "open" },
        );
        await audit({
            organizationId, actorType: actor.type, actorId: actor.id, action: "message.received",
            targetType: "message", targetId: message._id.toString(), outcome: "success",
        });
    }

    const { workflow } = await startWorkflow({
        organizationId, type: "conversation.reply", entityType: "conversation", entityId: conversationId,
        input: { inboundMessageId: message._id.toString() }, idempotencyKey: `reply:${message._id}`,
        actor: { type: actor.type === "user" ? "user" : "system", id: actor.id },
    });
    return { message, workflowId: workflow._id, duplicate };
}
