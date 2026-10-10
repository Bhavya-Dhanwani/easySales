// Importing modules
import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import { getCurrentPolicy } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { calculateLeadScore, CRITERIA, CriterionId, decideStatus, DEFAULT_WEIGHTS, Match } from "../qualification/scoring.js";
import { researchLead } from "../../agents/research.agent.js";
import { ProfileForPrompt } from "../../agents/prompts.js";
import NotFound from "../errors/NotFound.error.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId | string;

function weightsOf(profile: { scoringWeights?: unknown } | null) {
    const custom = (profile?.scoringWeights ?? {}) as Partial<Record<CriterionId, number>>;
    return { ...DEFAULT_WEIGHTS, ...custom };
}

// deterministic qualification from evaluated criteria
async function qualify(
    organizationId: Id,
    profile: { scoringWeights?: unknown; version?: number } | null,
    criteria: { criterionId: string; label?: string | null; result: Match; explanation?: string | null; evidenceUrls?: string[] }[],
    verifiedDisqualifiers: string[],
    conflicts: string[],
) {
    const { config, version: policyVersion } = await getCurrentPolicy(organizationId);
    const weights = weightsOf(profile);
    const weighted = CRITERIA.map((c) => {
        const found = criteria.find((x) => x.criterionId === c.id);
        return { criterionId: c.id, label: c.label, weight: weights[c.id], result: (found?.result ?? "unknown") as Match, explanation: found?.explanation ?? "", evidenceUrls: found?.evidenceUrls ?? [] };
    });
    const { score, evidenceCoverage } = calculateLeadScore(weighted);
    const { status, reasons } = decideStatus({ score, evidenceCoverage, verifiedDisqualifiers, conflicts }, config.qualification);
    return {
        status,
        qualification: {
            score, evidenceCoverage, criteria: weighted, flags: reasons,
            rationale: status === "qualified"
                ? `Fit ${score}/100 with ${evidenceCoverage}% evidence coverage.`
                : `${reasons[0] ?? "Needs review"}.`,
            evaluatedAt: new Date(), profileVersion: profile?.version ?? 1, policyVersion,
        },
    };
}

/*
    Research + qualification for one lead. `requestedAt` is when the job was requested:
    the report is only written if no newer job has already written one, so a slow retry
    can never overwrite fresher research.
*/
export async function runResearch(opts: { organizationId: Id; leadId: Id; workflowId?: string; correlationId?: string; requestedAt: Date }) {
    const { organizationId, leadId, requestedAt } = opts;
    const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
    if (!lead) throw new NotFound("Lead no longer exists");
    const profile = await BusinessProfile.findOne({ organizationId }).lean();

    const notNewer = { $or: [{ "research.generatedAt": { $exists: false } }, { "research.generatedAt": null }, { "research.generatedAt": { $lte: requestedAt } }] };
    await Lead.updateOne({ organizationId, _id: leadId, ...notNewer }, { status: "researching", "research.status": "running" });

    const r = await researchLead(
        { organizationId, workflowId: opts.workflowId, correlationId: opts.correlationId },
        { company: lead.company, contact: lead.contact },
        (profile ?? {}) as ProfileForPrompt,
    );
    const { status, qualification } = await qualify(organizationId, profile, r.criteria, r.verifiedDisqualifiers, r.conflicts);

    const set: Record<string, unknown> = {
        status,
        research: {
            status: "done", summary: r.summary, needs: r.needs, evidence: r.evidence, sources: r.sources,
            conflicts: r.conflicts, generatedAt: requestedAt, researchedAt: new Date(), profileVersion: profile?.version ?? 1,
        },
        qualification,
    };
    if (!lead.company.industry && r.industry) set["company.industry"] = r.industry;
    if (!lead.company.employeeCount && r.employeeCount) set["company.employeeCount"] = r.employeeCount;

    const written = await Lead.updateOne({ organizationId, _id: leadId, ...notNewer }, { $set: set });
    if (!written.matchedCount) return { status, stale: true };

    if (status === "qualified") {
        await Lead.updateOne({ organizationId, _id: leadId, opportunityStage: "new" }, { opportunityStage: "qualified" });
        await Lead.updateOne({ organizationId, _id: leadId, outreachStatus: "not_started" }, { outreachStatus: "eligible" });
    }
    await audit({
        organizationId, actorType: "agent", actorId: "research", action: "lead.qualified",
        targetType: "lead", targetId: String(leadId), outcome: "success", correlationId: opts.correlationId,
        policyVersion: qualification.policyVersion,
        metadata: { status, score: qualification.score, evidenceCoverage: qualification.evidenceCoverage, profileVersion: qualification.profileVersion },
    });
    return { status, stale: false };
}

// re-score stored research against the current ICP weights and thresholds (no AI call)
export async function requalify(organizationId: Id, leadId: Id, userId: string) {
    const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    if (lead.research?.status !== "done" || !lead.qualification?.criteria?.length) throw new Conflict("Research the lead before re-qualifying it");
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    const disq = (lead.qualification.flags ?? []).filter((f) => f.startsWith("Disqualifier: ")).map((f) => f.slice(14));
    const { status, qualification } = await qualify(organizationId, profile, lead.qualification.criteria as never, disq, lead.research.conflicts ?? []);
    await Lead.updateOne({ organizationId, _id: leadId }, { status, qualification });
    await audit({ organizationId, actorType: "user", actorId: userId, action: "lead.requalified", targetType: "lead", targetId: String(leadId), outcome: "success", metadata: { status, score: qualification.score } });
    return { status, qualification };
}
