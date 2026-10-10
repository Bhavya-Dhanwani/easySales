// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// one metered AI call, for budgets and the per-tenant cost dashboard
const usageRecordSchema = new mongoose.Schema({

    ...tenantFields,

    kind: { type: String, enum: ["llm"], default: "llm" },

    agent: String,

    model: String,

    inputTokens: { type: Number, default: 0 },

    outputTokens: { type: Number, default: 0 },

    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },

}, { timestamps: { createdAt: true, updatedAt: false } });

usageRecordSchema.plugin(tenantPlugin);
usageRecordSchema.index({ organizationId: 1, createdAt: -1 });

const UsageRecord = mongoose.model("UsageRecord", usageRecordSchema);

export default UsageRecord;
