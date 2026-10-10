// Importing modules
import mongoose from "mongoose";
import AgentTask from "../models/agentTask.model.js";
import Prototype from "../models/prototype.model.js";
import Proposal from "../models/proposal.model.js";
import Lead from "../models/lead.model.js";
import Workflow from "../models/workflow.model.js";
import Message from "../models/message.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import { alert } from "../alerts/alert.service.js";
import { getCurrentPolicy } from "../policy/policy.service.js";

const STALL_MS = 10 * 60_000;

/*
    Platform health checks, run by the worker once a minute: a job or email that should
    have started 10 minutes ago means the queue is stalled; a tenant spending far above
    its own recent average (or a large slice of its monthly budget in one day) is abnormal.
*/
export async function runOpsChecks(now = new Date()) {
    const stalledBefore = new Date(now.getTime() - STALL_MS);
    const [oldJob, oldMail] = await Promise.all([
        Workflow.findOne({ status: "queued", nextRunAt: { $lt: stalledBefore } }).sort({ nextRunAt: 1 }).setOptions({ crossTenant: true }).lean(),
        Message.findOne({ status: "queued", direction: "outbound", notBefore: { $lt: stalledBefore } }).sort({ notBefore: 1 }).setOptions({ crossTenant: true }).lean(),
    ]);
    if (oldJob || oldMail) {
        const since = (oldJob?.nextRunAt ?? oldMail?.notBefore) as Date;
        await alert(null, "queue_stalled", `Oldest due ${oldJob ? `job (${oldJob.type})` : "email"} has waited ${Math.round((now.getTime() - since.getTime()) / 60_000)} minutes`);
    }

    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const weekStart = new Date(dayStart.getTime() - 7 * 86400_000);
    const rows = await UsageRecord.aggregate([
        { $match: { createdAt: { $gte: weekStart } } },
        { $group: { _id: { org: "$organizationId", today: { $gte: ["$createdAt", dayStart] } }, cost: { $sum: "$costMinor" } } },
    ]).option({ crossTenant: true });
    const byOrg = new Map<string, { today: number; before: number }>();
    for (const r of rows) {
        const e = byOrg.get(String(r._id.org)) ?? { today: 0, before: 0 };
        if (r._id.today) e.today += r.cost; else e.before += r.cost;
        byOrg.set(String(r._id.org), e);
    }
    for (const [org, { today, before }] of byOrg) {
        if (!today) continue;
        const { config } = await getCurrentPolicy(org);
        const dailyAverage = before / 7;
        // ponytail: fixed heuristics (3x the 7-day average, or 25% of the monthly budget in a day); tune from pilot data
        if ((dailyAverage > 0 && today > 3 * dailyAverage && today > 100_00) || today > config.budgets.monthlySpendMinor * 0.25) {
            await alert(org, "abnormal_spend", `Spent ${today / 100} today against a 7-day daily average of ${(dailyAverage / 100).toFixed(2)}`);
        }
    }
}

/* ------------------------------- metrics ------------------------------- */

const dayAgo = () => new Date(Date.now() - 86400_000);
const monthStart = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)); };
const X = { crossTenant: true };

// platform-wide numbers for operators (admin only): queues, failures, model latency, spend, cost per opportunity
export async function metricsSummary() {
    const since = dayAgo();
    const [queue, oldestDue, failedByType, mail, model, usage, protos, spendByOrg, qualifiedThisMonth] = await Promise.all([
        Workflow.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).option(X),
        Workflow.findOne({ status: "queued", nextRunAt: { $lte: new Date() } }).sort({ nextRunAt: 1 }).setOptions(X).lean(),
        Workflow.aggregate([{ $match: { status: "failed", updatedAt: { $gte: since } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).option(X),
        Message.aggregate([{ $match: { direction: "outbound", updatedAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).option(X),
        AgentTask.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 }, ms: { $push: "$durationMs" } } }]).option(X),
        UsageRecord.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$kind", quantity: { $sum: "$quantity" }, costMinor: { $sum: "$costMinor" }, tokens: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } }]).option(X),
        Prototype.aggregate([{ $match: { createdAt: { $gte: new Date(Date.now() - 7 * 86400_000) }, status: { $in: ["needs_review", "ready", "failed", "expired"] } } },
            { $group: { _id: { $eq: ["$status", "failed"] }, n: { $sum: 1 }, ms: { $avg: { $subtract: ["$completedAt", "$createdAt"] } } } }]).option(X),
        UsageRecord.aggregate([{ $match: { createdAt: { $gte: monthStart() } } }, { $group: { _id: "$organizationId", costMinor: { $sum: "$costMinor" } } }, { $sort: { costMinor: -1 } }]).option(X),
        Lead.countDocuments({ status: "qualified", "qualification.evaluatedAt": { $gte: monthStart() } }).setOptions(X),
    ]);
    const map = (rows: { _id: unknown; n: number }[]) => Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
    const durations = model.flatMap((r) => (r.ms as (number | null)[]).filter((x): x is number => typeof x === "number")).sort((a, b) => a - b);
    const monthCost = spendByOrg.reduce((a, r) => a + r.costMinor, 0);
    return {
        queue: { byStatus: map(queue), oldestDueAgeSec: oldestDue ? Math.round((Date.now() - oldestDue.nextRunAt!.getTime()) / 1000) : 0 },
        failures24h: { workflowsByType: map(failedByType), email: map(mail) },
        model24h: { calls: model.reduce((a, r) => a + r.n, 0), failed: model.find((r) => r._id === "failed")?.n ?? 0, p95Ms: durations[Math.floor(durations.length * 0.95)] ?? 0 },
        usage24h: Object.fromEntries(usage.map((u) => [u._id, { quantity: u.quantity, costMinor: u.costMinor, tokens: u.tokens }])),
        prototypes7d: { built: protos.find((p) => p._id === false)?.n ?? 0, failed: protos.find((p) => p._id === true)?.n ?? 0, avgBuildMs: Math.max(0, Math.round(protos.find((p) => p._id === false)?.ms ?? 0)) },
        spendThisMonth: { costMinor: monthCost, topTenants: spendByOrg.slice(0, 10).map((r) => ({ organizationId: String(r._id), costMinor: r.costMinor })) },
        costPerQualifiedOpportunityMinor: qualifiedThisMonth ? Math.round(monthCost / qualifiedThisMonth) : null,
    };
}

const MEANINGFUL = ["interested", "meeting_request", "pricing_question", "objection"];

/*
    The pilot funnel for one tenant this month, with cost per qualified opportunity and
    per won deal: the numbers that decide whether a pilot expands.
*/
export async function tenantFunnel(organizationId: mongoose.Types.ObjectId) {
    const since = monthStart();
    const o = { organizationId };
    const [qualified, contacted, replies, meetings, protosBuilt, previewViews, proposalsSent, won, cost] = await Promise.all([
        Lead.countDocuments({ ...o, status: "qualified", "qualification.evaluatedAt": { $gte: since } }),
        Message.distinct("leadId", { ...o, direction: "outbound", sentAt: { $gte: since } }).then((x) => x.length),
        Message.countDocuments({ ...o, direction: "inbound", intent: { $in: MEANINGFUL }, createdAt: { $gte: since } }),
        Message.countDocuments({ ...o, direction: "inbound", intent: "meeting_request", createdAt: { $gte: since } }),
        Prototype.countDocuments({ ...o, status: { $in: ["needs_review", "ready", "expired"] }, createdAt: { $gte: since } }),
        Prototype.aggregate([{ $match: { ...o, createdAt: { $gte: since } } }, { $group: { _id: null, v: { $sum: "$previewViews" } } }]).then((r) => r[0]?.v ?? 0),
        Proposal.countDocuments({ ...o, sentAt: { $gte: since } }),
        Proposal.countDocuments({ ...o, status: "accepted", "acceptance.acceptedAt": { $gte: since } }),
        UsageRecord.aggregate([{ $match: { ...o, createdAt: { $gte: since } } }, { $group: { _id: "$kind", costMinor: { $sum: "$costMinor" }, quantity: { $sum: "$quantity" } } }]),
    ]);
    const total = cost.reduce((a, r) => a + r.costMinor, 0);
    return {
        period: since.toISOString().slice(0, 7),
        funnel: { qualified, contacted, meaningfulReplies: replies, meetings, prototypesBuilt: protosBuilt, prototypeViews: previewViews, proposalsSent, dealsWon: won },
        usage: Object.fromEntries(cost.map((r) => [r._id, { quantity: r.quantity, costMinor: r.costMinor }])),
        costMinor: total,
        costPerQualifiedMinor: qualified ? Math.round(total / qualified) : null,
        costPerWonDealMinor: won ? Math.round(total / won) : null,
    };
}
