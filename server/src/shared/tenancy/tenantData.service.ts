// Importing modules
import mongoose from "mongoose";
import Organization from "../models/organization.model.js";
import Membership from "../models/membership.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import Policy from "../models/policy.model.js";
import Lead from "../models/lead.model.js";
import Workflow from "../models/workflow.model.js";
import AgentTask from "../models/agentTask.model.js";
import Approval from "../models/approval.model.js";
import AuditEvent from "../models/auditEvent.model.js";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
import Suppression from "../models/suppression.model.js";
import Proposal from "../models/proposal.model.js";
import UsageRecord from "../models/usageRecord.model.js";

// every tenant-owned collection, in one place, so export and deletion cannot drift apart
const TENANT_MODELS = {
    memberships: Membership, businessProfile: BusinessProfile, policies: Policy, leads: Lead,
    workflows: Workflow, agentTasks: AgentTask, approvals: Approval, conversations: Conversation,
    messages: Message, suppressions: Suppression, proposals: Proposal, usage: UsageRecord, auditEvents: AuditEvent,
} as const;

export async function exportTenant(organizationId: mongoose.Types.ObjectId) {
    const out: Record<string, unknown> = { organization: await Organization.findById(organizationId).lean(), exportedAt: new Date() };
    for (const [key, model] of Object.entries(TENANT_MODELS)) {
        out[key] = await (model as mongoose.Model<unknown>).find({ organizationId }).lean();
    }
    return out;
}

/*
    Deletes all tenant data. Audit events are append-only for application code, so they
    are removed through the raw collection, which only this function does.
*/
export async function purgeTenant(organizationId: mongoose.Types.ObjectId) {
    await Organization.updateOne({ _id: organizationId }, { status: "deleting" });
    for (const [key, model] of Object.entries(TENANT_MODELS)) {
        if (key === "auditEvents") await AuditEvent.collection.deleteMany({ organizationId });
        else await (model as mongoose.Model<unknown>).deleteMany({ organizationId });
    }
    // LangGraph checkpoints are keyed by workflow id; they expire via TTL
    await Organization.deleteOne({ _id: organizationId });
}
