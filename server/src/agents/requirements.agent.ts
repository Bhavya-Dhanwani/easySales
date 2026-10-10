// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";

export const PROJECT_TYPES = ["landing_page", "business_website", "dashboard", "web_app_demo"] as const;

const line = (max: number) => z.string().trim().max(max);

/*
    The structured scope of an opportunity. Note the three different money values in
    the system: the prospect's stated budget (here, data), the prototype spend limit
    (policy) and the proposal price (price book). They are never mixed.
*/
export const RequirementsSchema = z.object({
    title: line(140).min(1),
    projectType: z.enum(PROJECT_TYPES),
    problemStatement: line(2000),
    targetUsers: z.array(line(200)).max(10),
    features: z.array(z.object({
        name: line(120).min(1),
        description: line(500),
        priority: z.enum(["must", "should", "could"]),
        // confirmed = the prospect said it; assumed = inferred; needs_clarification = ask before building
        status: z.enum(["confirmed", "assumed", "needs_clarification"]),
    })).min(1).max(25),
    design: z.object({
        brandColors: z.array(line(30)).max(5),
        visualDirection: line(500),
        referenceUrls: z.array(z.string().trim().url().max(500)).max(5),
    }),
    constraints: z.object({
        budgetMinorUnits: z.number().int().min(0).max(1e13).nullable(),
        currency: z.string().length(3),
        targetDate: line(40).nullable(),
        technologies: z.array(line(60)).max(10),
    }),
    acceptanceCriteria: z.array(line(300)).max(20),
    openQuestions: z.array(line(300)).max(20),
    sourceMessageIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(50),
});

export type Requirements = z.infer<typeof RequirementsSchema>;

// Requirements Agent: turns the conversation into a validated scope, separating facts from assumptions
export async function extractRequirements(
    ctx: AgentRunContext,
    lead: { company: { name: string; industry?: string | null }; requirements?: { needs?: string[]; budget?: string | null; timeline?: string | null } | null },
    messages: { id: string; direction: string; at: Date; body: string }[],
    profile: ProfileForPrompt,
    currency: string,
) {
    return runAgent(ctx, "requirements", {
        schema: RequirementsSchema,
        tier: "smart",
        system: `You are the Requirements Agent. Extract the project requirements a prospect has expressed, so a demo and a proposal can be scoped.
${UNTRUSTED_RULES}
Rules:
- A feature is "confirmed" only if the prospect stated it in an inbound message; anything you infer is "assumed"; anything ambiguous that blocks building is "needs_clarification" and also goes into openQuestions.
- projectType must be the closest of: ${PROJECT_TYPES.join(", ")}.
- budgetMinorUnits: only a budget the prospect stated, converted to minor units (paise/cents) of ${currency}; otherwise null. Never invent one.
- sourceMessageIds: only ids of the messages below that you actually used.
- acceptanceCriteria are short, testable statements.

${businessBrief(profile)}`,
        user: `Prospect: ${lead.company.name}${lead.company.industry ? ` (${lead.company.industry})` : ""}
Discovery notes: needs=${(lead.requirements?.needs ?? []).join("; ") || "-"}; budget=${lead.requirements?.budget || "-"}; timeline=${lead.requirements?.timeline || "-"}

${messages.map((m) => untrusted(`message ${m.id} (${m.direction}, ${m.at.toISOString().slice(0, 10)})`, m.body.slice(0, 4000))).join("\n\n")}`,
    });
}
