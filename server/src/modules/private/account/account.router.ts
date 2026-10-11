// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import Organization from "../../../shared/models/organization.model.js";
import BusinessProfile from "../../../shared/models/businessProfile.model.js";
import Plan from "../../../shared/models/plan.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { createOrganizationForUser } from "../../../shared/tenancy/organization.service.js";
import { getCurrentPolicy, publishPolicy } from "../../../shared/policy/policy.service.js";
import { activate, onboardingStatus, startTestRun } from "../../../shared/onboarding/onboarding.service.js";
import {
    applySubscriptionChange, ensurePlans, entitlementsFor, getSubscription, requestPlanChange, usageThisPeriod,
} from "../../../shared/billing/subscription.service.js";
import Ok from "../../../shared/responses/Ok.response.js";
import Created from "../../../shared/responses/Created.response.js";

const router = express.Router();

const text = (max: number) => z.string().trim().max(max);
const tags = z.array(text(200)).max(50);
const userOf = (req: Request) => (req as Request & { user?: { userId?: string; email?: string } }).user!;

const OrgSchema = z.object({
    name: text(120).min(1),
    industry: text(120).min(1),
    timezone: text(60).min(1).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone"),
    defaultCurrency: z.string().length(3).toUpperCase().optional(),
}).strict();

/* ------------------------------ onboarding ------------------------------ */

/*
    @route POST /api/v1/onboarding/organizations
    @desc Create another workspace for the signed-in user (they become its owner; trial starts)
*/
router.post("/onboarding/organizations", validate(OrgSchema), async (req: Request, res: Response) => {
    const u = userOf(req);
    const org = await createOrganizationForUser({ _id: u.userId as never, email: String(u.email) }, req.body.name);
    await Organization.updateOne({ _id: org._id }, { industry: req.body.industry, timezone: req.body.timezone, ...(req.body.defaultCurrency && { defaultCurrency: req.body.defaultCurrency }) });
    return Created(res, "Workspace created", { organization: { id: org._id, name: org.name } });
});

/*
    @route GET /api/v1/onboarding/status
    @desc Every step with what is still missing; resumes at the first unfinished step
*/
router.get("/onboarding/status", async (req: Request, res: Response) => {
    return Ok(res, "Onboarding", await onboardingStatus(ctxOf(req).organizationId));
});

router.put("/onboarding/organization", authorize("org.manage"), validate(OrgSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await Organization.updateOne({ _id: ctx.organizationId }, req.body);
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "onboarding.organization", outcome: "success" });
    return Ok(res, "Saved", await onboardingStatus(ctx.organizationId));
});

const ProfileSchema = z.object({
    businessName: text(120).min(1),
    description: text(4000).min(1),
    website: z.union([z.literal(""), z.string().trim().url().max(500)]).optional(),
    services: z.array(z.object({
        name: text(120).min(1), description: text(1000).default(""),
        basePriceMinor: z.number().int().min(0).max(1e12),
        deliveryDaysMin: z.number().int().min(0).max(3650).optional(), deliveryDaysMax: z.number().int().min(0).max(3650).optional(),
    })).min(1).max(50),
    brandVoice: text(500).min(1),
    approvedClaims: tags,
    prohibitedClaims: tags,
}).strict();

/*
    @route PUT /api/v1/onboarding/business-profile
    @desc Services and prices, brand voice and claims (confirms the voice step)
*/
router.put("/onboarding/business-profile", authorize("profile.write"), validate(ProfileSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await BusinessProfile.findOneAndUpdate({ organizationId: ctx.organizationId }, { $set: req.body, $inc: { version: 1 } }, { upsert: true, runValidators: true });
    await Organization.updateOne({ _id: ctx.organizationId }, { "onboarding.voiceConfirmedAt": new Date() });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "business_profile.update", outcome: "success", metadata: { via: "onboarding" } });
    return Ok(res, "Saved", await onboardingStatus(ctx.organizationId));
});

/*
    @route PUT /api/v1/onboarding/icp
*/
router.put("/onboarding/icp", authorize("profile.write"), validate(z.object({
    idealCustomerProfile: z.object({ industries: tags, companySizes: tags, regions: tags, requiredSignals: tags, disqualifiers: tags }),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const icp = Object.fromEntries(Object.entries(req.body.idealCustomerProfile).map(([k, v]) => [`idealCustomerProfile.${k}`, v]));
    await BusinessProfile.findOneAndUpdate({ organizationId: ctx.organizationId }, { $set: icp, $inc: { version: 1 } }, { upsert: true });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "business_profile.update", outcome: "success", metadata: { via: "onboarding.icp" } });
    return Ok(res, "Saved", await onboardingStatus(ctx.organizationId));
});

/*
    @route PUT /api/v1/onboarding/limits
    @desc Spending limit and sending rules, published as a policy version (confirms the limits step)
*/
router.put("/onboarding/limits", authorize("policies.write"), validate(z.object({
    monthlySpendMinor: z.number().int().min(0).max(1e11),
    maxNewContactsPerDay: z.number().int().min(0).max(1000),
    maxPerHour: z.number().int().min(1).max(500),
    autoSend: z.boolean(),
}).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const { config, version } = await getCurrentPolicy(ctx.organizationId);
    const b = req.body;
    const policy = await publishPolicy(ctx.organizationId, {
        ...config,
        budgets: { ...config.budgets, monthlySpendMinor: b.monthlySpendMinor },
        outreach: { ...config.outreach, maxNewContactsPerDay: b.maxNewContactsPerDay, maxPerHour: b.maxPerHour, autoSend: b.autoSend },
    }, ctx.userId);
    await Organization.updateOne({ _id: ctx.organizationId }, { "onboarding.limitsConfirmedAt": new Date() });
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "policy.publish", targetType: "policy", targetId: String(policy._id), outcome: "success", policyVersion: policy.version, metadata: { previousVersion: version, via: "onboarding" } });
    return Ok(res, "Saved", await onboardingStatus(ctx.organizationId));
});

router.post("/onboarding/validate", async (req: Request, res: Response) => {
    const status = await onboardingStatus(ctxOf(req).organizationId);
    const blocking = status.steps.filter((s) => s.step !== "activation" && !s.done);
    return Ok(res, blocking.length ? "Setup incomplete" : "Ready to activate", { ok: !blocking.length, issues: blocking.flatMap((s) => s.issues.map((i) => ({ step: s.step, issue: i }))), ...status });
});

/*
    @route POST /api/v1/onboarding/test-run
    @desc Rehearse the pipeline on a synthetic lead whose only contact is you (202)
*/
router.post("/onboarding/test-run", authorize("workflows.run"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const u = userOf(req);
    return res.status(202).json({ success: true, status: 202, message: "Test run started", data: await startTestRun(ctx.organizationId, { id: ctx.userId, email: String(u.email) }) });
});

router.post("/onboarding/activate", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Workspace activated", await activate(ctx.organizationId, ctx.userId));
});

/* --------------------------- plans & subscription --------------------------- */

router.get("/plans", async (req: Request, res: Response) => {
    await ensurePlans();
    const plans = await Plan.aggregate([
        { $match: { active: true } }, { $sort: { version: -1 } },
        { $group: { _id: "$key", plan: { $first: "$$ROOT" } } }, { $replaceRoot: { newRoot: "$plan" } }, { $sort: { sortOrder: 1 } },
    ]);
    return Ok(res, "Plans", { plans });
});

async function subscriptionView(organizationId: Parameters<typeof getSubscription>[0]) {
    const [{ subscription, entitlements, suspended }, usage] = await Promise.all([entitlementsFor(organizationId), usageThisPeriod(organizationId)]);
    return { subscription, entitlements, suspended, usage };
}

router.get("/organization/subscription", authorize("usage.read"), async (req: Request, res: Response) => {
    return Ok(res, "Subscription", await subscriptionView(ctxOf(req).organizationId));
});

router.get("/organization/entitlements", async (req: Request, res: Response) => {
    const v = await subscriptionView(ctxOf(req).organizationId);
    return Ok(res, "Entitlements", { entitlements: v.entitlements, usage: v.usage, suspended: v.suspended });
});

/*
    @route POST /api/v1/organization/subscription
    @desc Ask for a plan change. Trials switch at once; downgrades wait for period end;
          upgrades stay pending until the billing provider confirms payment.
*/
router.post("/organization/subscription", authorize("org.manage"), validate(z.object({ planKey: z.string().trim().toLowerCase().max(40) }).strict()), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const r = await requestPlanChange(ctx.organizationId, req.body.planKey, ctx.userId);
    return Ok(res, r.outcome === "payment_required" ? "Upgrade pending payment" : r.outcome === "scheduled" ? "Change scheduled for the end of the period" : "Plan changed", r);
});

// cancelling only ever reduces what the tenant gets, so the tenant may do it directly
router.post("/organization/subscription/cancel", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await applySubscriptionChange(ctx.organizationId, { cancelAtPeriodEnd: true }, { type: "user", id: ctx.userId, note: "cancel at period end" });
    return Ok(res, "Subscription will end at the close of the current period", await subscriptionView(ctx.organizationId));
});

export default router;
