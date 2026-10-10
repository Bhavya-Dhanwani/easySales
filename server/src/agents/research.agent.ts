// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";
import { htmlToText, safeFetch } from "../shared/utils/safeFetch.util.js";
import { CRITERIA, CriterionId } from "../shared/qualification/scoring.js";

// facts the business imported itself can be cited as this pseudo-source
export const LEAD_RECORD = "lead-record";

const CRITERION_IDS = CRITERIA.map((c) => c.id) as [CriterionId, ...CriterionId[]];

export const ResearchReportSchema = z.object({
    companySummary: z.string().describe("3-5 sentence neutral summary of what the company does and who it serves"),
    industry: z.string().describe("best-guess industry, empty string if unknown"),
    employeeCountEstimate: z.number().int().min(0).nullable().describe("null if not evidenced"),
    findings: z.array(z.object({
        claim: z.string(),
        sourceUrl: z.string().describe(`exact URL of a provided page, "${LEAD_RECORD}" for imported data, or "" if inferred`),
        confidence: z.number().min(0).max(1),
    })).max(12),
    criteria: z.array(z.object({
        criterionId: z.enum(CRITERION_IDS),
        result: z.enum(["match", "partial", "mismatch", "unknown"]),
        explanation: z.string(),
        evidenceUrls: z.array(z.string()).describe(`provided page URLs or "${LEAD_RECORD}"; empty means unknown`),
    })),
    potentialNeeds: z.array(z.object({
        need: z.string().describe("a hypothesis, never a confirmed requirement"),
        evidenceUrls: z.array(z.string()),
        confidence: z.number().min(0).max(1),
    })).max(6),
    disqualifiers: z.array(z.object({
        disqualifier: z.string().describe("exact text of a configured disqualifier"),
        evidenceUrl: z.string(),
    })),
    conflicts: z.array(z.string()).describe("contradictory facts found across sources; empty if none"),
});

export interface ResearchInput {
    company: { name: string; website?: string | null; industry?: string | null; country?: string | null; size?: string | null; employeeCount?: number | null; description?: string | null };
    contact?: { name?: string | null; title?: string | null } | null;
}

const PAGE_HINT = /about|service|solution|product|team|company|pricing|who-we|what-we/i;

// homepage plus up to two same-site pages that usually describe the business
async function readSite(website: string) {
    const pages: { url: string; text: string }[] = [];
    const errors: string[] = [];
    const home = await safeFetch(website);
    const homeText = htmlToText(home.body, 6000);
    pages.push({ url: home.url, text: `Title: ${homeText.title}\nDescription: ${homeText.description}\n${homeText.text}` });

    const base = new URL(home.url);
    const links = [...home.body.matchAll(/href=["']([^"'#]+)["']/gi)]
        .map((m) => { try { return new URL(m[1], base); } catch { return null; } })
        .filter((u): u is URL => Boolean(u && u.hostname === base.hostname && PAGE_HINT.test(u.pathname) && u.pathname !== base.pathname))
        .map((u) => `${u.origin}${u.pathname}`);
    for (const url of [...new Set(links)].slice(0, 2)) {
        try {
            const page = await safeFetch(url);
            pages.push({ url: page.url, text: htmlToText(page.body, 3000).text });
        } catch (error) {
            errors.push(`${url}: ${(error as Error).message}`);
        }
    }
    return { pages, errors };
}

/*
    Research agent: reads the prospect's public site (SSRF-guarded) and returns a
    structured report. Every citation is checked against the pages actually fetched;
    anything else is unverified, and a criterion without valid evidence becomes "unknown".
*/
export async function researchLead(ctx: AgentRunContext, input: ResearchInput, profile: ProfileForPrompt) {

    let pages: { url: string; text: string }[] = [];
    let fetchError: string | null = null;
    if (input.company.website) {
        try {
            const site = await readSite(input.company.website);
            pages = site.pages;
            if (site.errors.length) fetchError = site.errors.join("; ");
        } catch (error) {
            fetchError = (error as Error).message;
        }
    }

    const data = await runAgent(ctx, "research", {
        schema: ResearchReportSchema,
        tier: "smart",
        system: `You are the Research Agent of an AI business development team. You study a prospect company and evaluate it against the business's ideal customer profile (ICP).
${UNTRUSTED_RULES}
Rules:
- Cite evidence only with the exact URL of a page provided below, or "${LEAD_RECORD}" for the imported lead details. Never invent URLs.
- If a criterion is not evidenced, mark it "unknown" with no evidence. Unknown is not a mismatch.
- Potential needs are hypotheses; never claim the company asked for or approved anything.
- Report a disqualifier only if it is one of the configured disqualifiers and clearly evidenced.
- Report contradictions between sources in "conflicts".
Criteria to evaluate: ${CRITERIA.map((c) => `${c.id} (${c.label})`).join(", ")}.

${businessBrief(profile)}`,
        user: `Prospect (source "${LEAD_RECORD}"):
Company: ${input.company.name}
Website: ${input.company.website || "(none)"}
Industry: ${input.company.industry || "(unknown)"}
Size: ${input.company.size || (input.company.employeeCount ? `${input.company.employeeCount} employees` : "(unknown)")}
Country: ${input.company.country || "(unknown)"}
Description: ${input.company.description || "(none)"}
Contact: ${input.contact?.name || "(unknown)"}${input.contact?.title ? `, ${input.contact.title}` : ""}

${pages.length ? pages.map((p) => untrusted(p.url, p.text)).join("\n\n") : `No website pages could be read${fetchError ? ` (${fetchError})` : ""}. Use only "${LEAD_RECORD}" evidence.`}`,
    });

    // citations are only trusted if they point at something we actually read
    const allowed = new Set([...pages.map((p) => p.url), LEAD_RECORD]);
    const valid = (urls: string[]) => urls.filter((u) => allowed.has(u));
    const configured = (profile.idealCustomerProfile?.disqualifiers ?? []).map((d) => d.trim().toLowerCase());

    return {
        summary: data.companySummary,
        industry: data.industry,
        employeeCount: data.employeeCountEstimate,
        sources: pages.map((p) => p.url),
        fetchError,
        conflicts: data.conflicts,
        evidence: data.findings.map((f) => ({
            claim: f.claim,
            confidence: f.confidence,
            verified: allowed.has(f.sourceUrl),
            sourceUrl: allowed.has(f.sourceUrl) && f.sourceUrl !== LEAD_RECORD ? f.sourceUrl : undefined,
        })),
        needs: data.potentialNeeds.map((n) => n.need),
        criteria: CRITERIA.map((c) => {
            const found = data.criteria.find((x) => x.criterionId === c.id);
            const urls = valid(found?.evidenceUrls ?? []);
            // a non-unknown result without valid evidence is downgraded
            const result = found && urls.length ? found.result : "unknown";
            return { criterionId: c.id, label: c.label, result, explanation: found?.explanation ?? "Not evaluated", evidenceUrls: urls };
        }),
        verifiedDisqualifiers: data.disqualifiers
            .filter((d) => configured.includes(d.disqualifier.trim().toLowerCase()) && allowed.has(d.evidenceUrl))
            .map((d) => d.disqualifier),
    };

}

export type ResearchResult = Awaited<ReturnType<typeof researchLead>>;
