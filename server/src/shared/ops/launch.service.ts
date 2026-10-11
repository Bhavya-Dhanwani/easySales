// Importing modules
import Organization from "../models/organization.model.js";
import { BillingRecord, Subscription } from "../models/subscription.model.js";
import Plan from "../models/plan.model.js";
import FunnelEvent from "../models/funnelEvent.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import Workflow from "../models/workflow.model.js";
import Approval from "../models/approval.model.js";
import SalesDecision from "../models/salesDecision.model.js";
import Message from "../models/message.model.js";
import EmailIntegration from "../models/emailIntegration.model.js";
import { IntegrationConnection } from "../models/integration.model.js";
import { apiMetrics } from "./requestContext.js";

const X = { crossTenant: true };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/*
    Money vs access, per workspace, for the current period. Kept apart on purpose: a workspace can
    have quota left but be overdue, or be paid up with its quota exhausted.
*/
export async function reconcileBilling() {
    const subs = await Subscription.find({}).setOptions(X).lean();
    const plans = await Plan.find({}).lean();
    const rows = [];
    for (const s of subs) {
        const records = await BillingRecord.find({ organizationId: s.organizationId, createdAt: { $gte: s.currentPeriodStart } }).setOptions(X).lean();
        const paid = records.filter((r) => r.kind === "invoice").reduce((a, r) => a + r.amountMinor, 0);
        const refunded = records.filter((r) => r.kind === "refund").reduce((a, r) => a + r.amountMinor, 0);
        const price = plans.find((p) => p.key === s.planKey && p.version === s.planVersion)?.priceMinorUnits ?? 0;
        const issue =
            s.status === "active" && price > 0 && paid - refunded < price ? "active without full payment this period"
                : s.status === "cancelled" && paid - refunded > 0 && s.currentPeriodEnd < new Date() ? "paid but cancelled: check for a refund"
                    : s.status === "past_due" ? "payment failed: in grace or suspended"
                        : null;
        rows.push({ organizationId: String(s.organizationId), plan: s.planKey, status: s.status, periodEnd: s.currentPeriodEnd, expectedMinor: price, paidMinor: paid, refundedMinor: refunded, issue });
    }
    return { workspaces: rows, issues: rows.filter((r) => r.issue) };
}

/*
    The launch dashboard separates product activity from business results: a generated proposal is
    not revenue and a positive reply is not a qualified opportunity. Every number comes from
    recorded events (funnel events, billing records, usage ledger, decisions, approvals).
*/
export async function launchDashboard(days = 30) {
    const since = new Date(Date.now() - days * 86400_000);
    const [orgs, activated, stages, revenue, refunds, cost, failedJobs, allJobs, oldestQueued, emailIntegrations, oauth, decisions, approvals, cancelled, activeOrgs, repeat] = await Promise.all([
        Organization.find({ createdAt: { $gte: since } }, { createdAt: 1, activatedAt: 1 }).lean(),
        Organization.countDocuments({ activatedAt: { $gte: since } }),
        FunnelEvent.aggregate([{ $match: { occurredAt: { $gte: since } } }, { $group: { _id: "$stage", n: { $sum: 1 } } }]).option(X),
        BillingRecord.aggregate([{ $match: { kind: "invoice", createdAt: { $gte: since } } }, { $group: { _id: "$currency", n: { $sum: "$amountMinor" } } }]).option(X),
        BillingRecord.aggregate([{ $match: { kind: "refund", createdAt: { $gte: since } } }, { $group: { _id: "$currency", n: { $sum: "$amountMinor" } } }]).option(X),
        UsageRecord.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: null, n: { $sum: "$costMinor" } } }]).option(X),
        Workflow.countDocuments({ status: "failed", updatedAt: { $gte: since } }).setOptions(X),
        Workflow.countDocuments({ createdAt: { $gte: since } }).setOptions(X),
        Workflow.findOne({ status: "queued", nextRunAt: { $lte: new Date() } }).sort({ nextRunAt: 1 }).setOptions(X).lean(),
        EmailIntegration.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).option(X),
        IntegrationConnection.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]).option(X),
        SalesDecision.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: { p: "$policyDecision", a: "$action" }, n: { $sum: 1 } } }]).option(X),
        Approval.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).option(X),
        Subscription.countDocuments({ status: "cancelled", updatedAt: { $gte: since } }).setOptions(X),
        FunnelEvent.distinct("organizationId", { occurredAt: { $gte: since } }).setOptions(X),
        FunnelEvent.aggregate([{ $match: { occurredAt: { $gte: since } } }, { $group: { _id: { o: "$organizationId", w: { $isoWeek: "$occurredAt" } } } }, { $group: { _id: "$_id.o", weeks: { $sum: 1 } } }, { $match: { weeks: { $gte: 2 } } }]).option(X),
    ]);
    // time to first value: workspace created → its first email actually sent
    const firsts = await Promise.all(orgs.map(async (o) => {
        const m = await Message.findOne({ organizationId: o._id, direction: "outbound", status: { $in: ["sent", "delivered"] } }, { sentAt: 1 }).sort({ sentAt: 1 }).lean();
        return m?.sentAt ? (m.sentAt.getTime() - o.createdAt.getTime()) / 3600_000 : null;
    }));
    const hours = firsts.filter((h): h is number => h !== null).sort((a, b) => a - b);
    const s = Object.fromEntries(stages.map((r) => [r._id, r.n])) as Record<string, number>;
    const usageCost = cost[0]?.n ?? 0;
    const inr = (rows: { _id: string; n: number }[]) => rows.find((r) => r._id === "INR")?.n ?? 0;
    const netRevenue = inr(revenue) - inr(refunds);
    const dec = (p: string) => decisions.filter((d) => d._id.p === p).reduce((a, d) => a + d.n, 0);
    const totalDecisions = decisions.reduce((a, d) => a + d.n, 0);
    const ap = Object.fromEntries(approvals.map((r) => [r._id, r.n])) as Record<string, number>;
    const decided = (ap.approved ?? 0) + (ap.rejected ?? 0);
    const health = (rows: { _id: string; n: number }[], ok: string) => { const t = rows.reduce((a, r) => a + r.n, 0); return t ? pct(rows.find((r) => r._id === ok)?.n ?? 0, t) : null; };
    return {
        days,
        activation: { newWorkspaces: orgs.length, activated, setupCompletionRate: pct(orgs.filter((o) => o.activatedAt).length, orgs.length), medianHoursToFirstEmail: hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null },
        sales: { qualifiedOpportunities: s.qualified_opportunity ?? 0, proposalsSent: s.proposal_sent ?? 0, confirmedWins: s.won ?? 0 },
        conversion: { positiveReplyRate: pct(s.positive_reply ?? 0, s.delivered ?? s.contacted ?? 0), opportunityToProposalRate: pct(s.proposal_sent ?? 0, s.qualified_opportunity ?? 0), winRate: pct(s.won ?? 0, (s.won ?? 0) + (s.lost ?? 0)) },
        economics: {
            usageCostMinor: usageCost, netRevenueMinor: netRevenue, currency: "INR",
            costPerQualifiedOpportunityMinor: s.qualified_opportunity ? Math.round(usageCost / s.qualified_opportunity) : null,
            costPerWinMinor: s.won ? Math.round(usageCost / s.won) : null,
            grossMarginPercent: netRevenue > 0 ? pct(netRevenue - usageCost, netRevenue) : null,
        },
        reliability: { apiErrorRate: apiMetrics(15).errorRate, jobFailureRate: pct(failedJobs, allJobs), oldestQueuedSec: oldestQueued ? Math.round((Date.now() - oldestQueued.nextRunAt!.getTime()) / 1000) : 0, emailProvidersHealthy: health(emailIntegrations, "connected"), integrationsHealthy: health(oauth, "connected") },
        retention: { activeWorkspaces: activeOrgs.length, repeatUseWorkspaces: repeat.length, cancellations: cancelled },
        aiDecisions: {
            total: totalDecisions, executedAutomatically: dec("allowed"), sentForApproval: dec("approval_required"), blocked: dec("blocked"),
            escalated: decisions.filter((d) => d._id.a === "escalate").reduce((a, d) => a + d.n, 0),
            approvedByHumans: pct(ap.approved ?? 0, decided), rejectedByHumans: pct(ap.rejected ?? 0, decided),
        },
        definitions: {
            qualifiedOpportunities: "genuine interest from an ICP-qualified lead, or captured requirements (not just a positive reply)",
            confirmedWins: "recorded acceptance handed over to delivery (a generated or sent proposal is not revenue)",
            netRevenue: "invoices paid minus refunds, as reported by the billing provider",
        },
    };
}

// a few recent AI outputs for a human to read: quality is judged by sampling, not by volume
export async function sampleOutputs(limit = 10) {
    const [decisions, messages] = await Promise.all([
        SalesDecision.aggregate([{ $sample: { size: limit } }, { $project: { action: 1, reason: 1, state: 1, policyDecision: 1, decidedBy: 1, createdAt: 1 } }]).option(X),
        Message.aggregate([{ $match: { direction: "outbound", kind: { $in: ["outreach", "reply", "follow_up"] } } }, { $sample: { size: limit } }, { $project: { kind: 1, subject: 1, body: { $substrCP: ["$body", 0, 600] }, status: 1, createdAt: 1 } }]).option(X),
    ]);
    return { decisions, messages };
}
