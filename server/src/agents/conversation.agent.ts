// Importing modules
import { z } from "zod";
import { runAgent, AgentRunContext } from "./runAgent.js";
import { businessBrief, ProfileForPrompt, UNTRUSTED_RULES, untrusted } from "./prompts.js";
import { withOptOut } from "./outreach.agent.js";
import { formatMoney } from "../shared/utils/pricing.util.js";

export const INTENTS = ["interested", "meeting_request", "pricing_question", "objection", "not_interested", "opt_out", "complaint", "out_of_office", "unclear"] as const;

export const ReplyClassificationSchema = z.object({
    intent: z.enum(INTENTS),
    confidence: z.number().min(0).max(1),
    summary: z.string().describe("one-paragraph running summary of the whole thread so far"),
    extractedFacts: z.array(z.object({
        field: z.enum(["need", "budget", "timeline", "decision_maker", "current_vendor", "other"]),
        value: z.string(),
        evidence: z.string().describe("the prospect's own words supporting this"),
    })),
    recommendedAction: z.enum(["reply", "book_meeting", "pause", "suppress", "escalate", "close"]),
    returnDate: z.string().describe("ISO date the sender is back, only for out_of_office; empty otherwise"),
    reply: z.string().max(3000).describe("plain-text reply body when recommendedAction is reply or book_meeting; empty otherwise"),
});

// explicit opt-out language is handled deterministically, before and regardless of the model
const OPT_OUT = /\b(unsubscribe|opt[\s-]?out|stop (emailing|contacting|messaging)|remove me|do not (contact|email)|don'?t (contact|email))\b/i;
// auto-replies are never answered (prevents mail loops)
const AUTO_REPLY = /^(auto(matic)?[\s-]?reply|out of (the )?office|ooo\b|away from (the )?office|vacation|delivery status notification|undeliverable|mail delivery failed)/i;

export const isOptOut = (text: string) => OPT_OUT.test(text);
export const isAutoReply = (subject: string | undefined | null) => AUTO_REPLY.test((subject ?? "").replace(/^(re|fw|fwd):\s*/i, "").trim());

// below this confidence the agent does not act on its own
export const MIN_CONFIDENCE = 0.6;

/*
    Conversation agent: classifies an inbound reply, extracts facts and drafts an answer
    that only uses approved business facts and the catalogue's starting prices.
*/
export async function handleInbound(
    ctx: AgentRunContext,
    lead: { company: { name: string }; contact?: { name?: string | null } | null },
    thread: { direction: string; subject?: string | null; body: string }[],
    profile: ProfileForPrompt & { meetingLink?: string | null },
    currency: string,
) {

    const transcript = thread.map((m) => `[${m.direction === "inbound" ? "PROSPECT" : "US"}] ${m.subject ? `(${m.subject}) ` : ""}${m.body}`).join("\n\n");
    const prices = (profile.services ?? []).map((s) => `- ${s.name}: from ${formatMoney(s.basePriceMinor, currency)}`).join("\n");

    const data = await runAgent(ctx, "conversation", {
        schema: ReplyClassificationSchema,
        tier: "smart",
        system: `You are the Conversation Agent of an AI business development team. Read the latest reply from a prospect, classify it, keep a running summary, extract facts, and draft the next reply when appropriate.
${UNTRUSTED_RULES}
Intents: interested, meeting_request, pricing_question, objection, not_interested, opt_out, complaint, out_of_office, unclear.
Reply rules:
- Answer only with approved business facts. For pricing, you may quote the "from" prices below and say a tailored proposal follows a short discovery call; never invent discounts or totals.
- Meeting requests: ${profile.meetingLink ? `share this booking link: ${profile.meetingLink}` : "offer two time windows and ask which suits them; do not claim a booking was made"}.
- Objections: respectful, brief, one relevant point, no pressure.
- Never promise delivery dates, guarantees or features not listed. Under 120 words. No signature or unsubscribe line.
- Use "escalate" when unsure, when the prospect is upset, or for anything legal or contractual.

Catalogue starting prices:
${prices || "- (no services configured: do not discuss price)"}

${businessBrief(profile)}`,
        user: `Prospect: ${lead.contact?.name || "(unknown)"} at ${lead.company.name}

${untrusted("email-thread", transcript)}`,
    });

    const shouldReply = ["reply", "book_meeting"].includes(data.recommendedAction) && Boolean(data.reply.trim());
    return {
        ...data,
        reply: shouldReply ? withOptOut(data.reply, profile.businessName || "") : "",
        // a human looks at anything uncertain, upset, unclear or about money
        needsHuman: data.confidence < MIN_CONFIDENCE || ["unclear", "complaint", "pricing_question"].includes(data.intent) || data.recommendedAction === "escalate",
    };

}
