// Importing modules
import { recordStage } from "../analytics/analytics.service.js";
import mongoose from "mongoose";
import ProviderEvent from "../models/providerEvent.model.js";
import Message from "../models/message.model.js";
import Conversation from "../models/conversation.model.js";
import Lead from "../models/lead.model.js";
import { normalizeEmail, suppressEmail } from "../policy/policy.service.js";
import { recordInbound } from "./inbound.service.js";
import { cancelPendingOutbound } from "./followups.service.js";
import { audit } from "../audit/audit.service.js";
import { alert } from "../alerts/alert.service.js";

type Evt = InstanceType<typeof ProviderEvent>;
type Payload = { messageId?: string; from?: string; subject?: string; text?: string; inReplyTo?: string; references?: string[]; autoSubmitted?: boolean; providerMessageId?: string; bounceType?: "hard" | "soft" };

// finds the thread an inbound email belongs to: our Message-ID in its headers first, then the sender address
export async function matchConversation(organizationId: mongoose.Types.ObjectId, p: Payload) {
    const ids = [p.inReplyTo, ...(p.references ?? [])].filter((v): v is string => Boolean(v));
    if (ids.length) {
        const replied = await Message.findOne({ organizationId, providerMessageId: { $in: ids } }, { conversationId: 1 }).lean();
        if (replied) return replied.conversationId;
    }
    if (!p.from) return null;
    const lead = await Lead.findOne({ organizationId, "contact.email": normalizeEmail(p.from) }, { _id: 1 }).lean();
    if (!lead) return null;
    const conv = await Conversation.findOne({ organizationId, leadId: lead._id }, { _id: 1 }).sort({ updatedAt: -1 }).lean();
    return conv?._id ?? null;
}

// outbound message this delivery event is about (provider ids are scoped to the tenant)
const outbound = (organizationId: mongoose.Types.ObjectId, providerMessageId?: string) =>
    providerMessageId ? Message.findOne({ organizationId, providerMessageId, direction: "outbound" }) : null;

/*
    Applies one persisted provider event. Safe to re-run: inbound messages dedupe on the
    event key, and status changes only move forward (a late "delivered" never overwrites
    a bounce or complaint).
*/
export async function processProviderEvent(evt: Evt): Promise<"processed" | "ignored"> {
    const organizationId = evt.organizationId;
    const p = evt.payload as Payload;

    if (evt.type === "inbound") {
        const conversationId = await matchConversation(organizationId, p);
        if (!conversationId) return "ignored";
        await recordInbound(organizationId, conversationId, {
            from: p.from, subject: p.subject, body: p.text || "(empty message)", eventKey: `provider:${evt.integrationId}:${evt.eventId}`,
            autoSubmitted: p.autoSubmitted, providerMessageId: p.messageId,
        }, { type: "system", id: "webhook:email" });
        return "processed";
    }

    const msg = await outbound(organizationId, p.providerMessageId);
    if (!msg) return "ignored";

    if (evt.type === "delivered") {
        await Message.updateOne({ organizationId, _id: msg._id, status: { $in: ["sent", "uncertain"] } }, { status: "delivered", deliveredAt: evt.occurredAt, error: null });
        await recordStage(organizationId, msg.leadId, "delivered");
        return "processed";
    }

    // bounce / complaint: terminal for the message, and a hard bounce or complaint stops all contact
    await Message.updateOne({ organizationId, _id: msg._id, status: { $ne: "bounced" } }, { status: "bounced", error: evt.type === "complained" ? "Recipient complained" : `${p.bounceType ?? "hard"} bounce` });
    const stop = evt.type === "complained" || p.bounceType !== "soft";
    if (stop && msg.to) {
        await suppressEmail(organizationId, msg.to, evt.type === "complained" ? "complaint" : "bounce", `provider:${evt.eventId}`);
        await cancelPendingOutbound(organizationId, { leadId: msg.leadId }, evt.type === "complained" ? "Recipient complained" : "Address bounced");
        await Conversation.updateOne({ organizationId, _id: msg.conversationId }, { status: "suppressed" });
        await Lead.updateOne({ organizationId, _id: msg.leadId }, { outreachStatus: evt.type === "complained" ? "opted_out" : "closed" });
    }
    if (evt.type === "complained") await alert(organizationId, "complaint", "A recipient marked your email as spam; outreach to them has stopped.", { messageId: String(msg._id) });
    await audit({
        organizationId, actorType: "system", actorId: "webhook:email", action: `message.${evt.type}`,
        targetType: "message", targetId: String(msg._id), outcome: "success", metadata: { bounceType: p.bounceType, to: msg.to },
    });
    return "processed";
}

// worker: lease and process pending events; failures retry a few times before staying "failed"
export async function processPendingEvents(max = 25) {
    for (let i = 0; i < max; i++) {
        const evt = await ProviderEvent.findOneAndUpdate(
            { status: "pending" },
            { status: "processing", lockedUntil: new Date(Date.now() + 120_000), $inc: { attempts: 1 } },
            { sort: { createdAt: 1 }, new: true },
        ).setOptions({ crossTenant: true });
        if (!evt) return;
        try {
            const outcome = await processProviderEvent(evt);
            await ProviderEvent.updateOne({ organizationId: evt.organizationId, _id: evt._id }, { status: outcome, lockedUntil: null, error: null });
        } catch (error) {
            await ProviderEvent.updateOne({ organizationId: evt.organizationId, _id: evt._id }, {
                status: evt.attempts >= 5 ? "failed" : "pending", lockedUntil: null, error: (error as Error).message?.slice(0, 500),
            });
        }
    }
}
