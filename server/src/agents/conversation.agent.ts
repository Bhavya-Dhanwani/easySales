// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";
import { withOptOut } from "./outreach.agent.js";

export const INTENTS = ["interested", "question", "meeting_request", "not_interested", "opt_out", "out_of_office", "other"] as const;

export const ConversationSchema = z.object({
    intent: z.enum(INTENTS),
    summary: z.string().describe("one-paragraph running summary of the whole thread so far"),
    requirements: z.object({
        needs: z.array(z.string()),
        budget: z.string().describe("as stated by the prospect, empty if not mentioned"),
        timeline: z.string().describe("as stated by the prospect, empty if not mentioned"),
    }),
    shouldReply: z.boolean().describe("false for opt-outs, out-of-office and clear rejections"),
    reply: z.string().max(3000).describe("plain-text reply body, empty if shouldReply is false"),
    needsHuman: z.boolean().describe("true if the prospect asks about pricing specifics, contracts, legal terms or anything not covered by approved facts"),
});

// explicit opt-out language is handled deterministically, before and regardless of the model
const OPT_OUT = /\b(unsubscribe|opt[\s-]?out|stop (emailing|contacting|messaging)|remove me|do not (contact|email)|don'?t (contact|email))\b/i;

export const isOptOut = (text: string) => OPT_OUT.test(text);

/*
    Conversation agent: classifies an inbound reply, extracts requirements and drafts
    an answer that only uses approved business facts.
*/
export async function handleInbound(
    ctx: AgentRunContext,
    lead: { company: { name: string }; contact?: { name?: string | null } | null },
    thread: { direction: string; subject?: string | null; body: string }[],
    profile: ProfileForPrompt,
) {

    const transcript = thread.map((m) => `[${m.direction === "inbound" ? "PROSPECT" : "US"}] ${m.subject ? `(${m.subject}) ` : ""}${m.body}`).join("\n\n");

    const data = await runAgent(ctx, "conversation", {
        schema: ConversationSchema,
        tier: "smart",
        system: `You are the Conversation Agent of an AI business development team. You read the latest reply from a prospect, classify it, keep a structured summary, and draft the next reply.
${UNTRUSTED_RULES}
Reply rules:
- Answer only with approved business facts. If they ask about price, say a tailored proposal will follow after a short discovery chat; never quote numbers.
- Never promise delivery dates, discounts, guarantees or features not listed.
- Aim for the next concrete step (a 20-minute discovery call, or the missing requirement).
- Keep it under 120 words, warm and specific. No signature or unsubscribe line.

${businessBrief(profile)}`,
        user: `Prospect: ${lead.contact?.name || "(unknown)"} at ${lead.company.name}

${untrusted("email-thread", transcript)}`,
    });

    return {
        ...data,
        reply: data.shouldReply && data.reply ? withOptOut(data.reply, profile.businessName || "") : "",
    };

}
