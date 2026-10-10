// Importing modules
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import Workflow from "../../../shared/models/workflow.model.js";
import AgentTask from "../../../shared/models/agentTask.model.js";
import UsageRecord from "../../../shared/models/usageRecord.model.js";
import ImportJob from "../../../shared/models/importJob.model.js";
import Lead from "../../../shared/models/lead.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import { startWorkflow } from "../../../shared/workflows/workflow.service.js";
import { nextCursor, oid, pageParams, str } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

const RESEARCH_TYPES = ["lead.research", "lead.pipeline"];

// token usage per workflow, for the research activity view
async function usageFor(organizationId: mongoose.Types.ObjectId, workflowIds: mongoose.Types.ObjectId[]) {
    const rows = await UsageRecord.aggregate([
        { $match: { organizationId, kind: "llm", workflowId: { $in: workflowIds } } },
        { $group: { _id: "$workflowId", calls: { $sum: 1 }, inputTokens: { $sum: "$inputTokens" }, outputTokens: { $sum: "$outputTokens" } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), { calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens }]));
}

/*
    @route GET /api/v1/research-jobs
    @desc Research activity: queued, running, completed and failed jobs with usage and failure reasons
*/
router.get("/research-jobs", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const { limit, cursorFilter } = pageParams(req.query);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId, type: { $in: RESEARCH_TYPES }, ...cursorFilter };
    const status = str(req.query.status);
    if (status && ["queued", "running", "completed", "failed", "cancelled", "waiting_approval"].includes(status)) filter.status = status;
    const jobs = await Workflow.find(filter, { input: 0, resume: 0 }).sort({ _id: -1 }).limit(limit).lean();
    const usage = await usageFor(ctx.organizationId, jobs.map((j) => j._id));
    const leads = await Lead.find({ organizationId: ctx.organizationId, _id: { $in: jobs.map((j) => j.entityId) } }, { "company.name": 1, status: 1 }).lean();
    return Ok(res, "Research jobs", {
        jobs: jobs.map((j) => ({ ...j, usage: usage.get(String(j._id)) ?? null, lead: leads.find((l) => l._id.equals(j.entityId)) ?? null })),
        nextCursor: nextCursor(jobs, limit),
    });
});

/*
    @route GET /api/v1/research-jobs/:id
*/
router.get("/research-jobs/:id", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const job = await Workflow.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id), type: { $in: RESEARCH_TYPES } }, { input: 0, resume: 0 }).lean();
    if (!job) throw new NotFound("Research job not found");
    const [tasks, usage] = await Promise.all([
        AgentTask.find({ organizationId: ctx.organizationId, workflowId: job._id }).sort({ createdAt: 1 }).lean(),
        usageFor(ctx.organizationId, [job._id]),
    ]);
    return Ok(res, "Research job", { job: { ...job, usage: usage.get(String(job._id)) ?? null }, tasks });
});

/*
    @route POST /api/v1/research-jobs/:id/retry
    @desc Retry a failed job as a new job (a new request time, so it may supersede older results)
*/
router.post("/research-jobs/:id/retry", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const job = await Workflow.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id), type: { $in: RESEARCH_TYPES } }).lean();
    if (!job) throw new NotFound("Research job not found");
    if (job.status !== "failed") throw new Conflict("Only failed jobs can be retried");
    const { workflow } = await startWorkflow({
        organizationId: ctx.organizationId, type: "lead.research", entityType: "lead", entityId: job.entityId,
        idempotencyKey: `retry:${job._id}`, startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
    });
    await Lead.updateOne({ organizationId: ctx.organizationId, _id: job.entityId }, { status: "research_queued" });
    return ApiResponse(res, 202, "Retry queued", { jobId: workflow._id, status: workflow.status, leadId: job.entityId });
});

/*
    @route GET /api/v1/pipeline/summary
    @desc Lead counts per status plus average fit and evidence coverage
*/
router.get("/pipeline/summary", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const [byStatus, averages] = await Promise.all([
        Lead.aggregate([{ $match: { organizationId: ctx.organizationId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        Lead.aggregate([
            { $match: { organizationId: ctx.organizationId, "qualification.score": { $type: "number" } } },
            { $group: { _id: null, avgScore: { $avg: "$qualification.score" }, avgCoverage: { $avg: "$qualification.evidenceCoverage" }, researched: { $sum: 1 } } },
        ]),
    ]);
    const counts = Object.fromEntries(byStatus.map((r) => [r._id ?? "new", r.count]));
    const total = Object.values(counts).reduce((a: number, b) => a + (b as number), 0);
    return Ok(res, "Pipeline summary", {
        total, counts,
        researched: averages[0]?.researched ?? 0,
        averageScore: averages[0] ? Math.round(averages[0].avgScore) : null,
        averageEvidenceCoverage: averages[0]?.avgCoverage != null ? Math.round(averages[0].avgCoverage) : null,
        qualifiedRate: total ? Math.round(((counts.qualified ?? 0) / total) * 100) : 0,
    });
});

/*
    @route GET /api/v1/imports
*/
router.get("/imports", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const imports = await ImportJob.find({ organizationId: ctx.organizationId }, { rowErrors: 0 }).sort({ createdAt: -1 }).limit(25).lean();
    return Ok(res, "Imports", { imports });
});

/*
    @route GET /api/v1/imports/:id
    @desc Import progress, counts and the first errors
*/
router.get("/imports/:id", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const job = await ImportJob.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }, { rowErrors: { $slice: 50 } }).lean();
    if (!job) throw new NotFound("Import not found");
    return Ok(res, "Import", { job });
});

// CSV cell: quoted, and never interpretable as a spreadsheet formula
const cell = (v: unknown) => {
    const s = String(v ?? "");
    return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, "\"\"")}"`;
};

/*
    @route GET /api/v1/imports/:id/errors.csv
    @desc Downloadable row-level error report
*/
router.get("/imports/:id/errors.csv", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const job = await ImportJob.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!job) throw new NotFound("Import not found");
    const lines = [["row", "type", "company", "email", "error"].join(","), ...job.rowErrors.map((e) => [e.row, e.kind, e.company, e.email, e.message].map(cell).join(","))];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="import-${job._id}-errors.csv"`);
    return res.send(lines.join("\r\n"));
});

export default router;
