// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "cancelled"] as const;

/*
    A tenant's subscription. Status and periods change only through the billing webhook
    (signed), the worker's period rollover, or an audited platform admin action; never
    directly from the tenant's browser.
*/
const subscriptionSchema = new mongoose.Schema({

    ...tenantFields,

    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true },

    planKey: { type: String, required: true },

    planVersion: { type: Number, required: true },

    // the entitlements this subscription was granted (later plan edits do not change them)
    entitlements: { type: mongoose.Schema.Types.Mixed, required: true },

    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },

    currentPeriodStart: { type: Date, required: true },

    currentPeriodEnd: { type: Date, required: true },

    cancelAtPeriodEnd: { type: Boolean, default: false },

    // a downgrade waits for the end of the paid period; an upgrade waits for payment
    scheduledPlanKey: String,

    pendingPlanKey: String,

    billingProviderCustomerId: String,

    billingProviderSubscriptionId: String,

}, { timestamps: true });

subscriptionSchema.plugin(tenantPlugin);
subscriptionSchema.index({ organizationId: 1 }, { unique: true });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

export const Subscription = mongoose.model("Subscription", subscriptionSchema);

// one row per billing-provider event id: replays and duplicate deliveries are no-ops
const billingEventSchema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },
    payload: { type: mongoose.Schema.Types.Mixed },
    result: String,
}, { timestamps: true });

export const BillingEvent = mongoose.model("BillingEvent", billingEventSchema);
