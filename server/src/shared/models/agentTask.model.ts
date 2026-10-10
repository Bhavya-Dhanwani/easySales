// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// one agent invocation inside a workflow, kept for debugging and evaluation
const agentTaskSchema = new mongoose.Schema({

    ...tenantFields,

    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },

    agent: { type: String, required: true },

    status: { type: String, enum: ["completed", "failed"], required: true },

    output: { type: mongoose.Schema.Types.Mixed },

    error: String,

    model: String,

    inputTokens: { type: Number, default: 0 },

    outputTokens: { type: Number, default: 0 },

    durationMs: Number,

}, { timestamps: true });

agentTaskSchema.plugin(tenantPlugin);
agentTaskSchema.index({ organizationId: 1, workflowId: 1, createdAt: 1 });
agentTaskSchema.index({ organizationId: 1, createdAt: -1 });

const AgentTask = mongoose.model("AgentTask", agentTaskSchema);

export default AgentTask;
