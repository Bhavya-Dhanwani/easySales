// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// a human decision bound to one exact action payload; changing the payload invalidates it
const approvalSchema = new mongoose.Schema({

    ...tenantFields,

    actionType: { type: String, enum: ["outreach.send", "reply.send", "proposal.send"], required: true },

    targetType: { type: String, enum: ["message", "proposal"], required: true },

    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },

    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "Workflow" },

    // what will be executed if approved (e.g. the exact email)
    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    payloadHash: { type: String, required: true },

    policyVersion: { type: Number, required: true },

    reasons: [String],

    status: { type: String, enum: ["pending", "approved", "rejected", "expired"], default: "pending" },

    requestedBy: { type: String, default: "agent" },

    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    decidedAt: Date,

    decisionNote: String,

    expiresAt: { type: Date, required: true },

}, { timestamps: true });

approvalSchema.plugin(tenantPlugin);
approvalSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const Approval = mongoose.model("Approval", approvalSchema);

export default Approval;
