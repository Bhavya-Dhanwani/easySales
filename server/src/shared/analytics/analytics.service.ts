// Importing modules
import mongoose from "mongoose";
import FunnelEvent, { FunnelStage } from "../models/funnelEvent.model.js";
import Lead from "../models/lead.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import AgentTask from "../models/agentTask.model.js";
import Prototype from "../models/prototype.model.js";
import logger from "../config/logger.config.js";

type Id = mongoose.Types.ObjectId | string;

export const APP_VERSION = process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev";

function isoWeek(d: Date) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/*
    Records the first time a lead reaches a stage. Idempotent (unique per lead+stage) and
    never throws: analytics must not break the workflow that reports it.
*/
export async function recordStage(organizationId: Id, leadId: Id, stage: FunnelStage, metadata: Record<string, unknown> = {}) {
    try {
        const lead = await Lead.findOne({ organizationId, _id: leadId }, { createdAt: 1, "company.industry": 1, experiment: 1, isTest: 1 }).lean();
        // the onboarding rehearsal is not a prospect
        if (!lead || lead.isTest) return;
        const created = lead.createdAt ?? new Date();
        await FunnelEvent.updateOne(
            { organizationId, leadId, stage },
            {
                $setOnInsert: {
                    organizationId, leadId, stage, occurredAt: new Date(), metadata, workflowVersion: APP_VERSION,
                    cohortMonth: created.toISOString().slice(0, 7), cohortWeek: isoWeek(created),
                    segment: lead.company?.industry?.trim().toLowerCase() || "unknown",
                    experimentId: lead.experiment?.id, variantId: lead.experiment?.variantId,
                },
            },
            { upsert: true },
        );
    } catch (error) {
        if ((error as { code?: number }).code !== 11000) logger.warn({ error: (error as Error).message, stage }, "Funnel event not recorded");
    }
}

// imports create many leads at once: one bulk upsert instead of a round trip per lead
export async function recordDiscoveredImport(organizationId: mongoose.Types.ObjectId, importId: Id) {
    const leads = await Lead.find({ organizationId, "source.importId": importId }, { createdAt: 1, "company.industry": 1 }).lean();
    if (!leads.length) return;
    await FunnelEvent.bulkWrite(leads.map((l) => {
        const created = l.createdAt ?? new Date();
        return {
            updateOne: {
                filter: { organizationId, leadId: l._id, stage: "discovered" },
                update: { $setOnInsert: { organizationId, leadId: l._id, stage: "discovered", occurredAt: created, workflowVersion: APP_VERSION, metadata: { source: "import" }, cohortMonth: created.toISOString().slice(0, 7), cohortWeek: isoWeek(created), segment: l.company?.industry?.trim().toLowerCase() || "unknown" } },
                upsert: true,
            },
        };
    }), { ordered: false }).catch((e) => logger.warn({ error: (e as Error).message }, "Import funnel events not recorded"));
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// the rate definitions, in one place for dashboards, cohorts and experiments
export function funnelRates(c: Partial<Record<FunnelStage, number>>, deliveryReported: boolean) {
    const n = (s: FunnelStage) => c[s] ?? 0;
    const reached = deliveryReported ? n("delivered") : n("contacted");
    return {
        icpQualificationRate: ratio(n("icp_qualified"), n("researched")),
        deliveryRate: deliveryReported ? ratio(n("delivered"), n("contacted")) : null,
        positiveReplyRate: ratio(n("positive_reply"), reached),
        qualificationRate: ratio(n("qualified_opportunity"), n("contacted")),
        proposalRate: ratio(n("proposal_sent"), n("qualified_opportunity")),
        winRate: ratio(n("won"), n("won") + n("lost")),
    };
}

/*
    Cohort funnel: leads grouped by when they were acquired (month or ISO week), optionally
    by segment. Young cohorts are flagged incomplete: they have not had time to reply or close.
*/
export async function funnelAnalytics(organizationId: mongoose.Types.ObjectId, opts: { groupBy?: "month" | "week"; bySegment?: boolean; maturityDays?: number } = {}) {
    const key = opts.groupBy === "week" ? "$cohortWeek" : "$cohortMonth";
    const rows = await FunnelEvent.aggregate([
        { $match: { organizationId } },
        { $group: { _id: { cohort: key, segment: opts.bySegment ? "$segment" : null, stage: "$stage" }, n: { $sum: 1 }, first: { $min: "$occurredAt" } } },
    ]);
    const deliveryReported = rows.some((r) => r._id.stage === "delivered");
    const cohorts = new Map<string, { cohort: string; segment: string | null; counts: Partial<Record<FunnelStage, number>>; firstEventAt: Date }>();
    const totals: Partial<Record<FunnelStage, number>> = {};
    for (const r of rows) {
        const k = `${r._id.cohort}|${r._id.segment ?? ""}`;
        const c = cohorts.get(k) ?? { cohort: r._id.cohort, segment: r._id.segment, counts: {} as Partial<Record<FunnelStage, number>>, firstEventAt: r.first as Date };
        c.counts[r._id.stage as FunnelStage] = r.n;
        if (r.first < c.firstEventAt) c.firstEventAt = r.first;
        cohorts.set(k, c);
        totals[r._id.stage as FunnelStage] = (totals[r._id.stage as FunnelStage] ?? 0) + r.n;
    }
    const matureAfter = (opts.maturityDays ?? 30) * 86400_000;
    return {
        definitions: {
            icpQualificationRate: "ICP-qualified ÷ researched", deliveryRate: "delivered ÷ contacted (only when the provider reports delivery)",
            positiveReplyRate: "prospects with a positive reply ÷ delivered (or contacted)", qualificationRate: "qualified opportunities ÷ contacted",
            proposalRate: "proposals sent ÷ qualified opportunities", winRate: "won ÷ (won + lost)",
        },
        deliveryReported,
        totals: { counts: totals, rates: funnelRates(totals, deliveryReported) },
        cohorts: [...cohorts.values()].sort((a, b) => (a.cohort < b.cohort ? 1 : -1)).map((c) => ({
            cohort: c.cohort, segment: c.segment, counts: c.counts, rates: funnelRates(c.counts, deliveryReported),
            incomplete: Date.now() - c.firstEventAt.getTime() < matureAfter,
        })),
    };
}

// agent / resource → funnel stage the money was spent on
const CATEGORY = {
    $switch: {
        branches: [
            { case: { $eq: ["$agent", "research"] }, then: "research" },
            { case: { $in: ["$agent", ["outreach", "follow_up"]] }, then: "outreach" },
            { case: { $eq: ["$kind", "email"] }, then: "outreach" },
            { case: { $eq: ["$agent", "conversation"] }, then: "conversation" },
            { case: { $in: ["$agent", ["requirements", "prototype_builder"]] }, then: "demo" },
            { case: { $eq: ["$kind", "prototype"] }, then: "demo" },
            { case: { $eq: ["$agent", "proposal"] }, then: "proposal" },
        ],
        default: "other",
    },
};
const ACQUISITION = ["research", "outreach", "conversation"];

/*
    Where the money went: by funnel stage, per opportunity, cost per qualified
    opportunity, and spend that bought nothing (disqualified leads, failed builds).
*/
export async function costAnalytics(organizationId: mongoose.Types.ObjectId, days = 30) {
    const since = new Date(Date.now() - days * 86400_000);
    const match = { $match: { organizationId, createdAt: { $gte: since } } };
    const [byCategory, perLead, qualified, failedTasks] = await Promise.all([
        UsageRecord.aggregate([match, { $group: { _id: CATEGORY, costMinor: { $sum: "$costMinor" }, units: { $sum: "$quantity" }, tokens: { $sum: { $add: ["$inputTokens", "$outputTokens"] } } } }, { $sort: { costMinor: -1 } }]),
        UsageRecord.aggregate([match, { $match: { leadId: { $ne: null } } }, { $group: { _id: "$leadId", costMinor: { $sum: "$costMinor" }, calls: { $sum: 1 } } }, { $sort: { costMinor: -1 } }, { $limit: 200 }]),
        FunnelEvent.countDocuments({ organizationId, stage: "qualified_opportunity", occurredAt: { $gte: since } }),
        AgentTask.countDocuments({ organizationId, status: "failed", createdAt: { $gte: since } }),
    ]);
    const leadIds = perLead.map((r) => r._id);
    const [leads, stages, failedProtos] = await Promise.all([
        Lead.find({ organizationId, _id: { $in: leadIds } }, { "company.name": 1, status: 1, opportunityStage: 1 }).lean(),
        FunnelEvent.find({ organizationId, leadId: { $in: leadIds } }, { leadId: 1, stage: 1 }).lean(),
        Prototype.find({ organizationId, status: "failed", createdAt: { $gte: since } }, { costMinorUnits: 1 }).lean(),
    ]);
    const leadOf = new Map(leads.map((l) => [String(l._id), l]));
    const reached = new Map<string, string[]>();
    for (const s of stages) reached.set(String(s.leadId), [...(reached.get(String(s.leadId)) ?? []), s.stage]);
    const acquisition = byCategory.filter((c) => ACQUISITION.includes(c._id)).reduce((a, c) => a + c.costMinor, 0);
    const disqualifiedSpend = perLead.filter((r) => leadOf.get(String(r._id))?.status === "disqualified").reduce((a, r) => a + r.costMinor, 0);
    return {
        days,
        totalMinor: byCategory.reduce((a, c) => a + c.costMinor, 0),
        byStage: byCategory.map((c) => ({ stage: c._id, costMinor: c.costMinor, units: c.units, tokens: c.tokens })),
        costPerQualifiedOpportunityMinor: qualified ? Math.round(acquisition / qualified) : null,
        qualifiedOpportunities: qualified,
        waste: {
            disqualifiedLeadsMinor: disqualifiedSpend,
            failedPrototypesMinor: failedProtos.reduce((a, p) => a + (p.costMinorUnits ?? 0), 0),
            failedAgentCalls: failedTasks,
        },
        // aggregated per opportunity: name and stage only, no contact data
        topOpportunities: perLead.slice(0, 20).map((r) => ({
            leadId: String(r._id), company: leadOf.get(String(r._id))?.company?.name ?? "(deleted)",
            costMinor: r.costMinor, calls: r.calls, stagesReached: reached.get(String(r._id)) ?? [],
        })),
    };
}

/*
    Does the score predict outcomes? Leads per priority band with how far they got, and how
    often each criterion is unknown (where research needs better evidence).
*/
export async function leadQuality(organizationId: mongoose.Types.ObjectId) {
    const [bands, unknowns, events] = await Promise.all([
        Lead.aggregate([
            { $match: { organizationId, "qualification.score": { $ne: null } } },
            { $group: { _id: { $ifNull: ["$qualification.priority", "unscored"] }, leads: { $sum: 1 }, ids: { $push: "$_id" }, avgScore: { $avg: "$qualification.score" }, avgCoverage: { $avg: "$qualification.evidenceCoverage" } } },
        ]),
        Lead.aggregate([
            { $match: { organizationId, "qualification.criteria.0": { $exists: true } } },
            { $unwind: "$qualification.criteria" },
            { $group: { _id: "$qualification.criteria.criterionId", total: { $sum: 1 }, unknown: { $sum: { $cond: [{ $eq: ["$qualification.criteria.result", "unknown"] }, 1, 0] } } } },
        ]),
        FunnelEvent.find({ organizationId, stage: { $in: ["contacted", "positive_reply", "qualified_opportunity", "won"] } }, { leadId: 1, stage: 1 }).lean(),
    ]);
    const byLead = new Map<string, Set<string>>();
    for (const e of events) byLead.set(String(e.leadId), (byLead.get(String(e.leadId)) ?? new Set()).add(e.stage));
    const count = (ids: mongoose.Types.ObjectId[], stage: string) => ids.filter((id) => byLead.get(String(id))?.has(stage)).length;
    return {
        bands: bands.map((b) => {
            const contacted = count(b.ids, "contacted");
            return {
                priority: b._id, leads: b.leads, avgScore: Math.round(b.avgScore), avgEvidenceCoverage: Math.round(b.avgCoverage ?? 0),
                contacted, positiveReplies: count(b.ids, "positive_reply"), qualifiedOpportunities: count(b.ids, "qualified_opportunity"), won: count(b.ids, "won"),
                positiveReplyRate: ratio(count(b.ids, "positive_reply"), contacted),
            };
        }).sort((a, b) => ["high", "medium", "low", "unscored"].indexOf(a.priority) - ["high", "medium", "low", "unscored"].indexOf(b.priority)),
        evidenceGaps: unknowns.map((u) => ({ criterion: u._id, unknownRate: ratio(u.unknown, u.total) })).sort((a, b) => (b.unknownRate ?? 0) - (a.unknownRate ?? 0)),
    };
}
