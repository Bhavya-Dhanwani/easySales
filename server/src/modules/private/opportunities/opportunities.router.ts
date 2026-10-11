// Importing modules
import { recordStage } from "../../../shared/analytics/analytics.service.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import Lead from "../../../shared/models/lead.model.js";
import Requirements from "../../../shared/models/requirements.model.js";
import Prototype from "../../../shared/models/prototype.model.js";
import Proposal from "../../../shared/models/proposal.model.js";
import Message from "../../../shared/models/message.model.js";
import AuditEvent from "../../../shared/models/auditEvent.model.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { startWorkflow } from "../../../shared/workflows/workflow.service.js";
import { getCurrentPolicy } from "../../../shared/policy/policy.service.js";
import { latestRequirements, saveRequirementsVersion } from "../../../shared/requirements/requirements.service.js";
import { RequirementsSchema } from "../../../agents/requirements.agent.js";
import { TEMPLATES } from "../../../shared/prototypes/templates.js";
import {
    cancelPrototype, expirePrototype, monthSpentMinor, publishPrototype, requestPrototype, retryPrototype,
} from "../../../shared/prototypes/prototype.service.js";
import {
    createProposal, recordAcceptance, reviseProposal, submitForApproval, validateProposal,
} from "../../../shared/proposals/proposal.service.js";
import { oid, str } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

// the opportunity is the lead; every handler scopes it to the caller's organization first
async function opportunity(req: Request) {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!lead) throw new NotFound("Opportunity not found");
    return { ctx, lead };
}

async function ownPrototype(req: Request) {
    const ctx = ctxOf(req);
    const prototype = await Prototype.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!prototype) throw new NotFound("Prototype not found");
    return { ctx, prototype };
}

/* --------------------------- workspace --------------------------- */

/*
    @route GET /api/v1/opportunities/:id
    @desc Requirements, prototypes, proposal versions and budget for one opportunity
*/
router.get("/opportunities/:id", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { ctx, lead } = await opportunity(req);
    const org = ctx.organizationId;
    const [requirements, versions, prototypes, proposals, spent, { config }] = await Promise.all([
        latestRequirements(org, lead._id),
        Requirements.find({ organizationId: org, opportunityId: lead._id }, { requirements: 0 }).sort({ version: -1 }).limit(50).lean(),
        Prototype.find({ organizationId: org, opportunityId: lead._id }).sort({ createdAt: -1 }).limit(20).lean(),
        Proposal.find({ organizationId: org, leadId: lead._id }).sort({ version: -1 }).limit(50).lean(),
        monthSpentMinor(org),
        getCurrentPolicy(org),
    ]);
    const templates = Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name }));
    return Ok(res, "Opportunity", {
        lead, requirements, requirementVersions: versions, prototypes, proposals, templates,
        budget: { monthSpentMinor: spent, monthlyBudgetMinor: config.prototypes.monthlyBudgetMinor, currency: config.pricing.currency },
    });
});

/*
    @route GET /api/v1/opportunities/:id/timeline
    @desc Audit history of the opportunity and every prototype and proposal under it
*/
router.get("/opportunities/:id/timeline", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { ctx, lead } = await opportunity(req);
    const org = ctx.organizationId;
    const [protos, props] = await Promise.all([
        Prototype.find({ organizationId: org, opportunityId: lead._id }, { _id: 1 }).lean(),
        Proposal.find({ organizationId: org, leadId: lead._id }, { _id: 1 }).lean(),
    ]);
    const ids = [lead._id, ...protos.map((p) => p._id), ...props.map((p) => p._id)].map(String);
    const events = await AuditEvent.find({ organizationId: org, targetId: { $in: ids } }).sort({ createdAt: -1 }).limit(200).lean();
    return Ok(res, "Timeline", { events });
});

/*
    @route POST /api/v1/opportunities/:id/handoff
    @desc Hand a won deal to delivery: needs an accepted proposal; returns the handoff package (idempotent)
*/
router.post("/opportunities/:id/handoff", authorize("proposals.write"),
    validate(z.object({ notes: z.string().trim().max(2000).optional() }).strict()),
    async (req: Request, res: Response) => {
        const { ctx, lead } = await opportunity(req);
        const org = ctx.organizationId;
        const accepted = await Proposal.findOne({ organizationId: org, leadId: lead._id, status: "accepted" }).sort({ version: -1 }).lean();
        if (!accepted) throw new Conflict("No accepted proposal: record the client's acceptance first");
        if (!lead.handoff?.at) {
            await Lead.updateOne(
                { organizationId: org, _id: lead._id, "handoff.at": { $exists: false } },
                { opportunityStage: "won", handoff: { proposalId: accepted._id, at: new Date(), by: ctx.userId, notes: req.body.notes } },
            );
            await recordStage(org, lead._id, "won", { proposalId: String(accepted._id), totalMinor: accepted.totalMinor });
            await audit({ organizationId: org, actorType: "user", actorId: ctx.userId, action: "deal.handoff", targetType: "lead", targetId: String(lead._id), outcome: "success", metadata: { proposalId: String(accepted._id), totalMinor: accepted.totalMinor } });
        }
        const [fresh, requirements, demo] = await Promise.all([
            Lead.findOne({ organizationId: org, _id: lead._id }).lean(),
            latestRequirements(org, lead._id),
            accepted.prototypeId ? Prototype.findOne({ organizationId: org, _id: accepted.prototypeId }).lean() : null,
        ]);
        // everything delivery needs, in one document the business can drop into its own process
        return Ok(res, "Deal handed over", {
            handoff: fresh?.handoff,
            package: {
                client: { company: fresh?.company, contact: fresh?.contact },
                proposal: { version: accepted.version, items: accepted.items, totalMinor: accepted.totalMinor, currency: accepted.currency, paymentSchedule: accepted.paymentSchedule, scope: accepted.scope, milestones: accepted.milestones, acceptance: accepted.acceptance, body: accepted.body },
                requirements: requirements ? { version: requirements.version, ...requirements.requirements as object } : null,
                demo: demo ? { templateId: demo.templateId, previewUrl: demo.status === "ready" ? demo.previewUrl : null } : null,
                note: "Acceptance is recorded, not a signed contract or a payment: both stay with your usual process.",
            },
        });
    });

/* -------------------------- requirements ------------------------- */

/*
    @route POST /api/v1/opportunities/:id/requirements/extract
    @desc Requirements agent reads the conversation and writes a new version (202 Accepted)
*/
router.post("/opportunities/:id/requirements/extract", authorize("workflows.run"), async (req: Request, res: Response) => {
    const { ctx, lead } = await opportunity(req);
    if (!await Message.exists({ organizationId: ctx.organizationId, leadId: lead._id, direction: "inbound" })) {
        throw new Conflict("No reply from this prospect yet; requirements come from the conversation");
    }
    const key = str(req.header("idempotency-key"))?.slice(0, 100);
    const { workflow } = await startWorkflow({
        organizationId: ctx.organizationId, type: "requirements.extract", entityType: "lead", entityId: lead._id,
        idempotencyKey: `requirements:${lead._id}:${key ?? Date.now()}`, startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
    });
    return ApiResponse(res, 202, "Extracting requirements", { workflowId: workflow._id, statusUrl: `/api/v1/workflows/${workflow._id}` });
});

/*
    @route GET /api/v1/opportunities/:id/requirements
    @desc Current requirements (or ?version=N)
*/
router.get("/opportunities/:id/requirements", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { ctx, lead } = await opportunity(req);
    const version = Number(req.query.version);
    const doc = Number.isSafeInteger(version) && version > 0
        ? await Requirements.findOne({ organizationId: ctx.organizationId, opportunityId: lead._id, version }).lean()
        : await latestRequirements(ctx.organizationId, lead._id);
    return Ok(res, "Requirements", { requirements: doc });
});

/*
    @route PUT /api/v1/opportunities/:id/requirements
    @desc Store a revised version (earlier versions, and prototypes built from them, are untouched)
*/
router.put("/opportunities/:id/requirements", authorize("leads.write"),
    validate(z.object({ requirements: RequirementsSchema, changeSummary: z.string().trim().min(1).max(500) }).strict()),
    async (req: Request, res: Response) => {
        const { ctx, lead } = await opportunity(req);
        const doc = await saveRequirementsVersion(ctx.organizationId, lead._id, req.body.requirements, `user:${ctx.userId}`, req.body.changeSummary);
        return Ok(res, "Requirements saved", { requirements: doc });
    });

/* --------------------------- prototypes -------------------------- */

/*
    @route POST /api/v1/opportunities/:id/prototypes
    @desc Request a demo build: eligibility and budget are checked server-side (202, or 409 with reasons)
*/
router.post("/opportunities/:id/prototypes", authorize("proposals.write"),
    validate(z.object({ templateId: z.string().max(40).optional() }).strict()),
    async (req: Request, res: Response) => {
        const { ctx, lead } = await opportunity(req);
        const key = str(req.header("idempotency-key"))?.slice(0, 100);
        if (!key) throw new BadRequest("Idempotency-Key header is required");
        const r = await requestPrototype(ctx.organizationId, lead._id, { templateId: req.body.templateId, idempotencyKey: `client:${key}`, userId: ctx.userId });
        if (!r.prototype) return res.status(409).json({ success: false, status: 409, message: "Prototype not eligible", data: { decision: r.decision, reasons: r.reasons } });
        return ApiResponse(res, 202, r.decision === "allow" ? "Prototype build queued" : "Prototype awaits approval", { prototype: r.prototype, decision: r.decision, reasons: r.reasons });
    });

/*
    @route GET /api/v1/prototypes/:id
*/
router.get("/prototypes/:id", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { prototype } = await ownPrototype(req);
    return Ok(res, "Prototype", { prototype });
});

/*
    @route GET /api/v1/prototypes/:id/qa-report
*/
router.get("/prototypes/:id/qa-report", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { prototype } = await ownPrototype(req);
    return Ok(res, "QA report", { qaReport: prototype.qaReport ?? null, attempts: prototype.attempts, maxAttempts: prototype.maxAttempts, failureCode: prototype.failureCode ?? null });
});

/*
    @route GET /api/v1/prototypes/:id/artifact
    @desc The built page for internal review before publication (the client renders it in a sandboxed iframe)
*/
router.get("/prototypes/:id/artifact", authorize("proposals.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const p = await Prototype.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).select("+artifactHtml").lean();
    if (!p) throw new NotFound("Prototype not found");
    if (!p.artifactHtml) throw new Conflict("No built page for this prototype");
    return Ok(res, "Artifact", { html: p.artifactHtml, checksum: p.artifactChecksum });
});

router.post("/prototypes/:id/cancel", authorize("proposals.write"), async (req: Request, res: Response) => {
    const { ctx, prototype } = await ownPrototype(req);
    return Ok(res, "Prototype cancelled", { prototype: await cancelPrototype(ctx.organizationId, prototype._id, ctx.userId) });
});

router.post("/prototypes/:id/retry", authorize("proposals.write"), async (req: Request, res: Response) => {
    const { ctx, prototype } = await ownPrototype(req);
    return ApiResponse(res, 202, "Retry queued", { prototype: await retryPrototype(ctx.organizationId, prototype._id, ctx.userId) });
});

// publishing exposes work to a prospect, so it needs reviewer rights, not just sales rights
router.post("/prototypes/:id/publish", authorize("approvals.decide"), async (req: Request, res: Response) => {
    const { ctx, prototype } = await ownPrototype(req);
    return Ok(res, "Preview published", { prototype: await publishPrototype(ctx.organizationId, prototype._id, ctx.userId) });
});

router.post("/prototypes/:id/expire", authorize("approvals.decide"), async (req: Request, res: Response) => {
    const { ctx, prototype } = await ownPrototype(req);
    return Ok(res, "Preview revoked", { prototype: await expirePrototype(ctx.organizationId, prototype._id, ctx.userId) });
});

/* --------------------------- proposals --------------------------- */

const Services = z.array(z.union([
    z.string().trim().min(1).max(120),
    z.object({ name: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(1000) }).strict(),
])).min(1).max(20);

/*
    @route POST /api/v1/opportunities/:id/proposals
    @desc New proposal version: priced by code from the price book, written by the agent (202)
*/
router.post("/opportunities/:id/proposals", authorize("proposals.write"),
    validate(z.object({ services: Services, discountPercent: z.number().min(0).max(100).default(0), prototypeId: z.string().regex(/^[a-f0-9]{24}$/).optional() }).strict()),
    async (req: Request, res: Response) => {
        const { ctx, lead } = await opportunity(req);
        const r = await createProposal(ctx.organizationId, lead._id, req.body, ctx.userId);
        return ApiResponse(res, 202, "Proposal is being written", r);
    });

async function ownProposal(req: Request) {
    const ctx = ctxOf(req);
    const proposal = await Proposal.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!proposal) throw new NotFound("Proposal not found");
    return { ctx, proposal };
}

router.post("/proposals/:id/validate", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { ctx, proposal } = await ownProposal(req);
    const v = await validateProposal(ctx.organizationId, proposal._id);
    return Ok(res, "Validation", { valid: v.issues.length === 0, issues: v.issues, decision: v.decision, reasons: v.reasons });
});

router.post("/proposals/:id/submit-approval", authorize("proposals.write"), async (req: Request, res: Response) => {
    const { ctx, proposal } = await ownProposal(req);
    const r = await submitForApproval(ctx.organizationId, proposal._id, ctx.userId);
    return Ok(res, r.decision === "allow" ? "Proposal approved by policy" : "Approval requested", { proposal: r.proposal, decision: r.decision, reasons: r.reasons });
});

router.post("/proposals/:id/revisions", authorize("proposals.write"),
    validate(z.object({ services: Services.optional(), discountPercent: z.number().min(0).max(100).optional(), prototypeId: z.string().regex(/^[a-f0-9]{24}$/).optional(), note: z.string().trim().min(1).max(500) }).strict()),
    async (req: Request, res: Response) => {
        const { ctx, proposal } = await ownProposal(req);
        const r = await reviseProposal(ctx.organizationId, proposal._id.toString(), req.body, ctx.userId);
        return ApiResponse(res, 202, "Revision is being written", r);
    });

router.post("/proposals/:id/record-acceptance", authorize("proposals.write"),
    validate(z.object({ acceptedBy: z.string().trim().min(1).max(120), evidence: z.string().trim().min(1).max(1000), messageId: z.string().regex(/^[a-f0-9]{24}$/).optional() }).strict()),
    async (req: Request, res: Response) => {
        const { ctx, proposal } = await ownProposal(req);
        return Ok(res, "Acceptance recorded", { proposal: await recordAcceptance(ctx.organizationId, proposal._id.toString(), req.body, ctx.userId) });
    });

router.get("/proposals/:id/versions", authorize("proposals.read"), async (req: Request, res: Response) => {
    const { ctx, proposal } = await ownProposal(req);
    const versions = await Proposal.find({ organizationId: ctx.organizationId, leadId: proposal.leadId }, { body: 0 }).sort({ version: -1 }).limit(50).lean();
    return Ok(res, "Versions", { versions });
});

export default router;
