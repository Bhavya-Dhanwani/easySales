// Importing modules
import { executeApprovedDecision } from "../sales/sales.service.js";
import SalesDecision from "../models/salesDecision.model.js";
import mongoose from "mongoose";
import Approval from "../models/approval.model.js";
import Message from "../models/message.model.js";
import Proposal from "../models/proposal.model.js";
import Workflow from "../models/workflow.model.js";
import { isSuppressed } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { hashPayload } from "../utils/hash.util.js";
import { messagePayload } from "../outbound/outbound.service.js";
import { executeApprovedProposal, proposalPayload } from "../proposals/proposal.service.js";
import { decidePrototypeApproval } from "../prototypes/prototype.service.js";
import NotFound from "../errors/NotFound.error.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId;

async function loadPending(organizationId: Id, approvalId: string) {
    const approval = await Approval.findOne({ organizationId, _id: approvalId });
    if (!approval) throw new NotFound("Approval not found");
    if (approval.status === "pending" && approval.expiresAt < new Date()) {
        approval.status = "expired";
        await approval.save();
    }
    if (approval.status !== "pending") throw new Conflict(`Approval is already ${approval.status}`);
    return approval;
}

// lets a reviewer edit the drafted message before approving; this re-binds the approval
export async function editPendingMessage(organizationId: Id, approvalId: string, edit: { subject: string; body: string }, userId: string) {
    const approval = await loadPending(organizationId, approvalId);
    if (approval.targetType !== "message") throw new Conflict("Only message approvals can be edited");
    const message = await Message.findOne({ organizationId, _id: approval.targetId, status: "pending_approval" });
    if (!message) throw new Conflict("Message is no longer awaiting approval");

    message.subject = edit.subject;
    message.body = edit.body;
    await message.save();
    const payload = messagePayload(message);
    approval.payload = payload;
    approval.payloadHash = hashPayload(payload);
    await approval.save();

    await audit({ organizationId, actorType: "user", actorId: userId, action: "approval.edit", targetType: "approval", targetId: approvalId, outcome: "success" });
    return approval;
}

/*
    Records a human decision. Approval only authorizes the exact payload the reviewer
    saw (payloadHash) and the target must still match it; suppression is re-checked at
    decision time. The paused LangGraph workflow is then resumed by the worker.
*/
export async function decideApproval(
    organizationId: Id, approvalId: string, decision: "approved" | "rejected", userId: string,
    opts: { payloadHash?: string; note?: string } = {},
) {
    await loadPending(organizationId, approvalId);
    // claim it atomically: of two simultaneous decisions only one proceeds, the other is refused
    const approval = await Approval.findOneAndUpdate({ organizationId, _id: approvalId, status: "pending" }, { status: "deciding" }, { new: true });
    if (!approval) throw new Conflict("Someone else is deciding this right now");
    try {
        await applyDecision(organizationId, approval, decision, userId, opts);
    } catch (error) {
        await Approval.updateOne({ organizationId, _id: approval._id, status: "deciding" }, { status: "pending" });
        throw error;
    }
    return approval;
}

async function applyDecision(
    organizationId: Id, approval: InstanceType<typeof Approval>, decision: "approved" | "rejected", userId: string,
    opts: { payloadHash?: string; note?: string },
) {
    const approvalId = String(approval._id);
    if (decision === "approved") {
        if (opts.payloadHash !== approval.payloadHash) throw new Conflict("The action changed since you reviewed it. Reload and review again.");

        if (approval.targetType === "message") {
            const message = await Message.findOne({ organizationId, _id: approval.targetId, status: "pending_approval" });
            if (!message) throw new Conflict("Message is no longer awaiting approval");
            if (hashPayload(messagePayload(message)) !== approval.payloadHash) throw new Conflict("Message no longer matches the approved content");
            if (await isSuppressed(organizationId, message.to)) {
                message.status = "rejected";
                message.error = "Recipient opted out before approval";
                await message.save();
                decision = "rejected";
                opts.note = "Auto-rejected: recipient opted out";
            } else {
                message.status = "queued";
                message.notBefore = new Date();
                await message.save();
            }
        } else if (approval.targetType === "prototype") {
            await decidePrototypeApproval(organizationId, approval.targetId, approval.payloadHash, true);
        } else if (approval.targetType === "decision") {
            await executeApprovedDecision(organizationId, approval.targetId);
        } else {
            const proposal = await Proposal.findOne({ organizationId, _id: approval.targetId, status: "pending_approval" });
            if (!proposal) throw new Conflict("Proposal is no longer awaiting approval");
            if (hashPayload(proposalPayload(proposal, String(approval.payload?.to ?? ""))) !== approval.payloadHash) throw new Conflict("Proposal changed since review");
            await executeApprovedProposal(organizationId, proposal._id, { payloadHash: approval.payloadHash, decidedBy: userId });
        }
    } else if (approval.targetType === "prototype") {
        await decidePrototypeApproval(organizationId, approval.targetId, approval.payloadHash, false);
    } else if (approval.targetType === "decision") {
        await SalesDecision.updateOne({ organizationId, _id: approval.targetId, status: "proposed" }, { status: "skipped", outcome: opts.note || "Rejected by reviewer", completedAt: new Date() });
    } else if (approval.targetType === "message") {
        await Message.updateOne({ organizationId, _id: approval.targetId, status: "pending_approval" }, { status: "rejected", error: opts.note || "Rejected by reviewer" });
    } else {
        await Proposal.updateOne({ organizationId, _id: approval.targetId, status: "pending_approval" }, { status: "draft" });
    }

    approval.status = decision;
    approval.decidedBy = new mongoose.Types.ObjectId(userId);
    approval.decidedAt = new Date();
    approval.decisionNote = opts.note;
    await approval.save();

    // resume the paused graph so the workflow records the outcome and finishes
    if (approval.workflowId) {
        await Workflow.updateOne(
            { organizationId, _id: approval.workflowId, status: "waiting_approval" },
            { status: "queued", resume: { decision }, nextRunAt: new Date() },
        );
    }

    await audit({
        organizationId, actorType: "user", actorId: userId, action: `approval.${decision}`,
        targetType: approval.targetType, targetId: approval.targetId.toString(), outcome: "success",
        policyVersion: approval.policyVersion, metadata: { approvalId, actionType: approval.actionType, note: opts.note },
    });
    return approval;
}
