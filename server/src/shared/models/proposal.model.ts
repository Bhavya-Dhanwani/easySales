// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const PROPOSAL_STATUSES = ["generating", "draft", "pending_approval", "approved", "sent", "accepted", "rejected", "expired", "superseded", "failed"] as const;

/*
    One immutable version of a priced offer. Numbers come from the deterministic pricing
    engine, prose from the AI. A revision is a new document with version + 1; once a
    version is drafted its content is never edited, only its status moves.
*/
const proposalSchema = new mongoose.Schema({

    ...tenantFields,

    // the opportunity (see requirements.model.ts)
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    version: { type: Number, default: 1 },

    previousVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "Proposal" },

    revisionNote: String,

    // 0 when no requirements had been captured
    requirementsVersion: { type: Number, default: 0 },

    // business profile version whose service prices (the price book) and terms were used
    priceBookVersion: { type: Number, default: 0 },

    termsTemplateVersion: { type: Number, default: 0 },

    prototypeId: { type: mongoose.Schema.Types.ObjectId, ref: "Prototype" },

    items: [{
        _id: false,
        name: { type: String, required: true },
        quantity: { type: Number, default: 1 },
        unitPriceMinor: { type: Number },
        // line total
        priceMinor: { type: Number, required: true, min: 0 },
    }],

    currency: { type: String, required: true },

    subtotalMinor: { type: Number, required: true },

    discountPercent: { type: Number, default: 0 },

    discountMinor: { type: Number, default: 0 },

    taxBasisPoints: { type: Number, default: 0 },

    taxMinor: { type: Number, default: 0 },

    totalMinor: { type: Number, required: true },

    paymentSchedule: [{ _id: false, label: String, percent: Number, amountMinor: Number }],

    scope: {
        deliverables: [String],
        exclusions: [String],
        assumptions: [String],
    },

    milestones: [{ _id: false, name: String, description: String }],

    body: { type: String, default: "" },

    status: { type: String, enum: PROPOSAL_STATUSES, default: "generating" },

    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: "Approval" },

    approvedBy: String,

    approvedAt: Date,

    // hash of the exact content that was approved; sending re-checks it
    payloadHash: String,

    sentAt: Date,

    expiresAt: Date,

    // a commercial event recorded by a person, not proof of a signed contract or payment
    acceptance: {
        acceptedBy: String,
        acceptedAt: Date,
        evidence: String,
        messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
        recordedBy: String,
    },

}, { timestamps: true });

proposalSchema.plugin(tenantPlugin);
proposalSchema.index({ organizationId: 1, leadId: 1, version: 1 }, { unique: true });
proposalSchema.index({ status: 1, expiresAt: 1 });

const Proposal = mongoose.model("Proposal", proposalSchema);

export default Proposal;
