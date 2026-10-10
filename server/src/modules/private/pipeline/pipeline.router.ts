// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Workflow, { WORKFLOW_STATUSES } from "../../../shared/models/workflow.model.js";
import AgentTask from "../../../shared/models/agentTask.model.js";
import Approval from "../../../shared/models/approval.model.js";
import Lead from "../../../shared/models/lead.model.js";
import Conversation from "../../../shared/models/conversation.model.js";
import Message from "../../../shared/models/message.model.js";
import Proposal from "../../../shared/models/proposal.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { decideApproval, editPendingMessage } from "../../../shared/approvals/approval.service.js";
import { recordInbound } from "../../../shared/conversations/inbound.service.js";
import { proposeOutbound } from "../../../shared/outbound/outbound.service.js";
import { requestProposalSend } from "../../../shared/proposals/proposal.service.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { nextCursor, oid, pageParams, str } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

// attaches company/contact names to records that reference a lead
async function withLeads<T extends { leadId?: unknown }>(organizationId: unknown, items: T[]) {
    const ids = [...new Set(items.map((i) => String(i.leadId)).filter((v) => v !== "undefined"))];
    const leads = await Lead.find({ organizationId, _id: { $in: ids } }, { company: 1, contact: 1, opportunityStage: 1 }).lean();
    return items.map((i) => ({ ...i, lead: leads.find((l) => String(l._id) === String(i.leadId)) ?? null }));
}

/* ------------------------------ workflows ------------------------------ */

/*
    @route GET /api/v1/workflows
*/
router.get("/workflows", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const { limit, cursorFilter } = pageParams(req.query);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId, ...cursorFilter };
    const status = str(req.query.status);
    if (status && (WORKFLOW_STATUSES as readonly string[]).includes(status)) filter.status = status;
    const workflows = await Workflow.find(filter, { input: 0 }).sort({ _id: -1 }).limit(limit).lean();
    return Ok(res, "Workflows", { workflows, nextCursor: nextCursor(workflows, limit) });
});

/*
    @route GET /api/v1/workflows/:id
    @desc Workflow status with the agent steps it ran
*/
router.get("/workflows/:id", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const workflow = await Workflow.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!workflow) throw new NotFound("Workflow not found");
    const tasks = await AgentTask.find({ organizationId: ctx.organizationId, workflowId: workflow._id }).sort({ createdAt: 1 }).lean();
    return Ok(res, "Workflow", { workflow, tasks });
});

/*
    @route POST /api/v1/workflows/:id/retry
    @desc Requeue a failed job once the cause is fixed (prototypes and research have their own retry)
*/
router.post("/workflows/:id/retry", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const workflow = await Workflow.findOneAndUpdate(
        { organizationId: ctx.organizationId, _id: oid(req.params.id), status: "failed", type: { $nin: ["prototype.build"] } },
        { status: "queued", attempts: 0, nextRunAt: new Date(), $unset: { failureCode: 1, lastError: 1 } }, { new: true },
    ).lean();
    if (!workflow) throw new Conflict("Only failed workflows can be retried");
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "workflow.retry", targetType: "workflow", targetId: workflow._id.toString(), outcome: "success" });
    return Ok(res, "Workflow requeued", { workflow });
});

/*
    @route POST /api/v1/workflows/:id/cancel
*/
router.post("/workflows/:id/cancel", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const workflow = await Workflow.findOneAndUpdate(
        { organizationId: ctx.organizationId, _id: oid(req.params.id), status: { $in: ["queued", "waiting_approval"] } },
        { status: "cancelled" }, { new: true },
    ).lean();
    if (!workflow) throw new Conflict("Only queued or waiting workflows can be cancelled");
    await Approval.updateMany({ organizationId: ctx.organizationId, workflowId: workflow._id, status: "pending" }, { status: "expired" });
    await Message.updateMany({ organizationId: ctx.organizationId, idempotencyKey: new RegExp(`^wf:${workflow._id}:`), status: { $in: ["queued", "pending_approval"] } }, { status: "rejected", error: "Workflow cancelled" });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "workflow.cancel", targetType: "workflow", targetId: workflow._id.toString(), outcome: "success" });
    return Ok(res, "Workflow cancelled", { workflow });
});

/* ------------------------------ approvals ------------------------------ */

/*
    @route GET /api/v1/approvals
*/
router.get("/approvals", authorize("approvals.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const status = str(req.query.status) ?? "pending";
    const approvals = await Approval.find({ organizationId: ctx.organizationId, status }).sort({ createdAt: -1 }).limit(100).lean();
    return Ok(res, "Approvals", { approvals: await withLeads(ctx.organizationId, approvals) });
});

/*
    @route PATCH /api/v1/approvals/:id
    @desc Edit a drafted message before approving it
*/
router.patch("/approvals/:id", authorize("approvals.decide"), validate(z.object({
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20000),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const approval = await editPendingMessage(ctx.organizationId, String(oid(req.params.id)), req.body, ctx.userId);
    return Ok(res, "Draft updated", { approval });
});

/*
    @route POST /api/v1/approvals/:id/approve
    @desc Approve the exact payload identified by payloadHash
*/
router.post("/approvals/:id/approve", authorize("approvals.decide"), validate(z.object({
    payloadHash: z.string().length(64),
    note: z.string().max(1000).optional(),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const approval = await decideApproval(ctx.organizationId, String(oid(req.params.id)), "approved", ctx.userId, req.body);
    return Ok(res, approval.status === "approved" ? "Approved" : "Auto-rejected", { approval });
});

/*
    @route POST /api/v1/approvals/:id/reject
*/
router.post("/approvals/:id/reject", authorize("approvals.decide"), validate(z.object({ note: z.string().max(1000).optional() }).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const approval = await decideApproval(ctx.organizationId, String(oid(req.params.id)), "rejected", ctx.userId, req.body);
    return Ok(res, "Rejected", { approval });
});

/* ---------------------------- conversations ---------------------------- */

/*
    @route GET /api/v1/conversations
*/
router.get("/conversations", authorize("conversations.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId };
    const status = str(req.query.status);
    if (status && ["open", "waiting", "needs_review", "closed", "suppressed"].includes(status)) filter.status = status;
    if (req.query.assigned === "me") filter.assignedTo = new mongoose.Types.ObjectId(ctx.userId);
    const conversations = await Conversation.find(filter).sort({ lastMessageAt: -1, updatedAt: -1 }).limit(100).lean();
    return Ok(res, "Conversations", { conversations: await withLeads(ctx.organizationId, conversations) });
});

/*
    @route GET /api/v1/conversations/:id
*/
router.get("/conversations/:id", authorize("conversations.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const conversation = await Conversation.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!conversation) throw new NotFound("Conversation not found");
    const [messages, [withLead]] = await Promise.all([
        Message.find({ organizationId: ctx.organizationId, conversationId: conversation._id }).sort({ createdAt: 1 }).lean(),
        withLeads(ctx.organizationId, [conversation]),
    ]);
    return Ok(res, "Conversation", { conversation: withLead, messages });
});

/*
    @route POST /api/v1/conversations/:id/inbound
    @desc Log a prospect's reply manually (e.g. pasted from your inbox) and let the AI respond
*/
router.post("/conversations/:id/inbound", authorize("conversations.write"), validate(z.object({
    subject: z.string().trim().max(300).optional(),
    body: z.string().trim().min(1).max(20000),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const conversationId = oid(req.params.id);
    const key = str(req.header("idempotency-key"))?.slice(0, 100) ?? `${ctx.userId}:${Date.now()}`;
    const result = await recordInbound(ctx.organizationId, conversationId, { ...req.body, eventKey: `manual:${key}` }, { type: "user", id: ctx.userId });
    return ApiResponse(res, 202, "Reply recorded; the conversation agent is on it", { messageId: result.message._id, workflowId: result.workflowId });
});

/*
    @route POST /api/v1/conversations/:id/reply
    @desc A human-written reply (still checked against suppression and claims policy)
*/
router.post("/conversations/:id/reply", authorize("conversations.write"), validate(z.object({
    body: z.string().trim().min(1).max(20000),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const conversation = await Conversation.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!conversation) throw new NotFound("Conversation not found");
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: conversation.leadId });
    if (!lead) throw new NotFound("Lead not found");
    const key = str(req.header("idempotency-key"))?.slice(0, 100) ?? `${Date.now()}`;
    const result = await proposeOutbound({
        organizationId: ctx.organizationId, lead, conversationId: conversation._id, kind: "reply",
        subject: conversation.subject ? `Re: ${conversation.subject.replace(/^re:\s*/i, "")}` : "Re: our conversation",
        body: req.body.body, idempotencyKey: `human:${ctx.userId}:${key}`, actor: { type: "user", id: ctx.userId },
    });
    return Ok(res, result.status === "queued" ? "Reply queued" : result.status === "pending_approval" ? "Reply needs approval" : "Reply blocked", result);
});

/* ------------------------------ proposals ------------------------------ */

/*
    @route GET /api/v1/proposals/:id
*/
router.get("/proposals/:id", authorize("proposals.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const proposal = await Proposal.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!proposal) throw new NotFound("Proposal not found");
    return Ok(res, "Proposal", { proposal });
});

/*
    @route POST /api/v1/proposals/:id/send
    @desc Send within pricing policy, or request approval
*/
router.post("/proposals/:id/send", authorize("proposals.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const result = await requestProposalSend(ctx.organizationId, String(oid(req.params.id)), ctx.userId);
    return Ok(res, result.decision === "allow" ? "Proposal queued for sending" : "Proposal needs approval", result);
});

/*
    @route PATCH /api/v1/proposals/:id
    @desc Record the client's answer (accepted is not "won": contract and payment follow)
*/
router.patch("/proposals/:id", authorize("proposals.write"), validate(z.object({ status: z.literal("rejected") }).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const proposal = await Proposal.findOneAndUpdate(
        { organizationId: ctx.organizationId, _id: oid(req.params.id), status: "sent" },
        { status: req.body.status }, { new: true },
    ).lean();
    if (!proposal) throw new Conflict("Only sent proposals can be accepted or rejected");
    await Lead.updateOne({ organizationId: ctx.organizationId, _id: proposal.leadId }, { opportunityStage: req.body.status === "accepted" ? "negotiation" : "lost" });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: `proposal.${req.body.status}`, targetType: "proposal", targetId: proposal._id.toString(), outcome: "success" });
    return Ok(res, "Proposal updated", { proposal });
});

export default router;
