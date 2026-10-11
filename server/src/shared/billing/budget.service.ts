// Importing modules
import Workflow from "../models/workflow.model.js";
import Conversation from "../models/conversation.model.js";
import Proposal from "../models/proposal.model.js";
import Prototype from "../models/prototype.model.js";
import mongoose from "mongoose";
import { SpendCounter, BudgetReservation } from "../models/budget.model.js";
import UsageRecord, { USAGE_KINDS } from "../models/usageRecord.model.js";
import { getCurrentPolicy } from "../policy/policy.service.js";
import env from "../config/env.config.js";
import ApiError from "../utils/ApiError.util.js";

type Id = mongoose.Types.ObjectId | string;

export class SpendLimitError extends ApiError {
    code = "BUDGET_EXCEEDED";
    constructor(reason: string) {
        super(429, reason);
    }
}

// the platform-wide counter lives under a sentinel organization id
export const GLOBAL_ORG = new mongoose.Types.ObjectId("000000000000000000000000");

const month = (d = new Date()) => d.toISOString().slice(0, 7);
const day = (d = new Date()) => d.toISOString().slice(0, 10);

// token cost from operator-configured unit prices (never from the model)
export const llmCostMinor = (inputTokens: number, outputTokens: number) =>
    Math.ceil((inputTokens * env.LLM_COST_INPUT_PER_MTOK_MINOR + outputTokens * env.LLM_COST_OUTPUT_PER_MTOK_MINOR) / 1_000_000);

type Counter = { organizationId: mongoose.Types.ObjectId; period: string; bucket: "total" | "prototype" | "global"; limit: number };

async function limitsFor(organizationId: Id, resource: string): Promise<Counter[]> {
    const { config } = await getCurrentPolicy(organizationId);
    const org = new mongoose.Types.ObjectId(String(organizationId));
    const counters: Counter[] = [{ organizationId: org, period: month(), bucket: "total", limit: config.budgets.monthlySpendMinor }];
    if (resource === "prototype") counters.push({ organizationId: org, period: month(), bucket: "prototype", limit: config.prototypes.monthlyBudgetMinor });
    if (env.GLOBAL_DAILY_SPEND_CAP_MINOR > 0) counters.push({ organizationId: GLOBAL_ORG, period: day(), bucket: "global", limit: env.GLOBAL_DAILY_SPEND_CAP_MINOR });
    return counters;
}

const key = (c: { organizationId: mongoose.Types.ObjectId; period: string; bucket: string }) => ({ organizationId: c.organizationId, period: c.period, bucket: c.bucket });

// adds `amount` to reserved only if committed + reserved + amount stays within the limit (one atomic update)
async function take(c: Counter, amount: number) {
    await SpendCounter.updateOne(key(c), { $setOnInsert: key(c) }, { upsert: true }).catch((e) => { if (e.code !== 11000) throw e; });
    const r = await SpendCounter.updateOne(
        { ...key(c), $expr: { $lte: [{ $add: ["$committedMinor", "$reservedMinor", amount] }, c.limit] } },
        { $inc: { reservedMinor: amount } },
    );
    return r.modifiedCount === 1;
}

const LABEL = { total: "Monthly spend limit reached", prototype: "Monthly prototype budget exhausted", global: "Platform daily spend cap reached" };

/*
    Holds money before expensive work starts. Every counter must accept the amount or
    nothing is held. Released by settle()/release(), or by housekeeping when abandoned.
*/
export async function reserve(organizationId: Id, resource: string, amountMinor: number, refId?: string, ttlMs = 2 * 3600_000) {
    const counters = await limitsFor(organizationId, resource);
    const taken: Counter[] = [];
    for (const c of counters) {
        if (!await take(c, amountMinor)) {
            for (const t of taken) await SpendCounter.updateOne(key(t), { $inc: { reservedMinor: -amountMinor } });
            throw new SpendLimitError(LABEL[c.bucket]);
        }
        taken.push(c);
    }
    return BudgetReservation.create({
        organizationId, resource, refId, amountMinor, counters: counters.map(key), expiresAt: new Date(Date.now() + ttlMs),
    });
}

// converts a reservation into actual spend; idempotent (only the first call moves money)
export async function settle(organizationId: Id, reservationId: Id, actualMinor: number) {
    const r = await BudgetReservation.findOneAndUpdate(
        { organizationId, _id: reservationId, status: "reserved" }, { status: "settled", actualMinor }, { new: true },
    );
    if (!r) return null;
    for (const c of r.counters) {
        await SpendCounter.updateOne({ organizationId: c.organizationId, period: c.period, bucket: c.bucket }, { $inc: { reservedMinor: -r.amountMinor, committedMinor: actualMinor } }).setOptions({ crossTenant: true });
    }
    return r;
}

export const release = (organizationId: Id, reservationId: Id) => settle(organizationId, reservationId, 0).then(async (r) => {
    if (r) await BudgetReservation.updateOne({ organizationId, _id: r._id }, { status: "released" });
    return r;
});

// spend that was not reserved up front (cheap, already-happened work) still counts
export async function commit(organizationId: Id, resource: string, amountMinor: number) {
    if (amountMinor <= 0) return;
    for (const c of await limitsFor(organizationId, resource)) {
        await SpendCounter.updateOne(key(c), { $inc: { committedMinor: amountMinor } }, { upsert: true }).setOptions({ crossTenant: true });
    }
}

// one immutable ledger row per metered unit of work
export async function recordUsage(organizationId: Id, row: {
    kind: (typeof USAGE_KINDS)[number]; quantity?: number; costMinor?: number; provider?: string; refId?: string;
    agent?: string; model?: string; inputTokens?: number; outputTokens?: number; durationMs?: number; workflowId?: Id; leadId?: Id;
}) {
    const leadId = row.leadId ?? (row.workflowId ? await leadOfWorkflow(organizationId, row.workflowId) : undefined);
    return UsageRecord.create({ organizationId, ...row, leadId });
}

// every cost belongs to an opportunity: follow the workflow to its lead
async function leadOfWorkflow(organizationId: Id, workflowId: Id) {
    const wf = await Workflow.findOne({ organizationId, _id: workflowId }, { entityType: 1, entityId: 1 }).lean();
    if (!wf) return undefined;
    if (wf.entityType === "lead") return wf.entityId;
    const q = { organizationId, _id: wf.entityId };
    const doc: { leadId?: unknown; opportunityId?: unknown } | null = wf.entityType === "conversation" ? await Conversation.findOne(q, { leadId: 1 }).lean()
        : wf.entityType === "proposal" ? await Proposal.findOne(q, { leadId: 1 }).lean()
            : await Prototype.findOne(q, { opportunityId: 1 }).lean();
    return (doc?.leadId ?? doc?.opportunityId) as Id | undefined;
}

// housekeeping: reservations of crashed work go back to the pool
export async function releaseExpiredReservations(now = new Date()) {
    const stale = await BudgetReservation.find({ status: "reserved", expiresAt: { $lt: now } }).limit(200).setOptions({ crossTenant: true }).lean();
    for (const r of stale) await release(r.organizationId, r._id);
}

export async function spendSnapshot(organizationId: Id) {
    const { config } = await getCurrentPolicy(organizationId);
    const rows = await SpendCounter.find({ organizationId, period: month() }).lean();
    const of = (bucket: string) => rows.find((r) => r.bucket === bucket) ?? { committedMinor: 0, reservedMinor: 0 };
    return {
        currency: env.BILLING_CURRENCY, period: month(),
        total: { ...pick(of("total")), limitMinor: config.budgets.monthlySpendMinor },
        prototype: { ...pick(of("prototype")), limitMinor: config.prototypes.monthlyBudgetMinor },
    };
}

const pick = (c: { committedMinor: number; reservedMinor: number }) => ({ committedMinor: c.committedMinor, reservedMinor: c.reservedMinor });
