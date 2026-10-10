// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";
import { LEAD_RECORD } from "./research.agent.js";

export const EmailDraftSchema = z.object({
    subject: z.string().min(3).max(120),
    body: z.string().min(20).max(3000).describe("plain-text email body without signature placeholders or an unsubscribe line"),
    personalizationClaims: z.array(z.object({
        claim: z.string().describe("a specific statement about the prospect used in the email"),
        evidenceUrl: z.string().describe(`the source URL from the research evidence list, or "${LEAD_RECORD}"`),
    })).max(5),
    proposedCallToAction: z.string(),
    confidence: z.number().min(0).max(1),
    needsReview: z.boolean().describe("true if you are unsure the email is accurate, appropriate or within approved claims"),
});

// deterministic footer: every commercial email carries an opt-out, regardless of what the model wrote
export function withOptOut(body: string, businessName: string) {
    return `${body.trim()}\n\n—\n${businessName || "Our team"}\nNot interested? Reply "unsubscribe" and we won't contact you again.`;
}

interface ResearchForDraft {
    summary?: string | null;
    needs?: string[];
    sources?: string[];
    evidence?: { claim: string; sourceUrl?: string | null; verified?: boolean | null }[];
}

/*
    Outreach agent: writes a short, specific first-touch or follow-up email grounded
    only in verified research and approved claims. Every personalisation claim must cite
    research evidence; uncited claims are flagged so the policy gate escalates to a human.
*/
export async function draftOutreach(
    ctx: AgentRunContext,
    lead: { company: { name: string }; contact?: { name?: string | null; title?: string | null } | null },
    research: ResearchForDraft,
    profile: ProfileForPrompt,
    opts: { followUpNumber?: number; previousSubject?: string; objective?: string } = {},
) {

    const isFollowUp = Boolean(opts.followUpNumber);
    const verified = (research.evidence ?? []).filter((e) => e.verified);
    const draft = await runAgent(ctx, isFollowUp ? "follow_up" : "outreach", {
        schema: EmailDraftSchema,
        tier: "smart",
        system: `You are the Outreach Agent of an AI business development team writing on behalf of the business below.
${UNTRUSTED_RULES}
Writing rules:
- ${isFollowUp ? `This is follow-up #${opts.followUpNumber}. Be brief (under 80 words), add one new angle, reference the earlier email lightly.` : "First touch: under 140 words, one specific observation about their business, one relevant way you can help, one low-friction question as call to action."}
- Personalise only with facts from the verified evidence list; cite each one in personalizationClaims with its source.
- Use only approved claims about the business. Never invent results, clients, testimonials, relationships, statistics, discounts, prices or deadlines.
- Never state the prospect's problems as facts; possible needs are hypotheses ("might", "if").
- No hype, no fake urgency, no flattery. Do not include a signature block or unsubscribe line (added automatically).
${opts.objective ? `- Campaign objective: ${opts.objective}` : ""}

${businessBrief(profile)}`,
        user: `Write to ${lead.contact?.name || "the team"}${lead.contact?.title ? ` (${lead.contact.title})` : ""} at ${lead.company.name}.
${opts.previousSubject ? `Previous subject: ${opts.previousSubject}\n` : ""}
${untrusted("research", `${research.summary || "(no research)"}
Verified evidence:
${verified.map((e) => `- ${e.claim} [${e.sourceUrl || LEAD_RECORD}]`).join("\n") || "- (none)"}
Possible needs (hypotheses):
${(research.needs ?? []).map((n) => `- ${n}`).join("\n")}`)}`,
    });

    // a claim is backed only if it cites a source we actually researched
    const sources = new Set([LEAD_RECORD, ...(research.sources ?? []), ...verified.map((e) => e.sourceUrl).filter((u): u is string => Boolean(u))]);
    const claims = draft.personalizationClaims.map((c) => ({ claim: c.claim, evidenceUrl: c.evidenceUrl, verified: sources.has(c.evidenceUrl) }));
    if (draft.needsReview) claims.push({ claim: "The agent flagged this draft for review", evidenceUrl: "", verified: false });

    return { subject: draft.subject.trim(), body: withOptOut(draft.body, profile.businessName || ""), claims, confidence: draft.confidence };

}
