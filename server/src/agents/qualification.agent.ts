// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";

export const QualificationSchema = z.object({
    score: z.number().int().min(0).max(100).describe("fit against the ideal customer profile"),
    rationale: z.string().describe("2-4 sentences explaining the score"),
    matchedSignals: z.array(z.string()),
    disqualifiersHit: z.array(z.string()).describe("exact disqualifier texts from the ICP that clearly apply; empty if none"),
    missingInformation: z.array(z.string()),
});

export type QualificationStatus = "qualified" | "disqualified" | "needs_review";

/*
    Qualification agent: the model scores fit, deterministic rules make the decision.
    Any disqualifier → disqualified; score ≥ policy minimum → qualified; else needs_review.
*/
export async function qualifyLead(
    ctx: AgentRunContext,
    lead: { company: { name: string; industry?: string | null; size?: string | null; country?: string | null } },
    research: { summary?: string | null; needs?: string[] },
    profile: ProfileForPrompt,
    minimumScore: number,
) {

    const data = await runAgent(ctx, "qualification", {
        schema: QualificationSchema,
        tier: "fast",
        system: `You are the Qualification Agent. Score how well a prospect fits the business's ideal customer profile (ICP). Be strict and evidence-based; unknown information lowers confidence, it is not a match.
${UNTRUSTED_RULES}

${businessBrief(profile)}`,
        user: `Prospect: ${lead.company.name}
Industry: ${lead.company.industry || "(unknown)"}
Size: ${lead.company.size || "(unknown)"}
Country: ${lead.company.country || "(unknown)"}

${untrusted("research-summary", `${research.summary || "(no research)"}\nLikely needs:\n${(research.needs ?? []).map((n) => `- ${n}`).join("\n")}`)}`,
    });

    // only disqualifiers the owner actually configured count
    const configured = (profile.idealCustomerProfile?.disqualifiers ?? []).map((d) => d.toLowerCase().trim());
    const hits = data.disqualifiersHit.filter((d) => configured.includes(d.toLowerCase().trim()));

    const status: QualificationStatus = hits.length ? "disqualified" : data.score >= minimumScore ? "qualified" : "needs_review";

    return {
        score: data.score,
        rationale: data.rationale,
        flags: [...hits.map((h) => `disqualifier: ${h}`), ...data.missingInformation.map((m) => `missing: ${m}`)],
        status,
    };

}
