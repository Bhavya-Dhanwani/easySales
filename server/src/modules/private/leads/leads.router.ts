// Importing modules
import { canTransition } from "../../../shared/sales/engine.js";
import { assertQuota } from "../../../shared/billing/subscription.service.js";
import { recordDiscoveredImport, recordStage } from "../../../shared/analytics/analytics.service.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import Lead, { CONSENT_BASES, LEAD_STATUSES, OPPORTUNITY_STAGES, leadDedupeKey } from "../../../shared/models/lead.model.js";
import Conversation from "../../../shared/models/conversation.model.js";
import Message from "../../../shared/models/message.model.js";
import Workflow from "../../../shared/models/workflow.model.js";
import Proposal from "../../../shared/models/proposal.model.js";
import Approval from "../../../shared/models/approval.model.js";
import BusinessProfile from "../../../shared/models/businessProfile.model.js";
import ImportJob from "../../../shared/models/importJob.model.js";
import UsageRecord from "../../../shared/models/usageRecord.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { activeWorkflowFor, startWorkflow } from "../../../shared/workflows/workflow.service.js";
import { getCurrentPolicy, normalizeEmail } from "../../../shared/policy/policy.service.js";
import { requalify } from "../../../shared/research/research.service.js";
import { createProposal } from "../../../shared/proposals/proposal.service.js";
import { discoverLeads, nextNicheQueries, nicheOf, webSearchEnabled } from "../../../shared/discovery/discovery.service.js";
import { escapeRegex, nextCursor, oid, pageParams, str } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

// spreadsheet formula injection: imported text must never start a formula
export const defuse = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? defuse(v) : undefined));

const LeadInputSchema = z.object({
    companyName: z.string().trim().min(1).max(200).transform(defuse),
    website: z.union([z.literal(""), z.string().trim().max(500)]).optional(),
    industry: optionalText(120),
    size: optionalText(60),
    employeeCount: z.union([z.literal(""), z.coerce.number().int().min(0).max(10_000_000)]).optional().transform((v) => (v === "" ? undefined : v)),
    country: optionalText(80),
    description: optionalText(2000),
    contactName: optionalText(120),
    contactTitle: optionalText(120),
    contactEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
    contactPhone: optionalText(40),
    consentBasis: z.enum(CONSENT_BASES).default("none"),
    consentSource: optionalText(200),
});
type LeadInput = z.infer<typeof LeadInputSchema>;

// normalizes a website into a URL + bare domain (used for deduplication)
export function normalizeWebsite(raw?: string) {
    if (!raw) return { website: undefined, domain: undefined };
    try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".")) return { website: undefined, domain: undefined };
        return { website: url.origin, domain: url.hostname.replace(/^www\./, "").toLowerCase() };
    } catch {
        return { website: undefined, domain: undefined };
    }
}

function toLeadDoc(input: LeadInput, provider: "csv" | "manual" | "discovery") {
    const { website, domain } = normalizeWebsite(input.website);
    const doc = {
        company: { name: input.companyName, website, domain, industry: input.industry, size: input.size, employeeCount: input.employeeCount, country: input.country, description: input.description },
        contact: { name: input.contactName, title: input.contactTitle, email: input.contactEmail ? normalizeEmail(input.contactEmail) : undefined, phone: input.contactPhone },
        consent: { basis: input.consentBasis, source: input.consentSource, recordedAt: input.consentBasis !== "none" ? new Date() : undefined },
        source: { provider, importedAt: new Date() },
    };
    return { ...doc, dedupeKey: leadDedupeKey(doc) };
}

const isoDate = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
const scoreParam = (v: unknown) => (typeof v === "string" && /^\d{1,3}$/.test(v) ? Math.min(100, Number(v)) : undefined);

/*
    @route GET /api/v1/leads
    @desc Search leads: status, stage, industry, country, score range, owner, created range, text; cursor pagination.
          Every filter value is validated or escaped, so client input can never become a Mongo operator.
*/
router.get("/", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const q = req.query;
    const { limit, cursorFilter } = pageParams(q);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId, ...cursorFilter };

    const status = str(q.status);
    if (status && (LEAD_STATUSES as readonly string[]).includes(status)) filter.status = status;
    const stage = str(q.stage);
    if (stage && (OPPORTUNITY_STAGES as readonly string[]).includes(stage)) filter.opportunityStage = stage;
    for (const [param, field] of [["industry", "company.industry"], ["country", "company.country"]] as const) {
        const v = str(q[param])?.trim().slice(0, 80);
        if (v) filter[field] = new RegExp(`^${escapeRegex(v)}$`, "i");
    }
    const min = scoreParam(q.minScore), max = scoreParam(q.maxScore);
    if (min !== undefined || max !== undefined) filter["qualification.score"] = { ...(min !== undefined && { $gte: min }), ...(max !== undefined && { $lte: max }) };
    const assignedTo = str(q.assignedTo);
    if (assignedTo && mongoose.isValidObjectId(assignedTo)) filter.ownerId = new mongoose.Types.ObjectId(assignedTo);
    const after = isoDate(q.createdAfter), before = isoDate(q.createdBefore);
    if (after || before) filter.createdAt = { ...(after && { $gte: after }), ...(before && { $lte: before }) };
    const search = str(q.q ?? q.search)?.trim().slice(0, 100);
    if (search) {
        const rx = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ "company.name": rx }, { "contact.email": rx }, { "contact.name": rx }, { "company.domain": rx }];
    }

    const leads = await Lead.find(filter, { "research.evidence": 0, "qualification.criteria": 0 }).sort({ _id: -1 }).limit(limit).lean();
    return Ok(res, "Leads", { leads, nextCursor: nextCursor(leads, limit) });
});

/*
    @route POST /api/v1/leads
*/
router.post("/", authorize("leads.write"), validate(LeadInputSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const doc = toLeadDoc(req.body, "manual");
    if (await Lead.exists({ organizationId: ctx.organizationId, dedupeKey: doc.dedupeKey })) throw new Conflict("This lead already exists");
    const lead = await Lead.create({ organizationId: ctx.organizationId, ...doc, ownerId: ctx.userId });
    await recordStage(ctx.organizationId, lead._id, "discovered", { source: "manual" });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lead.create", targetType: "lead", targetId: lead._id.toString(), outcome: "success" });
    return Created(res, "Lead created", { lead });
});

/*
    @route GET /api/v1/leads/discover/niche
    @desc The search terms and areas lead search is locked to
*/
router.get("/discover/niche", authorize("leads.read"), async (req: Request, res: Response) => {
    const { searchTerms, searchAreas } = await nicheOf(ctxOf(req).organizationId);
    return Ok(res, "Search niche", { niche: { searchTerms, searchAreas }, webSearch: webSearchEnabled() });
});

/*
    @route POST /api/v1/leads/discover
    @desc Search OpenStreetMap ("dentist" in "Pune"), locked to the profile's search terms and areas,
          deduplicated, disqualifiers dropped, leads already in the pipeline marked. Nothing is saved: chosen candidates go through /import (source "discovery").
*/
router.post("/discover", authorize("leads.write"), validate(z.object({
    what: z.string().trim().min(2).max(100).optional(),
    where: z.string().trim().min(2).max(100).optional(),
    // the agent picks the least recently searched term x area pairs of the niche itself
    auto: z.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict().refine((b) => b.auto || (b.what && b.where), "Give a search term and an area, or use auto")), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const queries = req.body.auto ? await nextNicheQueries(ctx.organizationId, 3) : [{ what: req.body.what, where: req.body.where }];
    return Ok(res, "Lead search finished", await discoverLeads(ctx.organizationId, { type: "user", id: ctx.userId }, { queries, limit: req.body.limit }));
});

/*
    Imports mapped rows as a tracked ImportJob: validation, in-file and existing duplicates, a unique
    index as the final arbiter under concurrency, row-level error report, optional research.
    Used by CSV upload, Find leads and the daily lead finder (userId null = the agent).
*/
export async function importRows(organizationId: mongoose.Types.ObjectId, userId: string | null, rows: unknown[], opts: { idempotencyKey: string; fileName?: string; source: "csv" | "discovery"; research: boolean }) {
    const job = await ImportJob.create({ organizationId, idempotencyKey: opts.idempotencyKey, fileName: opts.fileName, totalRows: rows.length, createdBy: userId ?? undefined });
    const rowErrors: { row: number; kind: "invalid" | "duplicate"; message: string; company?: string; email?: string }[] = [];
    const seen = new Set<string>();
    const docs: (ReturnType<typeof toLeadDoc> & { row: number })[] = [];

    rows.forEach((raw, i) => {
        const parsed = LeadInputSchema.safeParse(raw);
        const r = (raw ?? {}) as Record<string, unknown>;
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            rowErrors.push({ row: i + 1, kind: "invalid", message: `${issue.path.join(".")}: ${issue.message}`, company: String(r.companyName ?? "").slice(0, 200), email: String(r.contactEmail ?? "").slice(0, 200) });
            return;
        }
        const doc = toLeadDoc(parsed.data, opts.source);
        if (seen.has(doc.dedupeKey)) {
            rowErrors.push({ row: i + 1, kind: "duplicate", message: "Duplicate within file", company: doc.company.name, email: doc.contact.email });
            return;
        }
        seen.add(doc.dedupeKey);
        docs.push({ ...doc, row: i + 1 });
    });

    const existingKeys = new Set((await Lead.find({ organizationId: organizationId, dedupeKey: { $in: [...seen] } }, { dedupeKey: 1 }).lean()).map((l) => l.dedupeKey));
    const fresh = docs.filter((d) => {
        if (!existingKeys.has(d.dedupeKey)) return true;
        rowErrors.push({ row: d.row, kind: "duplicate", message: "Already in your leads", company: d.company.name, email: d.contact.email });
        return false;
    });

    // the unique index is the final arbiter under concurrency: a lost race is a duplicate, not an error
    let created = 0;
    let createdIds: mongoose.Types.ObjectId[] = [];
    if (fresh.length) {
        try {
            const result = await Lead.insertMany(
                fresh.map(({ row: _row, ...d }) => ({ organizationId: organizationId, ...d, source: { ...d.source, importId: job._id }, ownerId: userId ?? undefined })),
                { ordered: false },
            );
            created = result.length;
            createdIds = result.map((l) => l._id);
        } catch (error) {
            const e = error as { code?: number; insertedDocs?: unknown[]; writeErrors?: { index?: number; err?: { index?: number } }[] };
            if (!e.writeErrors && e.code !== 11000) throw error;
            created = e.insertedDocs?.length ?? 0;
            createdIds = ((e.insertedDocs ?? []) as { _id: mongoose.Types.ObjectId }[]).map((l) => l._id);
            for (const w of e.writeErrors ?? []) {
                const d = fresh[w.index ?? w.err?.index ?? -1];
                if (d) rowErrors.push({ row: d.row, kind: "duplicate", message: "Already in your leads", company: d.company.name, email: d.contact.email });
            }
        }
    }

    if (created) await recordDiscoveredImport(organizationId, job._id);
    if (opts.research) {
        for (const leadId of createdIds) {
            await startWorkflow({
                organizationId: organizationId, type: "lead.research", entityType: "lead", entityId: leadId,
                idempotencyKey: `research:${leadId}:import`, startedBy: userId ?? undefined, actor: userId ? { type: "user", id: userId } : { type: "system", id: "lead_finder" },
            });
        }
        if (createdIds.length) await Lead.updateMany({ organizationId: organizationId, _id: { $in: createdIds } }, { status: "research_queued" });
    }
    rowErrors.sort((a, b) => a.row - b.row);
    const invalidRows = rowErrors.filter((e) => e.kind === "invalid").length;
    const duplicateRows = rowErrors.length - invalidRows;
    const done = await ImportJob.findOneAndUpdate({ organizationId: organizationId, _id: job._id }, {
        status: invalidRows ? "completed_with_errors" : "completed", createdRows: created, invalidRows, duplicateRows,
        rowErrors, completedAt: new Date(),
    }, { new: true, projection: { rowErrors: 0 } }).lean();
    await audit({ organizationId: organizationId, actorType: userId ? "user" : "agent", actorId: userId ?? "lead_finder", action: "lead.import", targetType: "import", targetId: job._id.toString(), outcome: "success", metadata: { created, duplicateRows, invalidRows } });
    return done;
}

/*
    @route POST /api/v1/leads/import
    @desc Import mapped CSV rows as a tracked ImportJob. Safe to retry (Idempotency-Key) and safe under
          concurrent uploads (unique dedupe key per tenant). Row-level errors are kept for the error report.
*/
router.post("/import", authorize("leads.write"), validate(z.object({
    fileName: z.string().trim().max(200).optional(),
    rows: z.array(z.unknown()).min(1).max(2000),
    source: z.enum(["csv", "discovery"]).default("csv"),
    // queue research for the new leads right away (discovered leads need it to find a contact email)
    research: z.boolean().default(false),
})), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const idempotencyKey = str(req.header("idempotency-key"))?.slice(0, 100) ?? new mongoose.Types.ObjectId().toString();
    const existing = await ImportJob.findOne({ organizationId: ctx.organizationId, idempotencyKey }, { rowErrors: 0 }).lean();
    if (existing) return Ok(res, "Import already processed", { job: existing });

    const job = await importRows(ctx.organizationId, ctx.userId, req.body.rows, { idempotencyKey, fileName: req.body.fileName, source: req.body.source, research: req.body.research });
    return Created(res, "Import finished", { job });
});

/*
    @route POST /api/v1/leads/bulk-research
    @desc Queue research for selected leads (max 100). dryRun returns the estimate shown before confirming.
*/
router.post("/bulk-research", authorize("workflows.run"), validate(z.object({
    leadIds: z.array(z.string().refine((v) => mongoose.isValidObjectId(v), "Invalid id")).min(1).max(100),
    dryRun: z.boolean().default(false),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const ids = [...new Set(req.body.leadIds as string[])].map((id) => new mongoose.Types.ObjectId(id));
    // ids from other tenants simply do not match
    const leads = await Lead.find({ organizationId: ctx.organizationId, _id: { $in: ids } }, { status: 1 }).lean();
    const eligible = leads.filter((l) => !["research_queued", "researching"].includes(l.status));

    if (req.body.dryRun) {
        const [usage] = await UsageRecord.aggregate([
            { $match: { organizationId: ctx.organizationId, agent: "research" } },
            { $group: { _id: null, calls: { $sum: 1 }, tokens: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } },
        ]);
        const { config } = await getCurrentPolicy(ctx.organizationId);
        return Ok(res, "Estimate", {
            requested: ids.length, found: leads.length, eligible: eligible.length,
            estimatedAiCalls: eligible.length,
            estimatedTokens: usage?.calls ? Math.round((usage.tokens / usage.calls) * eligible.length) : null,
            dailyBudget: config.budgets.maxLlmCallsPerDay,
        });
    }

    const jobs: string[] = [];
    for (const lead of eligible) {
        const { workflow } = await startWorkflow({
            organizationId: ctx.organizationId, type: "lead.research", entityType: "lead", entityId: lead._id,
            idempotencyKey: `research:${lead._id}:${new mongoose.Types.ObjectId()}`, startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
        });
        jobs.push(String(workflow._id));
    }
    await Lead.updateMany({ organizationId: ctx.organizationId, _id: { $in: eligible.map((l) => l._id) } }, { status: "research_queued" });
    return ApiResponse(res, 202, `${jobs.length} research jobs queued`, { queued: jobs.length, skipped: ids.length - jobs.length, jobIds: jobs });
});

/*
    @route GET /api/v1/leads/:id
    @desc Lead with its conversation, messages, workflows, proposals and approvals
*/
router.get("/:id", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const scope = { organizationId: ctx.organizationId };
    const lead = await Lead.findOne({ ...scope, _id: oid(req.params.id) }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const [conversation, workflows, proposals, approvals] = await Promise.all([
        Conversation.findOne({ ...scope, leadId: lead._id }).lean(),
        Workflow.find({ ...scope, entityId: lead._id }).sort({ createdAt: -1 }).limit(10).lean(),
        Proposal.find({ ...scope, leadId: lead._id }).sort({ createdAt: -1 }).lean(),
        Approval.find({ ...scope, leadId: lead._id, status: "pending" }).lean(),
    ]);
    const messages = conversation ? await Message.find({ ...scope, conversationId: conversation._id }).sort({ createdAt: 1 }).lean() : [];
    return Ok(res, "Lead", { lead, conversation, messages, workflows, proposals, approvals });
});

/*
    @route POST /api/v1/leads/:id/research
    @desc Queue research (or refresh it). 202 with the job id; Idempotency-Key makes retries safe.
*/
router.post("/:id/research", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await assertQuota(ctx.organizationId, "research");
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }, { status: 1 }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const active = await activeWorkflowFor(ctx.organizationId, lead._id, "lead.research");
    if (active) return ApiResponse(res, 202, "Research already queued", { jobId: active._id, status: active.status, leadId: lead._id });
    const key = str(req.header("idempotency-key"))?.slice(0, 100);
    const { workflow } = await startWorkflow({
        organizationId: ctx.organizationId, type: "lead.research", entityType: "lead", entityId: lead._id,
        idempotencyKey: key ? `client:${key}` : `research:${lead._id}:${new mongoose.Types.ObjectId()}`,
        startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
        // ?force=true refreshes even when stored research is still fresh (otherwise it is re-scored for free)
        input: { force: req.query.force === "true" },
    });
    await Lead.updateOne({ organizationId: ctx.organizationId, _id: lead._id, status: { $ne: "researching" } }, { status: "research_queued" });
    return ApiResponse(res, 202, "Research queued", { jobId: workflow._id, status: workflow.status, leadId: lead._id });
});

/*
    @route GET /api/v1/leads/:id/research
    @desc Latest research report with its qualification breakdown
*/
router.get("/:id/research", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }, { research: 1, qualification: 1, status: 1 }).lean();
    if (!lead) throw new NotFound("Lead not found");
    return Ok(res, "Research", { status: lead.status, research: lead.research, qualification: lead.qualification });
});

/*
    @route POST /api/v1/leads/:id/qualify
    @desc Re-score the existing research against the current ICP weights and thresholds (no AI call)
*/
router.post("/:id/qualify", authorize("leads.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const result = await requalify(ctx.organizationId, oid(req.params.id), ctx.userId);
    return Ok(res, "Re-qualified", result);
});

const UpdateLeadSchema = z.object({
    opportunityStage: z.enum(OPPORTUNITY_STAGES).optional(),
    contact: z.object({
        name: optionalText(120), title: optionalText(120),
        email: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
        phone: optionalText(40),
    }).optional(),
    consent: z.object({ basis: z.enum(CONSENT_BASES), source: optionalText(200) }).optional(),
    status: z.enum(["qualified", "needs_review", "disqualified"]).optional(),
}).strict();

/*
    @route PATCH /api/v1/leads/:id
*/
router.patch("/:id", authorize("leads.write"), validate(UpdateLeadSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!lead) throw new NotFound("Lead not found");
    const body = req.body as z.infer<typeof UpdateLeadSchema>;
    // "won" is reached only through the handoff of an accepted proposal, never by a status edit
    if (body.opportunityStage && !canTransition(lead.opportunityStage, body.opportunityStage, "user")) {
        throw new Conflict(body.opportunityStage === "won" ? "Record the accepted proposal and hand the deal over to mark it won" : `Cannot move from ${lead.opportunityStage} to ${body.opportunityStage}`);
    }
    if (body.opportunityStage) lead.opportunityStage = body.opportunityStage;
    if (body.contact) {
        for (const [k, v] of Object.entries(body.contact)) lead.set(`contact.${k}`, v || undefined);
    }
    if (body.consent) lead.set("consent", { ...body.consent, recordedAt: new Date() });
    // a human override of the computed qualification, recorded on the lead and in the audit log
    if (body.status) {
        lead.status = body.status;
        lead.set("qualification.overriddenBy", ctx.userId);
    }
    await lead.save();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lead.update", targetType: "lead", targetId: lead._id.toString(), outcome: "success", metadata: body });
    return Ok(res, "Lead updated", { lead });
});

/*
    @route DELETE /api/v1/leads/:id
    @desc Delete a lead and its conversation history
*/
router.delete("/:id", authorize("leads.write"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const scope = { organizationId: ctx.organizationId };
    const id = oid(req.params.id);
    const lead = await Lead.findOne({ ...scope, _id: id }).lean();
    if (!lead) throw new NotFound("Lead not found");
    await Message.deleteMany({ ...scope, leadId: id });
    await Conversation.deleteMany({ ...scope, leadId: id });
    await Proposal.deleteMany({ ...scope, leadId: id });
    await Approval.updateMany({ ...scope, leadId: id, status: "pending" }, { status: "expired" });
    await Workflow.updateMany({ ...scope, entityId: id, status: { $in: ["queued", "waiting_approval"] } }, { status: "cancelled" });
    await Lead.deleteOne({ ...scope, _id: id });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lead.delete", targetType: "lead", targetId: id.toString(), outcome: "success" });
    return Ok(res, "Lead deleted");
});

/*
    @route POST /api/v1/leads/:id/run
    @desc Start the AI pipeline: research -> qualify -> outreach (202 Accepted)
*/
router.post("/:id/run", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const active = await activeWorkflowFor(ctx.organizationId, lead._id, "lead.pipeline");
    if (active) return ApiResponse(res, 202, "Pipeline already running", { workflowId: active._id, status: active.status, statusUrl: `/api/v1/workflows/${active._id}` });

    // a client-supplied Idempotency-Key makes retries safe; otherwise one run per completed run count
    const runs = await Workflow.countDocuments({ organizationId: ctx.organizationId, entityId: lead._id, type: "lead.pipeline" });
    const key = str(req.header("idempotency-key"))?.slice(0, 100);
    const { workflow } = await startWorkflow({
        organizationId: ctx.organizationId, type: "lead.pipeline", entityType: "lead", entityId: lead._id,
        idempotencyKey: key ? `client:${key}` : `lead:${lead._id}:pipeline:${runs + 1}`,
        startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
    });
    return ApiResponse(res, 202, "Pipeline queued", { workflowId: workflow._id, status: workflow.status, statusUrl: `/api/v1/workflows/${workflow._id}` });
});

const ProposalRequestSchema = z.object({
    services: z.array(z.string().trim().min(1)).min(1).max(20),
    discountPercent: z.number().min(0).max(100).default(0),
}).strict();

/*
    @route POST /api/v1/leads/:id/proposals
    @desc Same as POST /opportunities/:id/proposals: price deterministically, then the agent writes it (202)
*/
router.post("/:id/proposals", authorize("proposals.write"), validate(ProposalRequestSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const r = await createProposal(ctx.organizationId, oid(req.params.id), req.body, ctx.userId);
    return ApiResponse(res, 202, "Proposal is being written", r);
});

export default router;
