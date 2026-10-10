// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";

export const EmailDraftSchema = z.object({
    subject: z.string().min(3).max(120),
    body: z.string().min(20).max(3000).describe("plain-text email body without signature placeholders or an unsubscribe line"),
});

// deterministic footer: every commercial email carries an opt-out, regardless of what the model wrote
export function withOptOut(body: string, businessName: string) {
    return `${body.trim()}\n\n—\n${businessName || "Our team"}\nNot interested? Reply "unsubscribe" and we won't contact you again.`;
}

/*
    Outreach agent: writes a short, specific first-touch or follow-up email grounded
    only in verified research and approved claims.
*/
export async function draftOutreach(
    ctx: AgentRunContext,
    lead: { company: { name: string }; contact?: { name?: string | null; title?: string | null } | null },
    research: { summary?: string | null; needs?: string[] },
    profile: ProfileForPrompt,
    opts: { followUpNumber?: number; previousSubject?: string } = {},
) {

    const isFollowUp = Boolean(opts.followUpNumber);
    const draft = await runAgent(ctx, isFollowUp ? "follow_up" : "outreach", {
        schema: EmailDraftSchema,
        tier: "smart",
        system: `You are the Outreach Agent of an AI business development team writing on behalf of the business below.
${UNTRUSTED_RULES}
Writing rules:
- ${isFollowUp ? `This is follow-up #${opts.followUpNumber}. Be brief (under 80 words), add one new angle, reference the earlier email lightly.` : "First touch: under 140 words, one specific observation about their business, one relevant way you can help, one low-friction question as call to action."}
- Use only approved claims. Never invent results, clients, statistics, discounts, prices or deadlines.
- No hype, no fake urgency, no flattery. Sound like a thoughtful human in the brand voice.
- Do not include a signature block or unsubscribe line (added automatically).

${businessBrief(profile)}`,
        user: `Write to ${lead.contact?.name || "the team"}${lead.contact?.title ? ` (${lead.contact.title})` : ""} at ${lead.company.name}.
${opts.previousSubject ? `Previous subject: ${opts.previousSubject}\n` : ""}
${untrusted("research", `${research.summary || "(no research)"}\nLikely needs:\n${(research.needs ?? []).map((n) => `- ${n}`).join("\n")}`)}`,
    });

    return { subject: draft.subject.trim(), body: withOptOut(draft.body, profile.businessName || "") };

}
