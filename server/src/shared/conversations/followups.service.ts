// Importing modules
import mongoose from "mongoose";
import Conversation from "../models/conversation.model.js";
import Lead from "../models/lead.model.js";
import Campaign from "../models/campaign.model.js";
import Message from "../models/message.model.js";
import Approval from "../models/approval.model.js";
import { getCurrentPolicy, isSuppressed } from "../policy/policy.service.js";
import { nextFollowUpAt } from "./schedule.js";

type Id = mongoose.Types.ObjectId | string;
type Conv = { _id: mongoose.Types.ObjectId; leadId: mongoose.Types.ObjectId; status: string; followUpsSent: number; assignedTo?: unknown; campaignId?: unknown };

/*
    Why an automated follow-up must not happen now, or null if it may.
    Re-evaluated from fresh records right before scheduling, drafting and sending:
    the conditions a follow-up was scheduled under are never assumed to still hold.
*/
export async function followUpStopReason(organizationId: Id, conv: Conv): Promise<string | null> {
    if (conv.status !== "waiting") return `Conversation is ${conv.status}`;
    if (conv.assignedTo) return "Assigned to a human for manual handling";
    const lead = await Lead.findOne({ organizationId, _id: conv.leadId }, { status: 1, opportunityStage: 1, outreachStatus: 1, "contact.email": 1 }).lean();
    if (!lead) return "Lead deleted";
    if (lead.status === "disqualified") return "Lead disqualified";
    if (["won", "lost"].includes(lead.opportunityStage)) return `Opportunity ${lead.opportunityStage}`;
    if (["opted_out", "closed", "replied"].includes(lead.outreachStatus)) return `Lead ${lead.outreachStatus.replace("_", " ")}`;
    if (await isSuppressed(organizationId, lead.contact?.email)) return "Recipient suppressed";
    const { config } = await getCurrentPolicy(organizationId);
    if (!config.outreach.enabled) return "Outreach disabled by policy";
    let cap = config.outreach.maxFollowUps;
    if (conv.campaignId) {
        const campaign = await Campaign.findOne({ organizationId, _id: conv.campaignId }, { status: 1, followUpDelaysDays: 1 }).lean();
        if (campaign?.status !== "active") return `Campaign ${campaign?.status ?? "deleted"}`;
        cap = Math.min(cap, campaign.followUpDelaysDays.length);
    }
    if (conv.followUpsSent >= cap) return "Follow-up sequence complete";
    return null;
}

// after a successful send: thread state + when the next follow-up is due
export async function recordOutboundSent(organizationId: Id, msg: { conversationId: Id; kind: string }, sentAt: Date) {
    const conv = await Conversation.findOne({ organizationId, _id: msg.conversationId });
    if (!conv) return;
    conv.lastOutboundAt = sentAt;
    conv.lastMessageAt = sentAt;
    if (msg.kind === "follow_up") conv.followUpsSent += 1;
    if (msg.kind === "outreach" || msg.kind === "follow_up") {
        if (conv.status === "open") conv.status = "waiting";
        conv.conversationState = "awaiting_reply";
        const { config } = await getCurrentPolicy(organizationId);
        const campaign = conv.campaignId ? await Campaign.findOne({ organizationId, _id: conv.campaignId }, { followUpDelaysDays: 1 }).lean() : null;
        conv.nextActionAt = nextFollowUpAt(sentAt, conv.followUpsSent, campaign, config.outreach) ?? undefined;
    } else if (conv.status === "open") {
        // after a reply the human-paced conversation continues; no automated chasing
        conv.status = "waiting";
        conv.nextActionAt = undefined;
    }
    await conv.save();
}

// a reply, opt-out, bounce or pause cancels everything still waiting to go out on this thread
export async function cancelPendingOutbound(organizationId: Id, where: { conversationId?: Id; leadId?: Id; campaignId?: Id }, reason: string, kinds = ["outreach", "follow_up"]) {
    const filter = { organizationId, ...where, direction: "outbound", kind: { $in: kinds }, status: { $in: ["draft", "queued", "pending_approval"] } };
    if (where.conversationId) await Conversation.updateOne({ organizationId, _id: where.conversationId }, { $unset: { nextActionAt: 1 } });
    const ids = (await Message.find(filter, { _id: 1 }).lean()).map((m) => m._id);
    if (!ids.length) return;
    await Message.updateMany({ organizationId, _id: { $in: ids } }, { status: "rejected", error: reason });
    await Approval.updateMany({ organizationId, targetId: { $in: ids }, status: "pending" }, { status: "expired", decisionNote: reason });
}
