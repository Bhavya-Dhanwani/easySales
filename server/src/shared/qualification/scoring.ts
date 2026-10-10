// Deterministic lead scoring: the model extracts and explains evidence, this code scores it.

export const CRITERIA = [
    { id: "industry", label: "Industry match" },
    { id: "company_size", label: "Company size match" },
    { id: "service_need", label: "Service need or relevant business signal" },
    { id: "geography", label: "Geographic fit" },
    { id: "budget", label: "Budget or ability-to-buy evidence" },
    { id: "contact_relevance", label: "Contact relevance" },
] as const;

export type CriterionId = (typeof CRITERIA)[number]["id"];
export type Match = "match" | "partial" | "mismatch" | "unknown";

export const DEFAULT_WEIGHTS: Record<CriterionId, number> = {
    industry: 25, company_size: 15, service_need: 25, geography: 10, budget: 15, contact_relevance: 10,
};

const FACTOR: Record<Match, number> = { match: 1, partial: 0.5, mismatch: 0, unknown: 0 };

/*
    score = weighted fit over all criteria; evidenceCoverage = share of weight that is known.
    An unknown criterion earns nothing but is reported separately, so missing evidence is
    never mistaken for a mismatch.
*/
export function calculateLeadScore(criteria: { weight: number; result: Match }[]) {
    const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
    if (totalWeight <= 0) throw new Error("Total scoring weight must be positive");
    const earned = criteria.reduce((sum, c) => sum + c.weight * FACTOR[c.result], 0);
    const known = criteria.reduce((sum, c) => sum + (c.result === "unknown" ? 0 : c.weight), 0);
    return {
        score: Math.round((earned / totalWeight) * 100),
        evidenceCoverage: Math.round((known / totalWeight) * 100),
    };
}

export interface Thresholds {
    minimumScore: number;
    minimumEvidenceCoverage: number;
    reviewScore: number;
}

export type LeadStatus = "qualified" | "needs_review" | "disqualified";

// status rules; only a *verified* mandatory disqualifier disqualifies
export function decideStatus(
    r: { score: number; evidenceCoverage: number; verifiedDisqualifiers: string[]; conflicts: string[] },
    t: Thresholds,
): { status: LeadStatus; reasons: string[] } {
    if (r.verifiedDisqualifiers.length) return { status: "disqualified", reasons: r.verifiedDisqualifiers.map((d) => `Disqualifier: ${d}`) };
    const reasons: string[] = [];
    if (r.conflicts.length) reasons.push(...r.conflicts.map((c) => `Conflicting evidence: ${c}`));
    if (r.evidenceCoverage < t.minimumEvidenceCoverage) reasons.push(`Evidence coverage ${r.evidenceCoverage}% is below ${t.minimumEvidenceCoverage}%`);
    if (r.score < t.minimumScore) reasons.push(`Fit score ${r.score} is below ${t.minimumScore}`);
    if (!reasons.length) return { status: "qualified", reasons };
    if (r.score < t.reviewScore && r.evidenceCoverage >= t.minimumEvidenceCoverage && !r.conflicts.length) {
        reasons.push("Low fit with enough evidence: review and close if it is not a match");
    }
    return { status: "needs_review", reasons };
}
