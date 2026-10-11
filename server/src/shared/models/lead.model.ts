// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const OPPORTUNITY_STAGES = ["new", "qualified", "discovery", "proposal", "negotiation", "nurture", "won", "lost"] as const;
// research + qualification lifecycle (Sprint 2 pipeline)
export const LEAD_STATUSES = ["new", "research_queued", "researching", "qualified", "needs_review", "disqualified", "research_failed"] as const;
export const OUTREACH_STATUSES = ["not_started", "eligible", "active", "replied", "opted_out", "closed"] as const;
export const CONSENT_BASES = ["none", "opt_in", "existing_customer", "legitimate_interest"] as const;
export const MATCH_RESULTS = ["match", "partial", "mismatch", "unknown"] as const;

const evidenceSchema = new mongoose.Schema({
    claim: { type: String, required: true },
    sourceUrl: String,
    // the model's own confidence; anything not backed by a fetched source stays unverified
    confidence: { type: Number, min: 0, max: 1 },
    verified: { type: Boolean, default: false },
    observedAt: { type: Date, default: Date.now },
}, { _id: false });

const criterionSchema = new mongoose.Schema({
    criterionId: { type: String, required: true },
    label: String,
    weight: Number,
    result: { type: String, enum: MATCH_RESULTS, required: true },
    explanation: String,
    evidenceUrls: [String],
    // when the evidence behind this signal was observed (the research run)
    observedAt: Date,
}, { _id: false });

const companySchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 200 },
    website: { type: String, trim: true },
    domain: { type: String, lowercase: true, trim: true },
    industry: String,
    size: String,
    employeeCount: { type: Number, min: 0 },
    country: String,
    description: { type: String, maxlength: 2000 },
}, { _id: false });

// a prospective customer (company + primary contact) moving through the pipeline
const leadSchema = new mongoose.Schema({

    ...tenantFields,

    company: { type: companySchema, required: true },

    contact: {
        name: String,
        title: String,
        email: { type: String, lowercase: true, trim: true },
        phone: String,
    },

    // email, else domain, else normalized name; unique per tenant so concurrent imports cannot duplicate
    dedupeKey: { type: String, required: true },

    status: { type: String, enum: LEAD_STATUSES, default: "new" },

    consent: {
        basis: { type: String, enum: CONSENT_BASES, default: "none" },
        source: String,
        recordedAt: Date,
    },

    source: {
        provider: { type: String, enum: ["csv", "manual", "provider", "seed"], default: "manual" },
        externalId: String,
        importId: { type: mongoose.Schema.Types.ObjectId, ref: "ImportJob" },
        enrolledAt: Date,
        importedAt: { type: Date, default: Date.now },
    },

    research: {
        status: { type: String, enum: ["pending", "running", "done", "failed"], default: "pending" },
        summary: String,
        needs: [String],
        evidence: [evidenceSchema],
        sources: [String],
        conflicts: [String],
        // request time of the job that produced this report: older jobs may never overwrite it
        generatedAt: Date,
        researchedAt: Date,
        profileVersion: Number,
    },

    qualification: {
        score: { type: Number, min: 0, max: 100 },
        evidenceCoverage: { type: Number, min: 0, max: 100 },
        rationale: String,
        flags: [String],
        criteria: [criterionSchema],
        evaluatedAt: Date,
        profileVersion: Number,
        policyVersion: Number,
        overriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        // score band from policy thresholds: drives ordering, never consent or approvals
        priority: { type: String, enum: ["high", "medium", "low"] },
    },

    // the outreach experiment this lead was assigned to (once, so it never sees conflicting variants)
    experiment: {
        id: { type: mongoose.Schema.Types.ObjectId, ref: "Experiment" },
        variantId: String,
        assignedAt: Date,
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

    // the onboarding rehearsal lead: its only contact is the workspace user themself
    isTest: { type: Boolean, default: false },

    // the CRM company this lead works at (company fields are CRM-owned once linked)
    crmCompanyId: String,

    // next-best-action controls for this opportunity (escalations pause it until a human resumes)
    automation: {
        paused: Boolean,
        pausedAt: Date,
        pausedBy: String,
        reason: String,
        // the reply a human took over when resuming: it is not re-escalated or re-answered by the engine
        handledInboundId: String,
    },

    // set once when a won deal is handed over to delivery
    handoff: {
        proposalId: { type: mongoose.Schema.Types.ObjectId, ref: "Proposal" },
        at: Date,
        by: String,
        notes: String,
    },

    // set once when a campaign enrolls the lead (a lead is in at most one campaign)
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },

}, { timestamps: true });

leadSchema.plugin(tenantPlugin);
leadSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true });
leadSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });
leadSchema.index({ organizationId: 1, "company.domain": 1 });
leadSchema.index({ organizationId: 1, "contact.email": 1 });
leadSchema.index({ organizationId: 1, opportunityStage: 1, updatedAt: -1 });
leadSchema.index({ organizationId: 1, "qualification.priority": 1, "qualification.score": -1 });

// the same normalization everywhere a lead is created
export function leadDedupeKey(l: { contact?: { email?: string | null } | null; company: { domain?: string | null; name: string } }) {
    if (l.contact?.email) return `email:${l.contact.email.trim().toLowerCase()}`;
    if (l.company.domain) return `domain:${l.company.domain.trim().toLowerCase()}`;
    return `name:${l.company.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

const Lead = mongoose.model("Lead", leadSchema);

export default Lead;
