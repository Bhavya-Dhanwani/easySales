// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";
import type { Requirements } from "./requirements.agent.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB colour");
const line = (max: number) => z.string().trim().max(max);

/*
    The Builder Agent never writes code. It fills the content slots of an approved
    template; code renders and escapes it. Generated text therefore cannot become
    markup, script or a network request.
*/
export const PrototypeContentSchema = z.object({
    brandName: line(60).min(1),
    tagline: line(120),
    headline: line(120).min(1),
    subheadline: line(300),
    primaryCta: line(40).min(1),
    palette: z.object({ primary: hex, accent: hex }),
    sections: z.array(z.object({
        heading: line(80).min(1),
        body: line(600),
        items: z.array(z.object({ title: line(60).min(1), text: line(240) })).max(6),
    })).min(1).max(6),
    // synthetic sample data only
    metrics: z.array(z.object({ label: line(40).min(1), value: line(20).min(1) })).max(6),
    table: z.object({
        columns: z.array(line(30)).max(6),
        rows: z.array(z.array(line(60)).max(6)).max(12),
    }),
});

export type PrototypeContent = z.infer<typeof PrototypeContentSchema>;

export async function generatePrototypeContent(
    ctx: AgentRunContext,
    requirements: Requirements,
    templateBrief: string,
    profile: ProfileForPrompt,
    repairFindings: string[],
) {
    const must = requirements.features.filter((f) => f.priority === "must").map((f) => f.name);
    return runAgent(ctx, "prototype_builder", {
        schema: PrototypeContentSchema,
        tier: "smart",
        system: `You are the Builder Agent. Fill the content of a clickable demo built from an approved template: ${templateBrief}
${UNTRUSTED_RULES}
Rules:
- Use every must-have feature name verbatim as the title of an item: ${must.map((m) => JSON.stringify(m)).join(", ") || "(none)"}.
- All data is synthetic and obviously fictional. No URLs, email addresses, phone numbers, real people or real customer data.
- No prices, discounts or promises. No markup, code or HTML: plain text only.
- Colours: use the brand colours if given as hex, otherwise choose a tasteful pair.

${businessBrief(profile)}`,
        user: `${untrusted("requirements", JSON.stringify({ ...requirements, sourceMessageIds: undefined }))}${repairFindings.length ? `

The previous attempt failed quality checks. Fix exactly these and keep everything else:
${repairFindings.map((f) => `- ${f}`).join("\n")}` : ""}`,
    });
}
