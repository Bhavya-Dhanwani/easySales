// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import BusinessProfile from "../../../shared/models/businessProfile.model.js";
import Policy from "../../../shared/models/policy.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { PolicyConfigSchema } from "../../../shared/policy/policy.schema.js";
import { getCurrentPolicy, publishPolicy } from "../../../shared/policy/policy.service.js";
import { audit } from "../../../shared/audit/audit.service.js";
import Ok from "../../../shared/responses/Ok.response.js";
import { CRITERIA, CriterionId, DEFAULT_WEIGHTS } from "../../../shared/qualification/scoring.js";

const router = express.Router();

const text = (max: number) => z.string().trim().max(max);
const tags = z.array(text(200)).max(50);

const BusinessProfileSchema = z.object({
    businessName: text(120),
    businessType: text(120),
    description: text(4000),
    website: z.union([z.literal(""), z.string().trim().url().max(500)]),
    meetingLink: z.union([z.literal(""), z.string().trim().url().max(500)]).optional(),
    services: z.array(z.object({
        name: text(120).min(1),
        description: text(1000).default(""),
        basePriceMinor: z.number().int().min(0).max(1e12),
        deliveryDaysMin: z.number().int().min(0).max(3650).optional(),
        deliveryDaysMax: z.number().int().min(0).max(3650).optional(),
    })).max(50),
    idealCustomerProfile: z.object({
        industries: tags, companySizes: tags, regions: tags, requiredSignals: tags, disqualifiers: tags,
    }),
    brandVoice: text(500),
    approvedClaims: tags,
    prohibitedClaims: tags,
    caseStudies: z.array(z.object({ title: text(200), summary: text(1500) })).max(20),
    scoringWeights: z.object(Object.fromEntries(CRITERIA.map((c) => [c.id, z.number().int().min(0).max(100)])) as Record<CriterionId, z.ZodNumber>)
        .refine((w) => Object.values(w).some((v) => v > 0), "At least one criterion needs weight").optional(),
}).strict();

/*
    @route GET /api/v1/business-profile
*/
router.get("/business-profile", authorize("profile.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const profile = await BusinessProfile.findOne({ organizationId: ctx.organizationId }).lean();
    return Ok(res, "Business profile", { profile, criteria: CRITERIA, defaultWeights: DEFAULT_WEIGHTS });
});

/*
    @route PUT /api/v1/business-profile
    @desc Replace the structured business knowledge the agents use
*/
router.put("/business-profile", authorize("profile.write"), validate(BusinessProfileSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const names = (req.body.services as { name: string }[]).map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) {
        return res.status(400).json({ success: false, status: 400, message: "Service names must be unique" });
    }
    const profile = await BusinessProfile.findOneAndUpdate(
        { organizationId: ctx.organizationId },
        // a new profile version: research and qualification record which version they used
        { $set: req.body, $inc: { version: 1 } },
        { new: true, upsert: true, runValidators: true },
    ).lean();
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "business_profile.update", outcome: "success" });
    return Ok(res, "Business profile saved", { profile });
});

/*
    @route GET /api/v1/policies
    @desc Effective policy and version history
*/
router.get("/policies", authorize("policies.read"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const current = await getCurrentPolicy(ctx.organizationId);
    const versions = await Policy.find({ organizationId: ctx.organizationId }, { version: 1, createdAt: 1, createdBy: 1 }).sort({ version: -1 }).limit(50).lean();
    return Ok(res, "Policies", { current, versions });
});

/*
    @route PUT /api/v1/policies
    @desc Publish a new policy version (previous versions stay immutable)
*/
router.put("/policies", authorize("policies.write"), validate(PolicyConfigSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const before = await getCurrentPolicy(ctx.organizationId);
    const policy = await publishPolicy(ctx.organizationId, req.body, ctx.userId);
    await audit({
        organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "policy.publish",
        targetType: "policy", targetId: policy._id.toString(), outcome: "success", policyVersion: policy.version,
        metadata: { previousVersion: before.version },
    });
    return Ok(res, "Policy published", { current: { version: policy.version, config: policy.config } });
});

export default router;
