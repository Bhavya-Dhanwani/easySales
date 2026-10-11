// Importing modules
import mongoose from "mongoose";
import Plan from "../models/plan.model.js";
import { Subscription } from "../models/subscription.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import Prototype from "../models/prototype.model.js";
import Membership from "../models/membership.model.js";
import Message from "../models/message.model.js";
import { audit } from "../audit/audit.service.js";
import ApiError from "../utils/ApiError.util.js";
import NotFound from "../errors/NotFound.error.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId | string;

export interface Entitlements {
    maxMembers: number;
    researchJobsPerMonth: number;
    emailSendsPerMonth: number;
    prototypeBuildsPerMonth: number;
    analyticsLevel: "basic" | "advanced";
    apiAccess: boolean;
}

// example plans from the Sprint 7 spec: seeded as version 1 if no plans exist; operators publish new versions
export const DEFAULT_PLANS = [
    { key: "starter", name: "Starter", priceMinorUnits: 4_999_00, sortOrder: 1, entitlements: { maxMembers: 2, researchJobsPerMonth: 500, emailSendsPerMonth: 500, prototypeBuildsPerMonth: 5, analyticsLevel: "basic", apiAccess: false } },
    { key: "growth", name: "Growth", priceMinorUnits: 14_999_00, sortOrder: 2, entitlements: { maxMembers: 5, researchJobsPerMonth: 2500, emailSendsPerMonth: 2500, prototypeBuildsPerMonth: 25, analyticsLevel: "advanced", apiAccess: false } },
    { key: "scale", name: "Scale", priceMinorUnits: 39_999_00, sortOrder: 3, entitlements: { maxMembers: 15, researchJobsPerMonth: 10000, emailSendsPerMonth: 10000, prototypeBuildsPerMonth: 100, analyticsLevel: "advanced", apiAccess: true } },
] as const;

// what a workspace without a valid subscription keeps: it can read and export, not spend
export const SUSPENDED: Entitlements = { maxMembers: 1, researchJobsPerMonth: 0, emailSendsPerMonth: 0, prototypeBuildsPerMonth: 0, analyticsLevel: "basic", apiAccess: false };

export const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;
const DAY = 86400_000;

export class QuotaExceededError extends ApiError {
    code = "QUOTA_EXCEEDED";
    constructor(message: string) {
        super(402, message);
    }
}

export async function ensurePlans() {
    if (await Plan.exists({})) return;
    await Plan.insertMany(DEFAULT_PLANS.map((p) => ({ ...p, version: 1, currency: "INR", billingInterval: "monthly", active: true })), { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; });
}

export async function latestPlan(key: string) {
    await ensurePlans();
    const plan = await Plan.findOne({ key, active: true }).sort({ version: -1 }).lean();
    if (!plan) throw new NotFound(`Unknown plan: ${key}`);
    return plan;
}

const snapshot = (p: { _id: mongoose.Types.ObjectId; key: string; version: number; entitlements?: unknown }) =>
    ({ planId: p._id, planKey: p.key, planVersion: p.version, entitlements: JSON.parse(JSON.stringify(p.entitlements)) });

// every workspace has a subscription; new ones start with a trial
export async function getSubscription(organizationId: Id) {
    const existing = await Subscription.findOne({ organizationId }).lean();
    if (existing) return existing;
    // trials run on Growth so a new business can evaluate every feature; the plan is chosen before paying
    const plan = await latestPlan("growth");
    const now = new Date();
    try {
        return (await Subscription.create({ organizationId, ...snapshot(plan), status: "trialing", currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + TRIAL_DAYS * DAY) })).toObject();
    } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
        return (await Subscription.findOne({ organizationId }).lean())!;
    }
}

/*
    The limits in force right now. Trialing and active subscriptions get their snapshot;
    past_due keeps it for a grace period; after that, or when cancelled, the workspace is
    suspended (read and export only).
*/
export async function entitlementsFor(organizationId: Id, now = new Date()) {
    const sub = await getSubscription(organizationId);
    const ok = sub.status === "trialing" || sub.status === "active"
        ? now.getTime() <= sub.currentPeriodEnd.getTime() + GRACE_DAYS * DAY
        : sub.status === "past_due" && now.getTime() <= sub.currentPeriodEnd.getTime() + GRACE_DAYS * DAY;
    return { subscription: sub, entitlements: (ok ? sub.entitlements : SUSPENDED) as Entitlements, suspended: !ok };
}

// metered usage in the current subscription period (quotas count work, budgets count money)
export async function usageThisPeriod(organizationId: Id) {
    const sub = await getSubscription(organizationId);
    const since = sub.currentPeriodStart;
    const [research, emails, prototypes, members] = await Promise.all([
        UsageRecord.countDocuments({ organizationId, kind: "llm", agent: "research", createdAt: { $gte: since } }),
        UsageRecord.countDocuments({ organizationId, kind: "email", createdAt: { $gte: since } }),
        Prototype.countDocuments({ organizationId, createdAt: { $gte: since }, failureCode: { $ne: "REJECTED" } }),
        Membership.countDocuments({ organizationId, status: { $in: ["active", "invited"] } }),
    ]);
    return { periodStart: since, periodEnd: sub.currentPeriodEnd, research, emails, prototypes, members };
}

const RESOURCE = {
    research: { limit: "researchJobsPerMonth", used: "research", label: "research jobs" },
    email: { limit: "emailSendsPerMonth", used: "emails", label: "emails" },
    prototype: { limit: "prototypeBuildsPerMonth", used: "prototypes", label: "demo builds" },
    member: { limit: "maxMembers", used: "members", label: "team members" },
} as const;

// server-side quota check shared by API routes and workers
export async function quotaLeft(organizationId: Id, resource: keyof typeof RESOURCE) {
    const r = RESOURCE[resource];
    const [{ entitlements, suspended }, used] = await Promise.all([entitlementsFor(organizationId), usageThisPeriod(organizationId)]);
    const limit = entitlements[r.limit];
    return { left: limit - used[r.used], limit, used: used[r.used], suspended, label: r.label };
}

export async function assertQuota(organizationId: Id, resource: keyof typeof RESOURCE, needed = 1) {
    const q = await quotaLeft(organizationId, resource);
    if (q.left < needed) {
        throw new QuotaExceededError(q.suspended
            ? "Your subscription is inactive: renew it to continue"
            : `Plan limit reached: ${q.limit} ${q.label} per period (${q.used} used). Upgrade or wait for the next period.`);
    }
    return q;
}

export async function assertAdvancedAnalytics(organizationId: Id) {
    const { entitlements } = await entitlementsFor(organizationId);
    if (entitlements.analyticsLevel !== "advanced") throw new QuotaExceededError("Advanced analytics are part of the Growth and Scale plans");
}

export const QUOTA_HOLD = "Held: monthly email quota reached";

// a plan change may have raised limits: release work that was held for quota
async function releaseHeldWork(organizationId: Id) {
    await Message.updateMany({ organizationId, status: "queued", error: QUOTA_HOLD }, { notBefore: new Date(), error: null });
}

/*
    Applies a change to the subscription. Only trusted callers reach this: the verified
    billing webhook, the worker's period rollover and audited platform admins.
*/
export async function applySubscriptionChange(organizationId: Id, change: {
    planKey?: string; status?: (typeof import("../models/subscription.model.js").SUBSCRIPTION_STATUSES)[number];
    periodStart?: Date; periodEnd?: Date; customerId?: string; subscriptionId?: string; cancelAtPeriodEnd?: boolean;
}, actor: { type: "system" | "user"; id: string; note?: string }) {
    const before = await getSubscription(organizationId);
    const set: Record<string, unknown> = {};
    if (change.planKey && change.planKey !== before.planKey) Object.assign(set, snapshot(await latestPlan(change.planKey)), { scheduledPlanKey: null, pendingPlanKey: null });
    if (change.planKey === before.pendingPlanKey) set.pendingPlanKey = null;
    if (change.status) set.status = change.status;
    if (change.periodStart) set.currentPeriodStart = change.periodStart;
    if (change.periodEnd) set.currentPeriodEnd = change.periodEnd;
    if (change.customerId) set.billingProviderCustomerId = change.customerId;
    if (change.subscriptionId) set.billingProviderSubscriptionId = change.subscriptionId;
    if (change.cancelAtPeriodEnd !== undefined) set.cancelAtPeriodEnd = change.cancelAtPeriodEnd;
    const after = await Subscription.findOneAndUpdate({ organizationId }, set, { new: true }).lean();
    await releaseHeldWork(organizationId);
    await audit({
        organizationId, actorType: actor.type, actorId: actor.id, action: "subscription.change", targetType: "subscription", targetId: String(after!._id), outcome: "success",
        metadata: { from: { plan: before.planKey, status: before.status }, to: { plan: after!.planKey, status: after!.status }, note: actor.note },
    });
    return after!;
}

/*
    What a tenant may ask for itself: a different plan during the trial (no payment yet),
    a downgrade at the end of the paid period, an upgrade recorded as pending until the
    billing provider confirms payment, or cancellation at period end.
*/
export async function requestPlanChange(organizationId: Id, planKey: string, userId: string) {
    const sub = await getSubscription(organizationId);
    const target = await latestPlan(planKey);
    if (target.key === sub.planKey) throw new Conflict("Already on this plan");
    const current = await Plan.findOne({ _id: sub.planId }).lean();
    const upgrade = target.priceMinorUnits > (current?.priceMinorUnits ?? 0);
    let outcome: "changed" | "scheduled" | "payment_required";
    if (sub.status === "trialing") {
        await applySubscriptionChange(organizationId, { planKey }, { type: "user", id: userId, note: "plan chosen during trial" });
        outcome = "changed";
    } else if (!upgrade) {
        await Subscription.updateOne({ organizationId }, { scheduledPlanKey: planKey });
        outcome = "scheduled";
    } else {
        // ponytail: no payment provider wired yet; the signed webhook activates the upgrade once one is
        await Subscription.updateOne({ organizationId }, { pendingPlanKey: planKey });
        outcome = "payment_required";
    }
    await audit({ organizationId, actorType: "user", actorId: userId, action: "subscription.request", targetType: "subscription", targetId: String(sub._id), outcome: "success", metadata: { planKey, outcome } });
    return { outcome, subscription: await Subscription.findOne({ organizationId }).lean() };
}

/*
    Worker housekeeping at period end: scheduled downgrades and cancellations take effect;
    an unpaid period becomes past_due (renewal only ever comes from the billing provider).
*/
export async function rollOverSubscriptions(now = new Date()) {
    const due = await Subscription.find({ status: { $in: ["trialing", "active"] }, currentPeriodEnd: { $lt: now } }).limit(200).setOptions({ crossTenant: true }).lean();
    for (const s of due) {
        const actor = { type: "system" as const, id: "billing:rollover" };
        if (s.cancelAtPeriodEnd) await applySubscriptionChange(s.organizationId, { status: "cancelled" }, actor);
        // a scheduled downgrade switches the plan; either way the new period starts only when it is paid
        else await applySubscriptionChange(s.organizationId, { status: "past_due", planKey: s.scheduledPlanKey ?? undefined }, actor);
    }
}
