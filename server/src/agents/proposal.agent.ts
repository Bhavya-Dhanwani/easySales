// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";

export const ProposalNarrativeSchema = z.object({
    title: z.string().max(140),
    understanding: z.string().describe("our understanding of their goals, 1 short paragraph"),
    approach: z.array(z.string()).min(2).max(8).describe("scope / approach bullet points"),
    nextSteps: z.array(z.string()).min(1).max(5),
});

/*
    Proposal agent: writes the prose only. Line items, discount and totals are computed
    by the deterministic pricing engine and rendered into the document by code, so the
    model cannot change a number.
*/
export async function writeProposal(
    ctx: AgentRunContext,
    lead: { company: { name: string }; requirements?: { needs?: string[]; budget?: string | null; timeline?: string | null } | null },
    conversationSummary: string,
    items: { name: string }[],
    profile: ProfileForPrompt,
) {

    return runAgent(ctx, "proposal", {
        schema: ProposalNarrativeSchema,
        tier: "smart",
        system: `You are the Proposal Agent. Write the narrative sections of a concise, professional proposal.
${UNTRUSTED_RULES}
Rules: do not mention any price, discount, currency or number of days; do not promise anything beyond the listed services and approved claims.

${businessBrief(profile)}`,
        user: `Client: ${lead.company.name}
Selected services: ${items.map((i) => i.name).join(", ")}

${untrusted("discovery-notes", `Needs: ${(lead.requirements?.needs ?? []).join("; ") || "(not captured)"}
Timeline (as stated): ${lead.requirements?.timeline || "(not stated)"}
Conversation summary: ${conversationSummary || "(none)"}`)}`,
    });

}
