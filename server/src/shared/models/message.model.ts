// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// "sent" = accepted by the provider; delivered / bounced come later from provider events
export const MESSAGE_STATUSES = ["draft", "pending_approval", "queued", "sending", "sent", "delivered", "bounced", "failed", "uncertain", "rejected", "received"] as const;

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

    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },

    // email threading: our outbound Message-ID is the providerMessageId
    inReplyTo: String,
    references: [String],

    // AI review of an inbound message (or of an outbound draft)
    classification: {
        confidence: Number,
        requiresHuman: Boolean,
        recommendedAction: String,
    },

    // personalisation claims in a draft and whether each is backed by research evidence
    claims: [{ _id: false, claim: String, evidenceUrl: String, verified: Boolean }],

    deliveredAt: Date,

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
messageSchema.index({ organizationId: 1, providerMessageId: 1 }, { unique: true, partialFilterExpression: { providerMessageId: { $type: "string" } } });
messageSchema.index({ organizationId: 1, campaignId: 1, status: 1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;
