// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const MESSAGE_STATUSES = ["pending_approval", "queued", "sending", "sent", "failed", "uncertain", "rejected", "received"] as const;

/*
    Messages double as the transactional outbox: an outbound message is committed as
    "queued" with an idempotency key before any provider is called, and the dispatcher
    moves it to sent / failed / uncertain. "uncertain" is never retried blindly.
*/
const messageSchema = new mongoose.Schema({

    ...tenantFields,

    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    direction: { type: String, enum: ["outbound", "inbound"], required: true },

    kind: { type: String, enum: ["outreach", "follow_up", "reply", "proposal", "inbound"], required: true },

    to: String,

    from: String,

    subject: { type: String, maxlength: 300 },

    body: { type: String, required: true, maxlength: 20000 },

    status: { type: String, enum: MESSAGE_STATUSES, required: true },

    // AI classification for inbound messages
    intent: String,

    idempotencyKey: { type: String, required: true },

    providerMessageId: String,

    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: "Approval" },

    proposalId: { type: mongoose.Schema.Types.ObjectId, ref: "Proposal" },

    attempts: { type: Number, default: 0 },

    lockedUntil: Date,

    // the dispatcher will not send before this time (quiet hours)
    notBefore: { type: Date, default: Date.now },

    sentAt: Date,

    error: String,

}, { timestamps: true });

messageSchema.plugin(tenantPlugin);
messageSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
messageSchema.index({ organizationId: 1, conversationId: 1, createdAt: 1 });
messageSchema.index({ status: 1, notBefore: 1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;
