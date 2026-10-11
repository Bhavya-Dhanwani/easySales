// Importing modules
import { variantFor } from "../../../shared/experiments/experiment.service.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Lead from "../../../shared/models/lead.model.js";
import Message from "../../../shared/models/message.model.js";
import Conversation from "../../../shared/models/conversation.model.js";
import Approval from "../../../shared/models/approval.model.js";
import AuditEvent from "../../../shared/models/auditEvent.model.js";
import Membership from "../../../shared/models/membership.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { proposeOutbound } from "../../../shared/outbound/outbound.service.js";
import { cancelPendingOutbound } from "../../../shared/conversations/followups.service.js";
import { suppressEmail } from "../../../shared/policy/policy.service.js";
import { draftOutreach } from "../../../agents/outreach.agent.js";
import { ensureConversation, loadProfile } from "../../../agents/graphs/common.js";
import { oid } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";

const router = express.Router();

/*
    @route POST /api/v1/leads/:id/outreach-drafts
    @desc Generate an evidence-checked draft (saved, not sent). Send it via /outbound-actions/:id/send.
*/
router.post("/leads/:id/outreach-drafts", authorize("conversations.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!lead) throw new NotFound("Lead not found");
    if (lead.status !== "qualified") throw new Conflict("Only qualified leads can be contacted");
    if (!lead.contact?.email) throw new BadRequest("Lead has no contact email");
    const conversation = await ensureConversation(String(ctx.organizationId), lead._id);
    const first = !(await Message.exists({ organizationId: ctx.organizationId, conversationId: conversation._id, direction: "outbound", status: { $nin: ["draft", "rejected"] } }));
    const variant = first ? await variantFor(ctx.organizationId, lead._id) : null;
    const email = await draftOutreach({ organizationId: ctx.organizationId }, lead, lead.research ?? {}, await loadProfile(String(ctx.organizationId)),
        first ? { variant: variant ?? undefined } : { followUpNumber: conversation.followUpsSent + 1, previousSubject: conversation.subject ?? undefined });
    if (!conversation.subject) {
        conversation.subject = email.subject;
        await conversation.save();
    }
    const draft = await Message.create({
        organizationId: ctx.organizationId, conversationId: conversation._id, leadId: lead._id, direction: "outbound",
        kind: first ? "outreach" : "follow_up", to: lead.contact.email, subject: email.subject, body: email.body,
        status: "draft", claims: email.claims, idempotencyKey: `draft:${new mongoose.Types.ObjectId()}`,
        experimentId: variant?.experimentId, variantId: variant?.variantId,
    });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "outreach.draft", targetType: "message", targetId: String(draft._id), outcome: "success", metadata: { unverifiedClaims: email.claims.filter((c) => !c.verified).length } });
    return Created(res, "Draft ready", { draft });
});

const outboundOf = async (organizationId: mongoose.Types.ObjectId, id: unknown) => {
    const m = await Message.findOne({ organizationId, _id: oid(id), direction: "outbound" });
    if (!m) throw new NotFound("Outbound action not found");
    return m;
};

/*
    @route GET /api/v1/outbound-actions/:id
    @desc Send status of one outbound message (draft → pending_approval/queued → sent → delivered/bounced)
*/
router.get("/outbound-actions/:id", authorize("conversations.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const action = await outboundOf(ctx.organizationId, req.params.id);
    const approval = action.approvalId ? await Approval.findOne({ organizationId: ctx.organizationId, _id: action.approvalId }, { status: 1, reasons: 1 }).lean() : null;
    return Ok(res, "Outbound action", { action, approval });
});

/*
    @route POST /api/v1/outbound-actions/:id/send
    @desc Ask to send a draft: the policy engine queues it, routes it to approval, or blocks it
*/
router.post("/outbound-actions/:id/send", authorize("conversations.write"), validate(z.object({
    subject: z.string().trim().min(1).max(300).optional(),
    body: z.string().trim().min(1).max(20000).optional(),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const draft = await outboundOf(ctx.organizationId, req.params.id);
    if (draft.status !== "draft") throw new Conflict(`Already ${draft.status}`);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: draft.leadId });
    if (!lead) throw new NotFound("Lead not found");
    const result = await proposeOutbound({
        organizationId: ctx.organizationId, lead, conversationId: draft.conversationId, kind: draft.kind as "outreach" | "follow_up" | "reply",
        subject: req.body.subject ?? draft.subject ?? "", body: req.body.body ?? draft.body, idempotencyKey: draft.idempotencyKey,
        // the person pressing send is accountable, but unverified claims still go to review
        actor: { type: "user", id: ctx.userId }, claims: draft.claims?.map((c) => ({ claim: c.claim ?? "", evidenceUrl: c.evidenceUrl ?? undefined, verified: Boolean(c.verified) })),
    });
    return Ok(res, result.status === "queued" ? "Queued for sending" : result.status === "pending_approval" ? "Sent to review" : "Blocked by policy", result);
});

/*
    @route POST /api/v1/outbound-actions/:id/reconcile
    @desc Resolve an "uncertain" send after checking the provider: delivered → sent; not delivered → queued again
*/
router.post("/outbound-actions/:id/reconcile", authorize("approvals.decide"), validate(z.object({ outcome: z.enum(["was_sent", "not_sent"]) }).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const msg = await outboundOf(ctx.organizationId, req.params.id);
    if (msg.status !== "uncertain") throw new Conflict("Only uncertain sends can be reconciled");
    msg.status = req.body.outcome === "was_sent" ? "sent" : "queued";
    msg.error = req.body.outcome === "was_sent" ? undefined : "Re-queued after reconciliation";
    msg.notBefore = new Date();
    await msg.save();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "message.reconcile", targetType: "message", targetId: String(msg._id), outcome: "success", metadata: { outcome: req.body.outcome } });
    return Ok(res, "Reconciled", { action: msg });
});

const conversationOf = async (organizationId: mongoose.Types.ObjectId, id: unknown) => {
    const c = await Conversation.findOne({ organizationId, _id: oid(id) });
    if (!c) throw new NotFound("Conversation not found");
    return c;
};

/*
    @route GET /api/v1/conversations/:id/messages
*/
router.get("/conversations/:id/messages", authorize("conversations.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const c = await conversationOf(ctx.organizationId, req.params.id);
    return Ok(res, "Messages", { messages: await Message.find({ organizationId: ctx.organizationId, conversationId: c._id }).sort({ createdAt: 1 }).lean() });
});

/*
    @route POST /api/v1/conversations/:id/close
*/
router.post("/conversations/:id/close", authorize("conversations.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const c = await conversationOf(ctx.organizationId, req.params.id);
    if (c.status !== "suppressed") c.status = "closed";
    c.conversationState = "closed";
    c.nextActionAt = undefined;
    await c.save();
    await cancelPendingOutbound(ctx.organizationId, { conversationId: c._id }, "Conversation closed", ["outreach", "follow_up", "reply"]);
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.close", targetType: "conversation", targetId: String(c._id), outcome: "success" });
    return Ok(res, "Conversation closed", { conversation: c });
});

/*
    @route POST /api/v1/conversations/:id/assign
    @desc Hand the thread to a person (stops automated follow-ups). userId omitted = assign to me; null = unassign
*/
router.post("/conversations/:id/assign", authorize("conversations.write"), validate(z.object({ userId: z.string().nullable().optional() }).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const c = await conversationOf(ctx.organizationId, req.params.id);
    const target = req.body.userId === undefined ? ctx.userId : req.body.userId;
    if (target) {
        if (!mongoose.isValidObjectId(target) || !(await Membership.exists({ organizationId: ctx.organizationId, userId: target, status: "active" }))) {
            throw new BadRequest("That person is not a member of this organization");
        }
        c.assignedTo = new mongoose.Types.ObjectId(target);
        c.conversationState = "handoff";
        if (c.status === "needs_review") c.status = "open";
    } else {
        c.assignedTo = undefined;
    }
    await c.save();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.assign", targetType: "conversation", targetId: String(c._id), outcome: "success", metadata: { assignedTo: target } });
    return Ok(res, target ? "Assigned" : "Unassigned", { conversation: c });
});

/*
    @route GET /api/v1/conversations/:id/activity
    @desc Every audited event for the thread and its messages, newest first
*/
router.get("/conversations/:id/activity", authorize("conversations.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const c = await conversationOf(ctx.organizationId, req.params.id);
    const ids = (await Message.find({ organizationId: ctx.organizationId, conversationId: c._id }, { _id: 1 }).lean()).map((m) => String(m._id));
    const events = await AuditEvent.find({ organizationId: ctx.organizationId, targetId: { $in: [...ids, String(c._id), String(c.leadId)] } }).sort({ createdAt: -1 }).limit(200).lean();
    return Ok(res, "Activity", { events });
});

/*
    @route POST /api/v1/recipients/:leadId/suppress
    @desc Suppress a lead's address everywhere and cancel anything pending
*/
router.post("/recipients/:leadId/suppress", authorize("leads.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.leadId) });
    if (!lead?.contact?.email) throw new NotFound("Lead with an email not found");
    await suppressEmail(ctx.organizationId, lead.contact.email, "manual", `user:${ctx.userId}`);
    await cancelPendingOutbound(ctx.organizationId, { leadId: lead._id }, "Recipient suppressed", ["outreach", "follow_up", "reply", "proposal"]);
    await Conversation.updateMany({ organizationId: ctx.organizationId, leadId: lead._id }, { status: "suppressed", $unset: { nextActionAt: 1 } });
    lead.outreachStatus = "opted_out";
    await lead.save();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "suppression.add", targetType: "lead", targetId: String(lead._id), outcome: "success" });
    return Ok(res, "Recipient suppressed");
});

/*
    @route GET /api/v1/review-queue
    @desc Everything waiting on a human: approvals, escalated threads, uncertain sends, recent policy blocks
*/
router.get("/review-queue", authorize("approvals.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const scope = { organizationId: ctx.organizationId };
    const [approvals, threads, uncertain, blocked] = await Promise.all([
        Approval.countDocuments({ ...scope, status: "pending" }),
        Conversation.find({ ...scope, status: "needs_review" }).sort({ lastMessageAt: -1 }).limit(50).lean(),
        Message.find({ ...scope, status: "uncertain" }).sort({ updatedAt: -1 }).limit(50).lean(),
        Message.find({ ...scope, direction: "outbound", status: "rejected", updatedAt: { $gte: new Date(Date.now() - 7 * 86400_000) } }).sort({ updatedAt: -1 }).limit(50).lean(),
    ]);
    const leadIds = [...threads, ...uncertain, ...blocked].map((x) => x.leadId);
    const leads = await Lead.find({ ...scope, _id: { $in: leadIds } }, { company: 1, contact: 1 }).lean();
    const withLead = <T extends { leadId: mongoose.Types.ObjectId }>(xs: T[]) => xs.map((x) => ({ ...x, lead: leads.find((l) => l._id.equals(x.leadId)) ?? null }));
    return Ok(res, "Review queue", { approvals, threads: withLead(threads), uncertain: withLead(uncertain), blocked: withLead(blocked) });
});

export default router;
