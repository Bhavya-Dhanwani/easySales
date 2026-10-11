/*
    The next-best-action core: pure functions only. Facts go in; the sales state, the actions
    that are valid in that state, and whether this workspace's autonomy level may run them
    come out. A model may choose among `candidates`, never outside them, and it never decides
    authorization: `authorize` does.
*/

export const SALES_ACTIONS = ["research", "ask_question", "send_reply", "schedule_meeting", "build_prototype", "prepare_proposal", "follow_up", "wait", "escalate", "close_lost"] as const;
export type SalesAction = (typeof SALES_ACTIONS)[number];

export const SALES_STATES = ["new", "qualified", "contacted", "engaged", "discovery", "meeting_scheduled", "solution_design", "proposal_sent", "negotiation", "nurture", "won", "lost"] as const;
export type SalesState = (typeof SALES_STATES)[number];

export interface Evidence { id: string; kind: string; text: string; at?: string }

export interface Facts {
    leadStatus: string;
    stage: string;
    outreachStatus: string;
    consentBasis: string | null;
    hasEmail: boolean;
    researched: boolean;
    isTest: boolean;
    paused: boolean;
    suppressed: boolean;
    conversationStatus: string | null;
    lastIntent: string | null;
    lastInboundId: string | null;
    lastInboundText: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
    openQuestions: string[];
    requirementsVersion: number | null;
    prototypeStatus: string | null;
    proposal: { id: string; status: string; version: number; sentAt: number | null; discountPercent: number } | null;
    upcomingMeeting: boolean;
    calendarConnected: boolean;
    pendingApprovals: number;
    activeWork: number;
    now: number;
    policy: { level: 1 | 2 | 3; maxDiscountPercent: number; inactivityDays: number };
}

const DAY = 86400_000;
const EXTERNAL: SalesAction[] = ["ask_question", "send_reply", "schedule_meeting", "follow_up"];

// where the opportunity really is, from records, never from conversation sentiment alone
export function salesState(f: Facts): SalesState {
    if (f.stage === "won" || f.stage === "lost" || f.stage === "nurture") return f.stage;
    if (f.stage === "negotiation") return "negotiation";
    if (f.proposal?.status === "sent") return "proposal_sent";
    if (f.upcomingMeeting) return "meeting_scheduled";
    if (f.requirementsVersion && !f.openQuestions.length) return "solution_design";
    if (f.stage === "discovery" || f.requirementsVersion) return "discovery";
    if (f.lastInboundAt) return "engaged";
    if (f.lastOutboundAt) return "contacted";
    if (f.leadStatus === "qualified") return "qualified";
    return "new";
}

// a requested discount stated by the prospect ("20%", "20 percent"), parsed by code, never by the model
export function requestedDiscount(text: string | null) {
    const m = /(\d{1,2}(?:\.\d)?)\s*(%|percent|per cent)/i.exec(text ?? "");
    return m ? Number(m[1]) : null;
}

export interface Candidate { action: SalesAction; reason: string; evidence: string[]; missing?: string[]; params?: Record<string, unknown>; nextEvaluationAt?: number }

/*
    Valid next actions for the current state, most appropriate first. Hard stops come first:
    nothing external is proposed for suppressed, opted-out, closed, paused or test records.
*/
export function candidates(f: Facts): Candidate[] {
    const state = salesState(f);
    const inbound = f.lastInboundId ? [f.lastInboundId] : [];
    if (f.isTest) return [{ action: "wait", reason: "Onboarding test record", evidence: [] }];
    if (f.suppressed || f.outreachStatus === "opted_out") return [{ action: "wait", reason: "Do not contact: the recipient opted out or is suppressed", evidence: [] }];
    if (state === "won" || state === "lost") return [{ action: "wait", reason: `Opportunity is ${state}; no sales actions`, evidence: [] }];
    if (f.paused) return [{ action: "wait", reason: "Automation is paused for this opportunity", evidence: [] }];
    if (f.pendingApprovals > 0) return [{ action: "wait", reason: "Waiting for a human decision on a pending approval", evidence: [] }];
    if (f.activeWork > 0) return [{ action: "wait", reason: "Work already in progress for this opportunity", evidence: [] }];

    const unanswered = f.lastInboundAt !== null && (f.lastOutboundAt === null || f.lastInboundAt > f.lastOutboundAt);
    const silentSince = Math.max(f.lastInboundAt ?? 0, f.lastOutboundAt ?? 0);
    const inactive = silentSince > 0 && f.now - silentSince > f.policy.inactivityDays * DAY;
    const out: Candidate[] = [];

    if (state === "new") {
        if (!f.researched) out.push({ action: "research", reason: "No research yet: gather evidence before any contact", evidence: [] });
        else if (f.leadStatus === "needs_review") out.push({ action: "escalate", reason: "Qualification needs a human decision", evidence: [] });
        else out.push({ action: "wait", reason: "Not qualified for outreach", evidence: [] });
        return out;
    }
    if (state === "qualified") {
        if (!f.hasEmail) return [{ action: "escalate", reason: "Qualified but no contact email", evidence: [], missing: ["contact email"] }];
        if (!f.consentBasis || f.consentBasis === "none") return [{ action: "escalate", reason: "Record a consent basis before first contact", evidence: [], missing: ["consent basis"] }];
        return [{ action: "send_reply", reason: "Qualified with consent and no contact yet: send the first, policy-checked email", evidence: [], params: { kind: "first_touch" } }];
    }

    if (unanswered && f.conversationStatus === "needs_review") out.push({ action: "escalate", reason: "The latest reply needs a human (low confidence, complaint or sensitive request)", evidence: inbound });
    if (unanswered && f.lastIntent === "not_interested") out.push({ action: "close_lost", reason: "The prospect said they are not interested", evidence: inbound });
    const discount = (f.lastIntent === "pricing_question" || f.lastIntent === "objection") ? requestedDiscount(f.lastInboundText) : null;
    if (unanswered && discount !== null) {
        if (discount > f.policy.maxDiscountPercent || !f.proposal) {
            out.push({ action: "escalate", reason: f.proposal ? `Requested ${discount}% discount exceeds the ${f.policy.maxDiscountPercent}% limit` : `Discount of ${discount}% requested before any proposal`, evidence: inbound, params: { requestedDiscount: discount } });
        } else {
            out.push({ action: "prepare_proposal", reason: `Requested ${discount}% discount is within the ${f.policy.maxDiscountPercent}% limit: revise the proposal (priced by code)`, evidence: [...inbound, f.proposal.id], params: { discountPercent: discount, reviseProposalId: f.proposal.id } });
        }
    }
    if (unanswered && f.lastIntent === "meeting_request" && !f.upcomingMeeting) out.push({ action: "schedule_meeting", reason: "The prospect asked to meet", evidence: inbound, params: { calendar: f.calendarConnected } });
    if (state === "discovery" && f.openQuestions.length && unanswered) out.push({ action: "ask_question", reason: "Requirements still have open questions", evidence: inbound, missing: f.openQuestions, params: { questions: f.openQuestions.slice(0, 3) } });
    if (state === "solution_design") {
        if (!f.prototypeStatus || ["failed", "cancelled", "expired"].includes(f.prototypeStatus)) out.push({ action: "build_prototype", reason: "Requirements are clear: a demo can show the solution", evidence: [`requirements:v${f.requirementsVersion}`] });
        if (!f.proposal || ["superseded", "expired", "rejected"].includes(f.proposal.status)) out.push({ action: "prepare_proposal", reason: "Requirements are clear: prepare a proposal", evidence: [`requirements:v${f.requirementsVersion}`] });
    }
    if (inactive && ["contacted", "engaged", "discovery", "proposal_sent", "solution_design", "meeting_scheduled"].includes(state) && !unanswered) {
        out.push({ action: "follow_up", reason: `No activity for ${f.policy.inactivityDays}+ days`, evidence: f.proposal?.status === "sent" ? [f.proposal.id] : [] });
    }
    if (!out.length) out.push({ action: "wait", reason: "Nothing is due; re-evaluate after the inactivity window", evidence: [], nextEvaluationAt: (silentSince || f.now) + f.policy.inactivityDays * DAY });
    return out;
}

export type PolicyDecision = "allowed" | "approval_required" | "blocked";

/*
    What this workspace lets the agent do on its own. Level 1 (copilot): nothing external
    without a human. Level 2 (supervised): routine actions. Level 3 (bounded): also demo builds
    and closing lost deals. Proposals always go to a human. Every level keeps the hard stops.
*/
export function authorize(action: SalesAction, f: Facts): { decision: PolicyDecision; reason: string } {
    if (action === "wait" || action === "escalate") return { decision: "allowed", reason: "No external effect" };
    const stopped = f.suppressed || f.outreachStatus === "opted_out" || f.stage === "won" || f.stage === "lost" || f.paused || f.isTest;
    if (stopped) return { decision: "blocked", reason: "Opted out, suppressed, closed, paused or test record" };
    if (action === "research") return { decision: "allowed", reason: "Internal and budgeted" };
    if (action === "prepare_proposal") return { decision: "approval_required", reason: "Proposals are always prepared with a human" };
    const level = f.policy.level;
    if (level === 1) return { decision: "approval_required", reason: "Copilot mode: a human approves every external action" };
    if (EXTERNAL.includes(action)) return { decision: "allowed", reason: "Routine action; message policy, caps and quiet hours still apply" };
    if (level === 3) return { decision: "allowed", reason: "Bounded autonomy; demo budget and closing rules still apply" };
    return { decision: "approval_required", reason: "High-impact action in supervised mode" };
}

// what must not have changed between a human's approval and execution
export const fingerprint = (f: Facts) => [salesState(f), f.lastInboundId ?? "", f.proposal?.id ?? "", f.proposal?.version ?? 0, f.suppressed, f.paused, f.stage].join("|");

// valid opportunity-stage moves; "won" needs acceptance evidence (handoff), never a status edit or a model
const FORWARD: Record<string, string[]> = {
    new: ["qualified", "discovery", "nurture", "lost"], qualified: ["discovery", "proposal", "nurture", "lost"], discovery: ["proposal", "negotiation", "nurture", "lost"],
    proposal: ["negotiation", "discovery", "nurture", "lost"], negotiation: ["proposal", "lost"], nurture: ["qualified", "discovery", "lost"], won: [], lost: ["nurture"],
};
export function canTransition(from: string, to: string, actor: "agent" | "user", acceptanceEvidence = false) {
    if (from === to) return true;
    if (to === "won") return acceptanceEvidence;
    if (actor === "user") return from !== "won";
    return (FORWARD[from] ?? []).includes(to);
}
