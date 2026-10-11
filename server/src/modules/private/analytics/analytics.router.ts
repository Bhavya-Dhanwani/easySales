// Importing modules
import { assertAdvancedAnalytics } from "../../../shared/billing/subscription.service.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import Experiment, { EXPERIMENT_METRICS, EXPERIMENT_VARIABLES } from "../../../shared/models/experiment.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { costAnalytics, funnelAnalytics, leadQuality } from "../../../shared/analytics/analytics.service.js";
import { experimentResults } from "../../../shared/experiments/experiment.service.js";
import { oid } from "../../../shared/utils/request.util.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Conflict from "../../../shared/errors/Conflict.error.js";

const router = express.Router();

/* ------------------------------ analytics ------------------------------ */
// aggregates only: no contact details leave these endpoints

/*
    @route GET /api/v1/analytics/funnel?groupBy=month|week&bySegment=true
    @desc Cohort funnel computed from recorded stage events, with rate definitions
*/
router.get("/analytics/funnel", authorize("usage.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Funnel", await funnelAnalytics(ctx.organizationId, { groupBy: req.query.groupBy === "week" ? "week" : "month", bySegment: req.query.bySegment === "true" }));
});

/*
    @route GET /api/v1/analytics/costs?days=30
    @desc Spend by funnel stage and opportunity, cost per qualified opportunity, wasted spend
*/
router.get("/analytics/costs", authorize("usage.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await assertAdvancedAnalytics(ctx.organizationId);
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    return Ok(res, "Costs", await costAnalytics(ctx.organizationId, days));
});

/*
    @route GET /api/v1/analytics/lead-quality
    @desc Outcomes per score band and the criteria most often unknown
*/
router.get("/analytics/lead-quality", authorize("usage.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await assertAdvancedAnalytics(ctx.organizationId);
    return Ok(res, "Lead quality", await leadQuality(ctx.organizationId));
});

/* ----------------------------- experiments ----------------------------- */

const ExperimentSchema = z.object({
    name: z.string().trim().min(1).max(120),
    hypothesis: z.string().trim().min(10).max(1000),
    variable: z.enum(EXPERIMENT_VARIABLES),
    audience: z.object({
        campaignId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
        industries: z.array(z.string().trim().max(120)).max(20).optional(),
        minScore: z.number().int().min(0).max(100).optional(),
    }).default({}),
    variants: z.array(z.object({
        label: z.string().trim().min(1).max(80),
        instruction: z.string().trim().min(3).max(600),
    })).min(2).max(4),
    primaryMetric: z.enum(EXPERIMENT_METRICS).default("positive_reply_rate"),
    minSamplePerVariant: z.number().int().min(10).max(10000).default(50),
}).strict();

router.get("/experiments", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Experiments", { experiments: await Experiment.find({ organizationId: ctx.organizationId }).sort({ createdAt: -1 }).limit(100).lean() });
});

/*
    @route POST /api/v1/experiments
    @desc Draft an experiment; variant instructions are reviewed text, applied only to first-touch emails
*/
router.post("/experiments", authorize("policies.write"), validate(ExperimentSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await assertAdvancedAnalytics(ctx.organizationId);
    const body = req.body as z.infer<typeof ExperimentSchema>;
    const experiment = await Experiment.create({
        organizationId: ctx.organizationId, ...body, createdBy: ctx.userId,
        variants: body.variants.map((v, i) => ({ ...v, id: String.fromCharCode(65 + i) })),
    });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "experiment.create", targetType: "experiment", targetId: String(experiment._id), outcome: "success", metadata: { variable: body.variable } });
    return Created(res, "Experiment drafted", { experiment });
});

// state changes are explicit and audited; a completed experiment never restarts
const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
    start: { from: ["draft", "paused"], to: "running" },
    pause: { from: ["running"], to: "paused" },
    complete: { from: ["running", "paused"], to: "completed" },
};

for (const [action, t] of Object.entries(TRANSITIONS)) {
    router.post(`/experiments/:id/${action}`, authorize("policies.write"), async (req: Request, res: Response) => {
        const ctx = ctxOf(req);
        const set: Record<string, unknown> = { status: t.to };
        if (action === "start") set.startedAt = new Date();
        if (action === "complete") set.endedAt = new Date();
        const experiment = await Experiment.findOneAndUpdate({ organizationId: ctx.organizationId, _id: oid(req.params.id), status: { $in: t.from } }, set, { new: true }).lean();
        if (!experiment) {
            if (!await Experiment.exists({ organizationId: ctx.organizationId, _id: oid(req.params.id) })) throw new NotFound("Experiment not found");
            throw new Conflict(`Cannot ${action} from the current status`);
        }
        await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: `experiment.${action}`, targetType: "experiment", targetId: String(experiment._id), outcome: "success" });
        return Ok(res, `Experiment ${t.to}`, { experiment });
    });
}

/*
    @route GET /api/v1/experiments/:id/results
*/
router.get("/experiments/:id/results", authorize("leads.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Results", await experimentResults(ctx.organizationId, String(oid(req.params.id))));
});

export default router;
