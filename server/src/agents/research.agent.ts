// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";
import { htmlToText, safeFetch } from "../shared/utils/safeFetch.util.js";

export const ResearchSchema = z.object({
    summary: z.string().describe("3-5 sentence neutral summary of what the company does and who it serves"),
    industry: z.string().describe("best-guess industry, empty string if unknown"),
    size: z.string().describe("best-guess company size band, empty string if unknown"),
    needs: z.array(z.string()).max(6).describe("likely needs this business could help with; phrase as hypotheses"),
    evidence: z.array(z.object({
        claim: z.string(),
        fromWebsite: z.boolean().describe("true only if the claim is directly supported by the fetched website text"),
        confidence: z.number().min(0).max(1),
    })).max(10),
});

export type Research = z.infer<typeof ResearchSchema>;

export interface ResearchInput {
    company: { name: string; website?: string | null; industry?: string | null; country?: string | null };
    contact?: { name?: string | null; title?: string | null };
}

/*
    Research agent: reads the prospect's public website (SSRF-guarded) and produces a
    summary with evidence. Claims are only marked verified when they come from the page
    we actually fetched; everything else is a hypothesis.
*/
export async function researchLead(ctx: AgentRunContext, input: ResearchInput, profile: ProfileForPrompt) {

    let page: { url: string; title: string; description: string; text: string } | null = null;
    let fetchError: string | null = null;
    if (input.company.website) {
        try {
            const fetched = await safeFetch(input.company.website);
            page = { url: fetched.url, ...htmlToText(fetched.body) };
        } catch (error) {
            fetchError = (error as Error).message;
        }
    }

    const data = await runAgent(ctx, "research", {
        schema: ResearchSchema,
        tier: "smart",
        system: `You are the Research Agent of an AI business development team. You study a prospect company to find out whether and how the business below could help them.
${UNTRUSTED_RULES}
Be factual. Separate verified facts (from the website text) from inferred needs. Never invent numbers, clients or people.

${businessBrief(profile)}`,
        user: `Prospect:
Company: ${input.company.name}
Website: ${input.company.website || "(none)"}
Known industry: ${input.company.industry || "(unknown)"}
Country: ${input.company.country || "(unknown)"}
Contact: ${input.contact?.name || "(unknown)"}${input.contact?.title ? `, ${input.contact.title}` : ""}

${page ? untrusted(page.url, `Title: ${page.title}\nDescription: ${page.description}\n\n${page.text}`) : `Website could not be read${fetchError ? ` (${fetchError})` : ""}. Work only from the details above and mark every claim fromWebsite=false.`}`,
    });

    return {
        ...data,
        sourceUrl: page?.url ?? null,
        fetchError,
        // a claim is only verified if we really fetched the page it supposedly came from
        evidence: data.evidence.map((e) => ({
            claim: e.claim,
            confidence: e.confidence,
            verified: Boolean(page && e.fromWebsite),
            sourceUrl: page && e.fromWebsite ? page.url : undefined,
        })),
    };

}
