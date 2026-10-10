// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const OPPORTUNITY_STAGES = ["new", "qualified", "discovery", "proposal", "negotiation", "won", "lost"] as const;
export const QUALIFICATION_STATUSES = ["unreviewed", "qualified", "disqualified", "needs_review"] as const;
export const OUTREACH_STATUSES = ["not_started", "eligible", "active", "replied", "opted_out", "closed"] as const;
export const CONSENT_BASES = ["none", "opt_in", "existing_customer", "legitimate_interest"] as const;

const evidenceSchema = new mongoose.Schema({
    claim: { type: String, required: true },
    sourceUrl: String,
    // the model's own confidence; anything not backed by a fetched source stays unverified
    confidence: { type: Number, min: 0, max: 1 },
    verified: { type: Boolean, default: false },
    observedAt: { type: Date, default: Date.now },
}, { _id: false });

// a prospective customer (company + primary contact) moving through the pipeline
const leadSchema = new mongoose.Schema({

    ...tenantFields,

    company: {
        name: { type: String, required: true, trim: true, maxlength: 200 },
        website: { type: String, trim: true },
        domain: { type: String, lowercase: true, trim: true },
        industry: String,
        size: String,
        country: String,
    },

    contact: {
        name: String,
        title: String,
        email: { type: String, lowercase: true, trim: true },
        phone: String,
    },

    consent: {
        basis: { type: String, enum: CONSENT_BASES, default: "none" },
        source: String,
        recordedAt: Date,
    },

    source: {
        provider: { type: String, default: "manual" },
        externalId: String,
        importedAt: { type: Date, default: Date.now },
    },

    research: {
        status: { type: String, enum: ["pending", "running", "done", "failed"], default: "pending" },
        summary: String,
        needs: [String],
        evidence: [evidenceSchema],
        researchedAt: Date,
    },

    qualification: {
        score: { type: Number, min: 0, max: 100 },
        rationale: String,
        flags: [String],
        status: { type: String, enum: QUALIFICATION_STATUSES, default: "unreviewed" },
    },

    outreachStatus: { type: String, enum: OUTREACH_STATUSES, default: "not_started" },

    opportunityStage: { type: String, enum: OPPORTUNITY_STAGES, default: "new" },

    // structured discovery notes captured from conversations
    requirements: {
        needs: [String],
        budget: String,
        timeline: String,
    },

    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

}, { timestamps: true });

leadSchema.plugin(tenantPlugin);
leadSchema.index({ organizationId: 1, "company.domain": 1 });
leadSchema.index({ organizationId: 1, opportunityStage: 1, updatedAt: -1 });
// one lead per contact email per tenant — the deduplication backstop
leadSchema.index(
    { organizationId: 1, "contact.email": 1 },
    { unique: true, partialFilterExpression: { "contact.email": { $type: "string" } } }
);

const Lead = mongoose.model("Lead", leadSchema);

export default Lead;
