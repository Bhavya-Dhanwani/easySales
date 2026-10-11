// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const WORKFLOW_TYPES = ["lead.pipeline", "lead.research", "conversation.reply", "conversation.followup", "proposal.generate", "requirements.extract", "prototype.build"] as const;
export const WORKFLOW_STATUSES = ["queued", "running", "waiting_approval", "completed", "failed", "cancelled"] as const;

/*
    A durable unit of agent work. This collection is both the source of truth for
    workflow state and the job queue (workers lease rows with findOneAndUpdate).
    Detailed graph state lives in LangGraph checkpoints keyed by this _id.
*/
const workflowSchema = new mongoose.Schema({

    ...tenantFields,

    type: { type: String, enum: WORKFLOW_TYPES, required: true },

    entityType: { type: String, enum: ["lead", "conversation", "proposal", "prototype"], required: true },

    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },

    status: { type: String, enum: WORKFLOW_STATUSES, default: "queued" },

    currentStep: { type: String, default: "queued" },

    input: { type: mongoose.Schema.Types.Mixed, default: {} },

    // the policy version the workflow was started under (policy is re-read before external actions)
    policyVersion: Number,

    // set by an approval decision; the worker passes it to the graph to resume
    resume: { type: mongoose.Schema.Types.Mixed, default: null },

    result: { type: mongoose.Schema.Types.Mixed, default: null },

    nextRunAt: { type: Date, default: Date.now },

    // higher runs first among due jobs (lead score band for lead work)
    priority: { type: Number, default: 0 },

    lastStartedAt: Date,

    // run time of the last attempt, for capacity planning
    durationMs: Number,

    attempts: { type: Number, default: 0 },

    maxAttempts: { type: Number, default: 3 },

    lockedUntil: Date,

    lockedBy: String,

    failureCode: String,

    lastError: String,

    // prevents the same logical request from starting two workflows
    idempotencyKey: { type: String, required: true },

    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    correlationId: { type: String, required: true },

}, { timestamps: true });

workflowSchema.plugin(tenantPlugin);
workflowSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
workflowSchema.index({ status: 1, nextRunAt: 1 });
workflowSchema.index({ status: 1, priority: -1, nextRunAt: 1 });
workflowSchema.index({ organizationId: 1, entityId: 1, createdAt: -1 });

const Workflow = mongoose.model("Workflow", workflowSchema);

export default Workflow;
