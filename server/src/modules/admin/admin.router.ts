// Importing modules
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
import { apiMetrics } from "../../shared/ops/requestContext.js";
import { audit } from "../../shared/audit/audit.service.js";
import env from "../../shared/config/env.config.js";
import Ok from "../../shared/responses/Ok.response.js";
import Forbidden from "../../shared/errors/Forbidden.error.js";
import NotFound from "../../shared/errors/NotFound.error.js";
import Conflict from "../../shared/errors/Conflict.error.js";
import { oid } from "../../shared/utils/request.util.js";

const router = express.Router();

const admins = () => new Set(env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
export const isPlatformAdmin = (email?: unknown) => typeof email === "string" && admins().has(email.toLowerCase());

// platform operators only: listed in ADMIN_EMAILS and with a verified account (no tenant role grants this)
function requireAdmin(req: Request & { user?: { email?: string; isVerified?: boolean } }, res: Response, next: NextFunction) {
    if (!req.user?.isVerified || !isPlatformAdmin(req.user.email)) throw new Forbidden("Platform admin only");
    next();
}

router.use(authMiddleware, requireAdmin);

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
router.post("/feature-flags", validate(z.object({
    key: z.enum(FLAGS), enabled: z.boolean(), note: z.string().max(300).optional(),
    organizationId: z.string().regex(/^[a-f0-9]{24}$/).nullable().default(null),
}).strict()), async (req: Request, res: Response) => {
    const { key, enabled, note, organizationId } = req.body;
    const org = organizationId ? new mongoose.Types.ObjectId(organizationId) : null;
    const flag = await FeatureFlag.findOneAndUpdate({ key, organizationId: org }, { enabled, note, updatedBy: actor(req) }, { upsert: true, new: true }).lean();
    if (org) await audit({ organizationId: org, actorType: "system", actorId: `admin:${actor(req)}`, action: "feature_flag.set", outcome: "success", metadata: { key, enabled, note } });
    return Ok(res, "Flag saved", { flag });
});

router.delete("/feature-flags/:id", async (req: Request, res: Response) => {
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
router.post("/workflows/:id/retry", async (req: Request, res: Response) => {
    const wf = await Workflow.findOneAndUpdate(
        { _id: oid(req.params.id), status: "failed" },
        { status: "queued", attempts: 0, nextRunAt: new Date(), $unset: { failureCode: 1, lastError: 1 } }, { new: true },
    ).setOptions({ crossTenant: true }).lean();
    if (!wf) throw new Conflict("Only failed workflows can be retried");
    await audit({ organizationId: wf.organizationId, actorType: "system", actorId: `admin:${actor(req)}`, action: "workflow.retry", targetType: "workflow", targetId: String(wf._id), outcome: "success" });
    return Ok(res, "Workflow requeued", { workflow: wf });
});

export default router;
