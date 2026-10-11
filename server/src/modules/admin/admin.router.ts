// Importing modules
import Organization from "../../shared/models/organization.model.js";
import Membership from "../../shared/models/membership.model.js";
import EmailIntegration from "../../shared/models/emailIntegration.model.js";
import AuditEvent from "../../shared/models/auditEvent.model.js";
import Plan from "../../shared/models/plan.model.js";
import { Subscription } from "../../shared/models/subscription.model.js";
import { applySubscriptionChange, ensurePlans, entitlementsFor, usageThisPeriod } from "../../shared/billing/subscription.service.js";
import { onboardingStatus } from "../../shared/onboarding/onboarding.service.js";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import FeatureFlag, { FLAGS } from "../../shared/models/featureFlag.model.js";
import Workflow from "../../shared/models/workflow.model.js";
import ProviderEvent from "../../shared/models/providerEvent.model.js";
import Message from "../../shared/models/message.model.js";
import authMiddleware from "../../shared/middlewares/auth.middleware.js";
import validate from "../../shared/middlewares/validate.middleware.js";
import { FLAG_DEFAULTS } from "../../shared/flags/flags.service.js";
import { metricsSummary } from "../../shared/ops/ops.service.js";
import { workerCapacity } from "../../shared/ops/capacity.service.js";
import { runEvaluation } from "../../evals/evaluate.js";
import ModelEvaluation from "../../shared/models/modelEvaluation.model.js";
import { apiMetrics } from "../../shared/ops/requestContext.js";
import { audit } from "../../shared/audit/audit.service.js";
import env from "../../shared/config/env.config.js";
import Ok from "../../shared/responses/Ok.response.js";
import Forbidden from "../../shared/errors/Forbidden.error.js";
import NotFound from "../../shared/errors/NotFound.error.js";
import Conflict from "../../shared/errors/Conflict.error.js";
import { oid } from "../../shared/utils/request.util.js";

const router = express.Router();

const list = (v: string) => new Set(v.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
export const isPlatformAdmin = (email?: unknown) => typeof email === "string" && list(env.ADMIN_EMAILS).has(email.toLowerCase());
export const isSupport = (email?: unknown) => isPlatformAdmin(email) || (typeof email === "string" && list(env.SUPPORT_EMAILS).has(email.toLowerCase()));

type StaffRequest = Request & { user?: { email?: string; isVerified?: boolean } };

// staff = operators (ADMIN_EMAILS) or support (SUPPORT_EMAILS); no tenant role grants either
function requireStaff(req: StaffRequest, res: Response, next: NextFunction) {
    if (!req.user?.isVerified || !isSupport(req.user.email)) throw new Forbidden("Platform staff only");
    next();
}

// support is read-only: every change needs an operator
function requireAdmin(req: StaffRequest, res: Response, next: NextFunction) {
    if (!isPlatformAdmin(req.user?.email)) throw new Forbidden("Platform admin only");
    next();
}

router.use(authMiddleware, requireStaff);

const actor = (req: Request) => String((req as Request & { user?: { userId?: string } }).user?.userId ?? "admin");

/*
    @route GET /api/admin/metrics/summary
    @desc API latency and errors (this instance), queues, failures, model latency, spend and cost per opportunity
*/
router.get("/metrics/summary", async (req: Request, res: Response) => {
    return Ok(res, "Metrics", { api: { last5m: apiMetrics(5), last15m: apiMetrics(15) }, ...(await metricsSummary()) });
});

/*
    @route GET /api/admin/feature-flags
*/
router.get("/feature-flags", async (req: Request, res: Response) => {
    const flags = await FeatureFlag.find().sort({ key: 1, organizationId: 1 }).lean();
    return Ok(res, "Feature flags", { flags, defaults: FLAG_DEFAULTS });
});

/*
    @route POST /api/admin/feature-flags
    @desc Set a flag globally (organizationId null) or for one tenant
*/
router.post("/feature-flags", requireAdmin, validate(z.object({
    key: z.enum(FLAGS), enabled: z.boolean(), note: z.string().max(300).optional(),
    organizationId: z.string().regex(/^[a-f0-9]{24}$/).nullable().default(null),
}).strict()), async (req: Request, res: Response) => {
    const { key, enabled, note, organizationId } = req.body;
    const org = organizationId ? new mongoose.Types.ObjectId(organizationId) : null;
    const flag = await FeatureFlag.findOneAndUpdate({ key, organizationId: org }, { enabled, note, updatedBy: actor(req) }, { upsert: true, new: true }).lean();
    if (org) await audit({ organizationId: org, actorType: "system", actorId: `admin:${actor(req)}`, action: "feature_flag.set", outcome: "success", metadata: { key, enabled, note } });
    return Ok(res, "Flag saved", { flag });
});

router.delete("/feature-flags/:id", requireAdmin, async (req: Request, res: Response) => {
    const flag = await FeatureFlag.findByIdAndDelete(oid(req.params.id)).lean();
    if (!flag) throw new NotFound("Flag not found");
    return Ok(res, "Flag removed (default applies)", { flag });
});

/*
    @route GET /api/admin/dead-letters
    @desc Failed jobs and events kept with their errors for investigation, plus sends of unknown outcome
*/
router.get("/dead-letters", async (req: Request, res: Response) => {
    const X = { crossTenant: true };
    const [workflows, events, uncertain] = await Promise.all([
        Workflow.find({ status: "failed" }, { input: 0, result: 0 }).sort({ updatedAt: -1 }).limit(100).setOptions(X).lean(),
        ProviderEvent.find({ status: "failed" }).sort({ updatedAt: -1 }).limit(100).setOptions(X).lean(),
        Message.find({ status: "uncertain" }, { body: 0 }).sort({ updatedAt: -1 }).limit(100).setOptions(X).lean(),
    ]);
    return Ok(res, "Dead letters", { workflows, events, uncertainMessages: uncertain });
});

/*
    @route POST /api/admin/workflows/:id/retry
    @desc Requeue a failed job after the cause is fixed (it resumes from its checkpoint where it has one)
*/
router.post("/workflows/:id/retry", requireAdmin, async (req: Request, res: Response) => {
    const wf = await Workflow.findOneAndUpdate(
        { _id: oid(req.params.id), status: "failed" },
        { status: "queued", attempts: 0, nextRunAt: new Date(), $unset: { failureCode: 1, lastError: 1 } }, { new: true },
    ).setOptions({ crossTenant: true }).lean();
    if (!wf) throw new Conflict("Only failed workflows can be retried");
    await audit({ organizationId: wf.organizationId, actorType: "system", actorId: `admin:${actor(req)}`, action: "workflow.retry", targetType: "workflow", targetId: String(wf._id), outcome: "success" });
    return Ok(res, "Workflow requeued", { workflow: wf });
});

/*
    @route GET /api/admin/analytics/worker-capacity
    @desc Backlog, oldest job, run times and failures per job type, process and database health, scaling advice
*/
router.get("/analytics/worker-capacity", async (req: Request, res: Response) => {
    return Ok(res, "Worker capacity", await workerCapacity());
});

/*
    @route POST /api/admin/evaluations/run
    @desc Run the versioned evaluation dataset (deterministic always; model tasks with { live: true })
*/
router.post("/evaluations/run", requireAdmin, validate(z.object({ live: z.boolean().default(false) }).strict()), async (req: Request, res: Response) => {
    return Ok(res, "Evaluation finished", await runEvaluation({ live: req.body.live }));
});

/*
    @route GET /api/admin/evaluations/results
    @desc Last runs with pass counts per task, model and prompt version
*/
router.get("/evaluations/results", async (req: Request, res: Response) => {
    const runs = await ModelEvaluation.aggregate([
        { $sort: { evaluatedAt: -1 } }, { $limit: 2000 },
        { $group: { _id: { runId: "$runId", taskType: "$taskType", modelVersion: "$modelVersion", promptVersion: "$promptVersion", datasetVersion: "$datasetVersion" }, total: { $sum: 1 }, passed: { $sum: { $cond: ["$passed", 1, 0] } }, at: { $max: "$evaluatedAt" }, failures: { $push: { $cond: ["$passed", "$$REMOVE", { id: "$exampleId", category: "$failureCategory", detail: "$detail" }] } } } },
        { $sort: { at: -1 } }, { $limit: 60 },
    ]);
    return Ok(res, "Evaluation results", { runs });
});

/* --------------------------- tenants (support) --------------------------- */

/*
    @route GET /api/admin/organizations
    @desc Every workspace: plan, subscription, activation, usage this period, integration health, failures
*/
router.get("/organizations", async (req: Request, res: Response) => {
    const X = { crossTenant: true };
    const orgs = await Organization.find({ status: { $ne: "deleting" } }).sort({ createdAt: -1 }).limit(200).lean();
    const ids = orgs.map((o) => o._id);
    const since = new Date(Date.now() - 86400_000);
    const [subs, integrations, failures, members] = await Promise.all([
        Subscription.find({ organizationId: { $in: ids } }).setOptions(X).lean(),
        EmailIntegration.find({ organizationId: { $in: ids } }, { organizationId: 1, status: 1, lastVerifiedAt: 1 }).setOptions(X).lean(),
        Workflow.aggregate([{ $match: { organizationId: { $in: ids }, status: "failed", updatedAt: { $gte: since } } }, { $group: { _id: "$organizationId", n: { $sum: 1 } } }]).option(X),
        Membership.aggregate([{ $match: { organizationId: { $in: ids }, status: "active" } }, { $group: { _id: "$organizationId", n: { $sum: 1 } } }]).option(X),
    ]);
    const by = <T extends { organizationId?: unknown; _id?: unknown }>(rows: T[], id: unknown, key: "organizationId" | "_id" = "organizationId") => rows.find((r) => String(r[key]) === String(id));
    return Ok(res, "Organizations", {
        organizations: orgs.map((o) => {
            const s = by(subs, o._id);
            const i = by(integrations, o._id);
            return {
                id: o._id, name: o.name, industry: o.industry, createdAt: o.createdAt, activatedAt: o.activatedAt, status: o.status,
                plan: s?.planKey ?? null, subscriptionStatus: s?.status ?? null, periodEnd: s?.currentPeriodEnd ?? null,
                email: i ? i.status : "not_connected", members: by(members, o._id, "_id")?.n ?? 0, failedJobs24h: by(failures, o._id, "_id")?.n ?? 0,
            };
        }),
    });
});

/*
    @route GET /api/admin/organizations/:id/health
    @desc One workspace's subscription, usage, onboarding, integrations and recent failures (support access is audited)
*/
router.get("/organizations/:id/health", async (req: Request, res: Response) => {
    const organizationId = oid(req.params.id);
    const org = await Organization.findById(organizationId).lean();
    if (!org) throw new NotFound("Organization not found");
    const [ent, usage, onboarding, failed, alerts] = await Promise.all([
        entitlementsFor(organizationId), usageThisPeriod(organizationId), onboardingStatus(organizationId),
        Workflow.find({ organizationId, status: "failed" }, { type: 1, failureCode: 1, lastError: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(20).lean(),
        AuditEvent.find({ organizationId, action: /^alert\./ }, { action: 1, metadata: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    await audit({ organizationId, actorType: "system", actorId: `support:${actor(req)}`, action: "support.view_health", outcome: "success" });
    return Ok(res, "Organization health", { organization: { id: org._id, name: org.name, activatedAt: org.activatedAt, status: org.status }, ...ent, usage, onboarding, failedJobs: failed, alerts });
});

/*
    @route POST /api/admin/organizations/:id/subscription
    @desc Operator override (pilot, comp, extension): plan, status and period end. Audited in the tenant's log.
*/
router.post("/organizations/:id/subscription", requireAdmin, validate(z.object({
    planKey: z.string().max(40).optional(),
    status: z.enum(["trialing", "active", "past_due", "cancelled"]).optional(),
    periodDays: z.number().int().min(1).max(400).optional(),
    note: z.string().trim().min(3).max(300),
}).strict()), async (req: Request, res: Response) => {
    const organizationId = oid(req.params.id);
    if (!await Organization.exists({ _id: organizationId })) throw new NotFound("Organization not found");
    const now = new Date();
    const subscription = await applySubscriptionChange(organizationId, {
        planKey: req.body.planKey, status: req.body.status,
        ...(req.body.periodDays && { periodStart: now, periodEnd: new Date(now.getTime() + req.body.periodDays * 86400_000) }),
    }, { type: "system", id: `admin:${actor(req)}`, note: req.body.note });
    return Ok(res, "Subscription updated", { subscription });
});

/*
    @route POST /api/admin/plans
    @desc Publish a new immutable version of a plan (existing subscriptions keep their snapshot)
*/
router.post("/plans", requireAdmin, validate(z.object({
    key: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/), name: z.string().trim().min(1).max(60),
    priceMinorUnits: z.number().int().min(0), currency: z.string().length(3).toUpperCase().default("INR"),
    billingInterval: z.enum(["monthly", "yearly"]).default("monthly"), sortOrder: z.number().int().default(0),
    entitlements: z.object({
        maxMembers: z.number().int().min(1), researchJobsPerMonth: z.number().int().min(0), emailSendsPerMonth: z.number().int().min(0),
        prototypeBuildsPerMonth: z.number().int().min(0), analyticsLevel: z.enum(["basic", "advanced"]), apiAccess: z.boolean(),
    }).strict(),
}).strict()), async (req: Request, res: Response) => {
    await ensurePlans();
    const last = await Plan.findOne({ key: req.body.key }).sort({ version: -1 }).lean();
    const plan = await Plan.create({ ...req.body, version: (last?.version ?? 0) + 1, active: true });
    if (last) await Plan.updateMany({ key: req.body.key, version: { $lt: plan.version } }, { active: false });
    return Ok(res, "Plan version published", { plan });
});

export default router;
