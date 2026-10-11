// Importing modules
import express, { Request, Response } from "express";
import { z } from "zod";
import mongoose from "mongoose";
import { BillingEvent } from "../../../shared/models/subscription.model.js";
import Organization from "../../../shared/models/organization.model.js";
import { applySubscriptionChange, getSubscription } from "../../../shared/billing/subscription.service.js";
import { verifySignature } from "./webhooks.router.js";
import env from "../../../shared/config/env.config.js";
import Unauthorized from "../../../shared/errors/Unauthorized.error.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import ApiError from "../../../shared/utils/ApiError.util.js";
import ApiResponse from "../../../shared/utils/ApiResponse.util.js";

const router = express.Router();

// normalized contract a Razorpay / Stripe / Paddle handler is mapped onto
const BillingEventSchema = z.object({
    id: z.string().min(1).max(200),
    type: z.enum(["subscription.activated", "subscription.renewed", "payment.failed", "subscription.cancelled"]),
    organizationId: z.string().regex(/^[a-f0-9]{24}$/),
    planKey: z.string().max(40).optional(),
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
    customerId: z.string().max(200).optional(),
    subscriptionId: z.string().max(200).optional(),
}).strict();

/*
    @route POST /api/webhooks/billing
    @desc The only way payment changes a subscription: HMAC-signed with BILLING_WEBHOOK_SECRET,
          each event id applied once. A browser redirect is never treated as proof of payment.
*/
router.post("/", async (req: Request, res: Response) => {
    if (!env.BILLING_WEBHOOK_SECRET) throw new ApiError(503, "Billing webhooks are not configured");
    if (!verifySignature(env.BILLING_WEBHOOK_SECRET, (req as Request & { rawBody?: Buffer }).rawBody, req.header("x-easysales-signature"))) {
        throw new Unauthorized("Invalid signature");
    }
    const parsed = BillingEventSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequest("Invalid billing event");
    const e = parsed.data;
    const organizationId = new mongoose.Types.ObjectId(e.organizationId);
    if (!await Organization.exists({ _id: organizationId })) throw new BadRequest("Unknown organization");

    try {
        await BillingEvent.create({ eventId: e.id, type: e.type, organizationId, payload: e });
    } catch (error) {
        if ((error as { code?: number }).code === 11000) return ApiResponse(res, 200, "Duplicate event ignored", { duplicate: true });
        throw error;
    }

    const actor = { type: "system" as const, id: "billing:webhook", note: `${e.type} ${e.id}` };
    const sub = await getSubscription(organizationId);
    if (e.type === "subscription.activated" || e.type === "subscription.renewed") {
        if (!e.periodStart || !e.periodEnd) throw new BadRequest("periodStart and periodEnd are required");
        await applySubscriptionChange(organizationId, {
            status: "active", periodStart: e.periodStart, periodEnd: e.periodEnd, customerId: e.customerId, subscriptionId: e.subscriptionId,
            // a paid upgrade takes the plan that was pending; a renewal applies a scheduled downgrade
            planKey: e.planKey ?? sub.pendingPlanKey ?? sub.scheduledPlanKey ?? undefined, cancelAtPeriodEnd: false,
        }, actor);
    } else if (e.type === "payment.failed") {
        await applySubscriptionChange(organizationId, { status: "past_due" }, actor);
    } else {
        await applySubscriptionChange(organizationId, { status: "cancelled" }, actor);
    }
    await BillingEvent.updateOne({ eventId: e.id }, { result: "applied" });
    return ApiResponse(res, 200, "Billing event applied", { duplicate: false });
});

export default router;
