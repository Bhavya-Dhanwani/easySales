// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const PROTOTYPE_STATUSES = ["queued", "building", "testing", "needs_review", "publishing", "ready", "failed", "expired", "cancelled"] as const;

// a demo built from an approved template for one requirements version
const prototypeSchema = new mongoose.Schema({

    ...tenantFields,

    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true, immutable: true },

    requirementsVersion: { type: Number, required: true, immutable: true },

    templateId: { type: String, required: true, immutable: true },

    // queued → building → testing → needs_review (QA passed, awaiting publication) → ready (preview live)
    status: { type: String, enum: PROTOTYPE_STATUSES, default: "queued" },

    // set when a human has to approve the build before it starts
    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: "Approval" },

    budgetMinorUnits: { type: Number, required: true, min: 0 },

    costMinorUnits: { type: Number, default: 0 },

    currency: { type: String, required: true },

    // ponytail: the built page lives in Mongo, never selected by default; move to object storage past ~1 MB
    artifactHtml: { type: String, select: false },

    artifactChecksum: String,

    artifactBytes: Number,

    // unguessable capability for the public preview; removed on expiry or revocation
    previewToken: { type: String, select: false },

    previewUrl: String,

    previewExpiresAt: Date,

    qaReport: {
        buildPassed: Boolean,
        testsPassed: Boolean,
        securityPassed: Boolean,
        findings: [String],
    },

    attempts: { type: Number, default: 0 },

    maxAttempts: { type: Number, default: 2 },

    retries: { type: Number, default: 0 },

    failureCode: String,

    idempotencyKey: { type: String, required: true },

    requestedBy: String,

    completedAt: Date,

}, { timestamps: true });

prototypeSchema.plugin(tenantPlugin);
prototypeSchema.index({ organizationId: 1, opportunityId: 1, createdAt: -1 });
prototypeSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
prototypeSchema.index({ previewToken: 1 }, { unique: true, sparse: true });
prototypeSchema.index({ status: 1, previewExpiresAt: 1 });

const Prototype = mongoose.model("Prototype", prototypeSchema);

export default Prototype;
