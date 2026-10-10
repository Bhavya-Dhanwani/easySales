// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// a thread with a lead on one channel
const conversationSchema = new mongoose.Schema({

    ...tenantFields,

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    channel: { type: String, enum: ["email"], default: "email" },

    subject: String,

    status: { type: String, enum: ["open", "waiting", "closed", "suppressed"], default: "open" },

    summary: String,

    lastIntent: String,

    followUpsSent: { type: Number, default: 0 },

    lastOutboundAt: Date,

    lastMessageAt: Date,

}, { timestamps: true });

conversationSchema.plugin(tenantPlugin);
conversationSchema.index({ organizationId: 1, leadId: 1 });
conversationSchema.index({ organizationId: 1, lastMessageAt: -1 });

const Conversation = mongoose.model("Conversation", conversationSchema);

export default Conversation;
