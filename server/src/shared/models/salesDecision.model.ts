// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";
import { SALES_ACTIONS, SALES_STATES } from "../sales/engine.js";

/*
    One next-best-action decision: what was chosen, why, from which evidence, what the policy
    said, and what happened. Keyed by the triggering event, so a duplicated event never
    produces a second decision (or a second action).
*/
const salesDecisionSchema = new mongoose.Schema({

    ...tenantFields,

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    trigger: { type: String, required: true },

    idempotencyKey: { type: String, required: true },

    state: { type: String, enum: SALES_STATES, required: true },

    action: { type: String, enum: SALES_ACTIONS, required: true },

    reason: { type: String, required: true },

    evidenceIds: [String],

    missingInformation: [String],

    confidence: { type: Number, default: 1 },

    // "rules" when only one action was valid, "model" when the model chose among valid ones
    decidedBy: { type: String, enum: ["rules", "model"], default: "rules" },

    // a model suggestion outside the valid actions is recorded and ignored
    rejectedSuggestion: String,

    candidates: [String],

    params: { type: mongoose.Schema.Types.Mixed, default: {} },

    policyDecision: { type: String, enum: ["allowed", "approval_required", "blocked"], required: true },

    policyReason: String,

    status: { type: String, enum: ["proposed", "queued", "completed", "failed", "skipped"], default: "proposed" },

    outcome: String,

    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: "Approval" },

    fingerprint: String,

    autonomyLevel: Number,

    workflowVersion: String,

    nextEvaluationAt: Date,

    completedAt: Date,

}, { timestamps: true });

salesDecisionSchema.plugin(tenantPlugin);
salesDecisionSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
salesDecisionSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });

const SalesDecision = mongoose.model("SalesDecision", salesDecisionSchema);

export default SalesDecision;
