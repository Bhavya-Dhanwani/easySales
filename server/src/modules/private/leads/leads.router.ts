// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import Lead, { CONSENT_BASES, OPPORTUNITY_STAGES, QUALIFICATION_STATUSES } from "../../../shared/models/lead.model.js";
import Conversation from "../../../shared/models/conversation.model.js";
import Message from "../../../shared/models/message.model.js";
import Workflow from "../../../shared/models/workflow.model.js";
import Proposal from "../../../shared/models/proposal.model.js";
import Approval from "../../../shared/models/approval.model.js";
import BusinessProfile from "../../../shared/models/businessProfile.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { activeWorkflowFor, startWorkflow } from "../../../shared/workflows/workflow.service.js";
import { getCurrentPolicy, normalizeEmail } from "../../../shared/policy/policy.service.js";
import { priceProposal } from "../../../shared/utils/pricing.util.js";
import { escapeRegex, nextCursor, oid, pageParams, str } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);

const LeadInputSchema = z.object({
    companyName: z.string().trim().min(1).max(200),
    website: z.union([z.literal(""), z.string().trim().max(500)]).optional(),
    industry: optionalText(120),
    size: optionalText(60),
    country: optionalText(80),
    contactName: optionalText(120),
    contactTitle: optionalText(120),
    contactEmail: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
    contactPhone: optionalText(40),
    consentBasis: z.enum(CONSENT_BASES).default("none"),
    consentSource: optionalText(200),
});
type LeadInput = z.infer<typeof LeadInputSchema>;

// normalizes a website into a URL + bare domain (used for deduplication)
function normalizeWebsite(raw?: string) {
    if (!raw) return { website: undefined, domain: undefined };
    try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (url.protocol !== "http:" && url.protocol !== "https:") return { website: undefined, domain: undefined };
        return { website: url.origin, domain: url.hostname.replace(/^www\./, "").toLowerCase() };
    } catch {
        return { website: undefined, domain: undefined };
    }
}

function toLeadDoc(input: LeadInput, provider: string) {
    const { website, domain } = normalizeWebsite(input.website);
    return {
        company: { name: input.companyName, website, domain, industry: input.industry, size: input.size, country: input.country },
        contact: { name: input.contactName, title: input.contactTitle, email: input.contactEmail ? normalizeEmail(input.contactEmail) : undefined, phone: input.contactPhone },
        consent: { basis: input.consentBasis, source: input.consentSource, recordedAt: input.consentBasis !== "none" ? new Date() : undefined },
        source: { provider, importedAt: new Date() },
    };
}

/*
    @route GET /api/v1/leads
    @desc Search leads (stage, qualification, text) with cursor pagination
*/
router.get("/", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const { limit, cursorFilter } = pageParams(req.query);
    const filter: Record<string, unknown> = { organizationId: ctx.organizationId, ...cursorFilter };
    const stage = str(req.query.stage);
    if (stage && (OPPORTUNITY_STAGES as readonly string[]).includes(stage)) filter.opportunityStage = stage;
    const qualification = str(req.query.qualification);
    if (qualification && (QUALIFICATION_STATUSES as readonly string[]).includes(qualification)) filter["qualification.status"] = qualification;
    const q = str(req.query.q)?.trim().slice(0, 100);
    if (q) {
        const rx = new RegExp(escapeRegex(q), "i");
        filter.$or = [{ "company.name": rx }, { "contact.email": rx }, { "contact.name": rx }, { "company.domain": rx }];
    }
    const leads = await Lead.find(filter).sort({ _id: -1 }).limit(limit).lean();
    return Ok(res, "Leads", { leads, nextCursor: nextCursor(leads, limit) });
});

/*
    @route POST /api/v1/leads
*/
router.post("/", authorize("leads.write"), validate(LeadInputSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const doc = toLeadDoc(req.body, "manual");
    if (doc.contact.email && await Lead.exists({ organizationId: ctx.organizationId, "contact.email": doc.contact.email })) {
        throw new Conflict("A lead with this email already exists");
    }
    const lead = await Lead.create({ organizationId: ctx.organizationId, ...doc, ownerId: ctx.userId });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lead.create", targetType: "lead", targetId: lead._id.toString(), outcome: "success" });
    return Created(res, "Lead created", { lead });
});

/*
    @route POST /api/v1/leads/import
    @desc Bulk import (CSV parsed client-side) with deduplication by email and domain
*/
router.post("/import", authorize("leads.write"), validate(z.object({ leads: z.array(z.unknown()).min(1).max(500) })), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const invalid: { row: number; error: string }[] = [];
    const duplicates: { row: number; reason: string }[] = [];
    const seenEmails = new Set<string>();
    const seenDomains = new Set<string>();
    const docs: ReturnType<typeof toLeadDoc>[] = [];

    (req.body.leads as unknown[]).forEach((raw, i) => {
        const parsed = LeadInputSchema.safeParse(raw);
        if (!parsed.success) {
            invalid.push({ row: i + 1, error: `${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}` });
            return;
        }
        const doc = toLeadDoc(parsed.data, "csv");
        const key = doc.contact.email;
        // within-file duplicates: same email, or same domain when no email is given
        if (key ? seenEmails.has(key) : doc.company.domain && seenDomains.has(doc.company.domain)) {
            duplicates.push({ row: i + 1, reason: "Duplicate within file" });
            return;
        }
        if (key) seenEmails.add(key);
        else if (doc.company.domain) seenDomains.add(doc.company.domain);
        docs.push(doc);
    });

    // against existing records
    const existing = await Lead.find({
        organizationId: ctx.organizationId,
        $or: [
            { "contact.email": { $in: [...seenEmails] } },
            { "company.domain": { $in: [...seenDomains] }, "contact.email": { $exists: false } },
        ],
    }, { "contact.email": 1, "company.domain": 1 }).lean();
    const existingEmails = new Set(existing.map((l) => l.contact?.email).filter(Boolean));
    const existingDomains = new Set(existing.filter((l) => !l.contact?.email).map((l) => l.company?.domain).filter(Boolean));

    const fresh = docs.filter((d) => {
        const dup = d.contact.email ? existingEmails.has(d.contact.email) : Boolean(d.company.domain && existingDomains.has(d.company.domain));
        if (dup) duplicates.push({ row: 0, reason: `Already exists: ${d.contact.email || d.company.domain}` });
        return !dup;
    });

    const created = fresh.length
        ? await Lead.insertMany(fresh.map((d) => ({ organizationId: ctx.organizationId, ...d, ownerId: ctx.userId })), { ordered: false })
        : [];
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "lead.import", outcome: "success", metadata: { created: created.length, duplicates: duplicates.length, invalid: invalid.length } });
    return Created(res, "Import finished", { created: created.length, duplicates, invalid });
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

const UpdateLeadSchema = z.object({
    opportunityStage: z.enum(OPPORTUNITY_STAGES).optional(),
    contact: z.object({
        name: optionalText(120), title: optionalText(120),
        email: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
        phone: optionalText(40),
    }).optional(),
    consent: z.object({ basis: z.enum(CONSENT_BASES), source: optionalText(200) }).optional(),
    qualificationStatus: z.enum(QUALIFICATION_STATUSES).optional(),
}).strict();

/*
    @route PATCH /api/v1/leads/:id
*/
router.patch("/:id", authorize("leads.write"), validate(UpdateLeadSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) });
    if (!lead) throw new NotFound("Lead not found");
    const body = req.body as z.infer<typeof UpdateLeadSchema>;
    if (body.opportunityStage) lead.opportunityStage = body.opportunityStage;
    if (body.contact) {
        for (const [k, v] of Object.entries(body.contact)) lead.set(`contact.${k}`, v || undefined);
    }
    if (body.consent) lead.set("consent", { ...body.consent, recordedAt: new Date() });
    // a human override of the AI qualification
    if (body.qualificationStatus) lead.set("qualification.status", body.qualificationStatus);
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
    @desc Price deterministically, then let the proposal agent write it (202 Accepted)
*/
router.post("/:id/proposals", authorize("proposals.write"), validate(ProposalRequestSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const lead = await Lead.findOne({ organizationId: ctx.organizationId, _id: oid(req.params.id) }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const profile = await BusinessProfile.findOne({ organizationId: ctx.organizationId }).lean();
    const { config } = await getCurrentPolicy(ctx.organizationId);
    const priced = priceProposal(profile?.services ?? [], req.body.services, req.body.discountPercent);

    const proposal = await Proposal.create({
        organizationId: ctx.organizationId, leadId: lead._id, items: priced.items, currency: config.pricing.currency,
        subtotalMinor: priced.subtotalMinor, discountPercent: priced.discountPercent, totalMinor: priced.totalMinor, status: "generating",
    });
    const { workflow } = await startWorkflow({
        organizationId: ctx.organizationId, type: "proposal.generate", entityType: "proposal", entityId: proposal._id,
        idempotencyKey: `proposal:${proposal._id}:generate`, startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
    });
    return ApiResponse(res, 202, "Proposal is being written", { proposal, workflowId: workflow._id });
});

export default router;
