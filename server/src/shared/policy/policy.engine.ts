// Importing modules
import { PolicyConfig } from "./policy.schema.js";

export type Decision = "allow" | "needs_approval" | "deny";

export interface PolicyResult {
    decision: Decision;
    reasons: string[];
}

// every action an agent can propose that touches the outside world or costs money
export type PolicyAction =
    | {
        type: "outreach.send";
        channel: "email";
        isFollowUp: boolean;
        followUpsSent: number;
        lastOutboundAt: Date | null;
        leadQualified: boolean;
        hasConsentBasis: boolean;
        recipientSuppressed: boolean;
        newContactsToday: number;
        containsProhibitedClaim: boolean;
    }
    | {
        type: "reply.send";
        recipientSuppressed: boolean;
        containsProhibitedClaim: boolean;
    }
    | {
        type: "proposal.send";
        totalMinor: number;
        discountPercent: number;
        currency: string;
    }
    | {
        type: "llm.call";
        callsToday: number;
    };

// returns minutes since midnight of `now` in the given IANA timezone
function minutesInTimezone(now: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get("hour") * 60 + get("minute");
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// true when `now` falls inside the quiet window (which may wrap past midnight)
export function isQuietHours(now: Date, quiet: PolicyConfig["outreach"]["quietHours"]) {
    if (!quiet.enabled) return false;
    const m = minutesInTimezone(now, quiet.timezone);
    const start = toMinutes(quiet.start);
    const end = toMinutes(quiet.end);
    return start <= end ? m >= start && m < end : m >= start || m < end;
}

/*
    Pure, deterministic policy evaluation. The LLM proposes, this decides.
    Ordering matters: hard denials first, then approval triggers, else allow.
*/
export function evaluate(action: PolicyAction, policy: PolicyConfig, now: Date = new Date()): PolicyResult {
    const deny: string[] = [];
    const approve: string[] = [];

    switch (action.type) {

        case "outreach.send": {
            const o = policy.outreach;
            if (!o.enabled) deny.push("Outreach is disabled for this organization");
            if (!o.channels.includes(action.channel)) deny.push(`Channel ${action.channel} is not enabled`);
            if (action.recipientSuppressed) deny.push("Recipient is on the suppression list");
            if (!action.leadQualified) deny.push("Lead is not qualified");
            if (o.requireConsentBasis && !action.hasConsentBasis) deny.push("No recorded consent basis for this contact");
            if (action.isFollowUp) {
                if (action.followUpsSent >= o.maxFollowUps) deny.push(`Follow-up limit (${o.maxFollowUps}) reached`);
                if (action.lastOutboundAt && now.getTime() - action.lastOutboundAt.getTime() < o.minimumFollowUpIntervalHours * 3600_000) {
                    deny.push(`Follow-up interval of ${o.minimumFollowUpIntervalHours}h not yet elapsed`);
                }
            } else if (action.newContactsToday >= o.maxNewContactsPerDay) {
                deny.push(`Daily new-contact limit (${o.maxNewContactsPerDay}) reached`);
            }
            if (action.containsProhibitedClaim) approve.push("Message contains a prohibited claim");
            if (!o.autoSend) approve.push("Automatic sending is disabled; a human must approve");
            break;
        }

        case "reply.send": {
            if (action.recipientSuppressed) deny.push("Recipient is on the suppression list");
            if (action.containsProhibitedClaim) approve.push("Reply contains a prohibited claim");
            if (!policy.outreach.autoSend) approve.push("Automatic sending is disabled; a human must approve");
            break;
        }

        case "proposal.send": {
            const p = policy.pricing;
            if (action.currency !== p.currency) approve.push(`Currency ${action.currency} differs from policy currency ${p.currency}`);
            if (action.totalMinor < p.minimumDealValueMinor) approve.push("Total is below the minimum deal value");
            if (action.discountPercent > p.maximumDiscountPercent) approve.push(`Discount exceeds ${p.maximumDiscountPercent}%`);
            if (!policy.proposals.autoSend) approve.push("Automatic proposal sending is disabled");
            break;
        }

        case "llm.call": {
            if (action.callsToday >= policy.budgets.maxLlmCallsPerDay) deny.push("Daily AI budget exhausted");
            break;
        }

    }

    if (deny.length) return { decision: "deny", reasons: deny };
    if (approve.length) return { decision: "needs_approval", reasons: approve };
    return { decision: "allow", reasons: [] };
}
