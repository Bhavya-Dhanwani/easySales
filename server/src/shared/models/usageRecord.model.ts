// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const USAGE_KINDS = ["llm", "research", "email", "prototype", "discovery"] as const;

// the usage ledger: one immutable row per metered unit of work (AI call, research job, email, build attempt)
const usageRecordSchema = new mongoose.Schema({

    ...tenantFields,

    kind: { type: String, enum: USAGE_KINDS, default: "llm" },

    quantity: { type: Number, default: 1 },

    // in the platform billing currency (env BILLING_CURRENCY); estimated from configured unit prices
    costMinor: { type: Number, default: 0 },

    // e.g. the model, email provider or template
    provider: String,

    // the lead, prototype or message this was spent on
    refId: String,

    // the opportunity the cost is attributed to (resolved from the workflow when not given)
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },

    agent: String,

    model: String,

    inputTokens: { type: Number, default: 0 },

    outputTokens: { type: Number, default: 0 },

    durationMs: Number,

    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },

}, { timestamps: { createdAt: true, updatedAt: false } });

usageRecordSchema.plugin(tenantPlugin);
usageRecordSchema.index({ organizationId: 1, createdAt: -1 });
usageRecordSchema.index({ organizationId: 1, kind: 1, createdAt: -1 });
usageRecordSchema.index({ organizationId: 1, leadId: 1 });

// financial records: append-only for application code (retention never deletes them)
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
    usageRecordSchema.pre(op, function () {
        throw new Error("Usage records are append-only");
    });
}

const UsageRecord = mongoose.model("UsageRecord", usageRecordSchema);

export default UsageRecord;
