// Importing modules
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import Experiment from "../models/experiment.model.js";
import Lead from "../models/lead.model.js";
import FunnelEvent from "../models/funnelEvent.model.js";
import { funnelRates } from "../analytics/analytics.service.js";
import NotFound from "../errors/NotFound.error.js";

type Id = mongoose.Types.ObjectId | string;

// same experiment + lead always lands in the same variant
export function variantIndex(experimentId: string, leadId: string, variants: number) {
    return createHash("sha256").update(`${experimentId}:${leadId}`).digest().readUInt32BE(0) % variants;
}

/*
    The variant instruction for a first-touch email, if this lead is (or now becomes) part
    of a running experiment. A lead is assigned at most once, so it never sees two
    experiments; a paused or finished experiment no longer shapes new messages.
*/
export async function variantFor(organizationId: Id, leadId: Id, campaignId?: Id | null) {
    const lead = await Lead.findOne({ organizationId, _id: leadId }, { experiment: 1, "qualification.score": 1, "company.industry": 1 }).lean();
    if (!lead) return null;
    if (lead.experiment?.id) {
        const exp = await Experiment.findOne({ organizationId, _id: lead.experiment.id, status: "running" }).lean();
        const v = exp?.variants.find((x) => x.id === lead.experiment!.variantId);
        return exp && v ? { experimentId: exp._id, variantId: v.id, instruction: v.instruction, variable: exp.variable } : null;
    }
    const running = await Experiment.find({ organizationId, status: "running" }).sort({ startedAt: 1 }).lean();
    const industry = lead.company?.industry?.trim().toLowerCase();
    const exp = running.find((e) =>
        (!e.audience?.campaignId || String(e.audience.campaignId) === String(campaignId ?? "")) &&
        (!e.audience?.industries?.length || (industry && e.audience.industries.map((i) => i.toLowerCase()).includes(industry))) &&
        (e.audience?.minScore == null || (lead.qualification?.score ?? 0) >= e.audience.minScore));
    if (!exp) return null;
    const v = exp.variants[variantIndex(String(exp._id), String(leadId), exp.variants.length)];
    const set = await Lead.updateOne(
        { organizationId, _id: leadId, "experiment.id": { $exists: false } },
        { experiment: { id: exp._id, variantId: v.id, assignedAt: new Date() } },
    );
    // lost a race to another assignment: use whatever won
    if (!set.modifiedCount) return variantFor(organizationId, leadId, campaignId);
    return { experimentId: exp._id, variantId: v.id, instruction: v.instruction, variable: exp.variable };
}

// two-proportion z-test against the control; |z| >= 1.96 is ~95% confidence
function zScore(x1: number, n1: number, x2: number, n2: number) {
    if (!n1 || !n2) return null;
    const p = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return se ? Math.round(((x2 / n2 - x1 / n1) / se) * 100) / 100 : null;
}

/*
    Per-variant funnel from the same events as the dashboard. No result is called before
    the stopping rule (minimum contacted per variant) is met.
*/
export async function experimentResults(organizationId: mongoose.Types.ObjectId, experimentId: string) {
    const exp = await Experiment.findOne({ organizationId, _id: experimentId }).lean();
    if (!exp) throw new NotFound("Experiment not found");
    const [assigned, events] = await Promise.all([
        Lead.aggregate([{ $match: { organizationId, "experiment.id": exp._id } }, { $group: { _id: "$experiment.variantId", n: { $sum: 1 } } }]),
        FunnelEvent.aggregate([{ $match: { organizationId, experimentId: exp._id } }, { $group: { _id: { v: "$variantId", stage: "$stage" }, n: { $sum: 1 } } }]),
    ]);
    const deliveryReported = events.some((e) => e._id.stage === "delivered");
    const variants = exp.variants.map((v) => {
        const counts = Object.fromEntries(events.filter((e) => e._id.v === v.id).map((e) => [e._id.stage, e.n]));
        return { id: v.id, label: v.label, assigned: assigned.find((a) => a._id === v.id)?.n ?? 0, counts, rates: funnelRates(counts, deliveryReported) };
    });
    const metricStage = exp.primaryMetric === "qualified_opportunity_rate" ? "qualified_opportunity" : "positive_reply";
    const base = deliveryReported ? "delivered" : "contacted";
    const control = variants[0];
    const stoppingRuleMet = variants.every((v) => (v.counts.contacted ?? 0) >= exp.minSamplePerVariant);
    return {
        experiment: exp,
        stoppingRuleMet,
        variants: variants.map((v, i) => ({
            ...v,
            zVsControl: i === 0 ? null : zScore(control.counts[metricStage] ?? 0, control.counts[base] ?? 0, v.counts[metricStage] ?? 0, v.counts[base] ?? 0),
        })),
        note: stoppingRuleMet ? "Sample reached. |z| ≥ 1.96 means the difference is unlikely to be chance." : `Not enough data yet: each variant needs ${exp.minSamplePerVariant} contacted prospects.`,
    };
}
