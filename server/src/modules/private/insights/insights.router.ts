// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import Lead from "../../../shared/models/lead.model.js";
import Message from "../../../shared/models/message.model.js";
import Approval from "../../../shared/models/approval.model.js";
import Workflow from "../../../shared/models/workflow.model.js";
import UsageRecord from "../../../shared/models/usageRecord.model.js";
import AuditEvent from "../../../shared/models/auditEvent.model.js";
import Suppression from "../../../shared/models/suppression.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { getCurrentPolicy, normalizeEmail, startOfUtcDay, suppressEmail } from "../../../shared/policy/policy.service.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { nextCursor, oid, pageParams, str } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import NotFound from "../../../shared/errors/NotFound.error.js";

const router = express.Router();

/*
    @route GET /api/v1/dashboard
    @desc Pipeline, activity and outcome metrics (business outcomes, not email volume)
*/
router.get("/dashboard", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const organizationId = ctx.organizationId;
    const since7d = new Date(Date.now() - 7 * 24 * 3600_000);

    const [stages, qualification, pendingApprovals, sent7d, replies7d, running, failed7d, usageToday, recent] = await Promise.all([
        Lead.aggregate([{ $match: { organizationId } }, { $group: { _id: "$opportunityStage", count: { $sum: 1 } } }]),
        Lead.aggregate([{ $match: { organizationId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        Approval.countDocuments({ organizationId, status: "pending" }),
        Message.countDocuments({ organizationId, direction: "outbound", status: "sent", sentAt: { $gte: since7d } }),
        Message.countDocuments({ organizationId, direction: "inbound", createdAt: { $gte: since7d } }),
        Workflow.countDocuments({ organizationId, status: { $in: ["queued", "running"] } }),
        Workflow.countDocuments({ organizationId, status: "failed", updatedAt: { $gte: since7d } }),
        UsageRecord.countDocuments({ organizationId, kind: "llm", createdAt: { $gte: startOfUtcDay() } }),
        AuditEvent.find({ organizationId }).sort({ createdAt: -1 }).limit(12).lean(),
    ]);
    const { config } = await getCurrentPolicy(organizationId);
    const toMap = (rows: { _id: string | null; count: number }[]) => Object.fromEntries(rows.map((r) => [r._id ?? "unknown", r.count]));
    const qualified = toMap(qualification);
    const totalLeads = Object.values(toMap(stages)).reduce((a, b) => a + b, 0);

    return Ok(res, "Dashboard", {
        totalLeads,
        stages: toMap(stages),
        qualification: qualified,
        qualifiedRate: totalLeads ? Math.round(((qualified.qualified ?? 0) / totalLeads) * 100) : 0,
        pendingApprovals,
        sent7d,
        replies7d,
        replyRate: sent7d ? Math.round((replies7d / sent7d) * 100) : 0,
        runningWorkflows: running,
        failedWorkflows7d: failed7d,
        aiCallsToday: usageToday,
        aiBudgetPerDay: config.budgets.maxLlmCallsPerDay,
        recent,
    });
});

/*
    @route GET /api/v1/usage/summary
    @desc AI usage by agent and model for the last 30 days
*/
router.get("/usage/summary", authorize("usage.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const match = { $match: { organizationId: ctx.organizationId, kind: "llm", createdAt: { $gte: since } } };
    const sum = { calls: { $sum: 1 }, inputTokens: { $sum: "$inputTokens" }, outputTokens: { $sum: "$outputTokens" }, costMinor: { $sum: "$costMinor" } };
    const [byAgent, byModel, byDay] = await Promise.all([
        UsageRecord.aggregate([match, { $group: { _id: "$agent", ...sum } }, { $sort: { calls: -1 } }]),
        UsageRecord.aggregate([match, { $group: { _id: "$model", ...sum } }, { $sort: { calls: -1 } }]),
        UsageRecord.aggregate([match, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, ...sum } }, { $sort: { _id: 1 } }]),
    ]);
    return Ok(res, "Usage", { byAgent, byModel, byDay });
});

/*
    @route GET /api/v1/audit-events
*/
router.get("/audit-events", authorize("audit.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const { limit, cursorFilter } = pageParams(req.query);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId, ...cursorFilter };
    const action = str(req.query.action);
    if (action) filter.action = action.slice(0, 60);
    const events = await AuditEvent.find(filter).sort({ _id: -1 }).limit(limit).lean();
    return Ok(res, "Audit events", { events, nextCursor: nextCursor(events, limit) });
});

/*
    @route GET /api/v1/suppressions
*/
router.get("/suppressions", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const suppressions = await Suppression.find({ organizationId: ctx.organizationId }).sort({ createdAt: -1 }).limit(500).lean();
    return Ok(res, "Suppressions", { suppressions });
});

/*
    @route POST /api/v1/suppressions
    @desc Add an address to the do-not-contact list
*/
router.post("/suppressions", authorize("leads.write"), validate(z.object({ value: z.string().trim().email() }).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const value = normalizeEmail(req.body.value);
    await suppressEmail(ctx.organizationId, value, "manual", `user:${ctx.userId}`);
    await Message.updateMany({ organizationId: ctx.organizationId, to: value, direction: "outbound", status: { $in: ["queued", "pending_approval"] } }, { status: "rejected", error: "Recipient suppressed" });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "suppression.add", outcome: "success", metadata: { value } });
    return Created(res, "Suppressed");
});

/*
    @route DELETE /api/v1/suppressions/:id
    @desc Remove a manual suppression (opt-outs can only be lifted by an owner/admin)
*/
router.delete("/suppressions/:id", authorize("leads.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const s = await Suppression.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!s) throw new NotFound("Suppression not found");
    if (s.reason !== "manual" && !["owner", "admin"].includes(ctx.role)) {
        return res.status(403).json({ success: false, status: 403, message: "Only owners or admins can lift an opt-out" });
    }
    await Suppression.deleteOne({ organizationId: ctx.organizationId, _id: s._id });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "suppression.remove", outcome: "success", metadata: { value: s.value, reason: s.reason } });
    return Ok(res, "Removed");
});

export default router;
