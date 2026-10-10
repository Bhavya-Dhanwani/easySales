// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// a thread with a lead on one channel
const conversationSchema = new mongoose.Schema({

    ...tenantFields,

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    channel: { type: String, enum: ["email"], default: "email" },

    subject: String,

    // waiting = waiting for the prospect; needs_review = a human must look before anything else happens
    status: { type: String, enum: ["open", "waiting", "needs_review", "closed", "suppressed"], default: "open" },

    conversationState: {
        type: String,
        enum: ["initial_outreach", "awaiting_reply", "engaged", "meeting_pending", "handoff", "closed"],
        default: "initial_outreach",
    },

    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },

    // a human owner takes the thread out of automated follow-ups
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // when the next follow-up is due (authoritative scheduling state)
    nextActionAt: Date,

    lastInboundAt: Date,

    summary: String,

    lastIntent: String,

    followUpsSent: { type: Number, default: 0 },

    lastOutboundAt: Date,

    lastMessageAt: Date,

}, { timestamps: true });

conversationSchema.plugin(tenantPlugin);
conversationSchema.index({ organizationId: 1, leadId: 1 });
conversationSchema.index({ organizationId: 1, lastMessageAt: -1 });
conversationSchema.index({ status: 1, nextActionAt: 1 });

const Conversation = mongoose.model("Conversation", conversationSchema);

export default Conversation;
