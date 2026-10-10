// Importing modules
import mongoose from "mongoose";
import Proposal from "../models/proposal.model.js";
import Lead from "../models/lead.model.js";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
import Approval from "../models/approval.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import Prototype from "../models/prototype.model.js";
import { evaluate } from "../policy/policy.engine.js";
import { getCurrentPolicy, isSuppressed } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { hashPayload } from "../utils/hash.util.js";
import { formatMoney, priceProposal, Selection, splitPayments } from "../utils/pricing.util.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { latestRequirements, openQuestionsOf } from "../requirements/requirements.service.js";
import { writeProposal } from "../../agents/proposal.agent.js";
import type { Requirements as Reqs } from "../../agents/requirements.agent.js";
import { ProfileForPrompt } from "../../agents/prompts.js";
import { ensureConversation } from "../../agents/graphs/common.js";
import BadRequest from "../errors/BadRequest.error.js";
import NotFound from "../errors/NotFound.error.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId;
type ProposalDoc = InstanceType<typeof Proposal>;

const DEFAULT_SCHEDULE = [{ label: "On signing", percent: 50 }, { label: "On delivery", percent: 50 }];
const DEFAULT_TERMS = "Work starts once a written agreement is signed and the first instalment is received. Intellectual property in the deliverables transfers on full payment. Either party may end the engagement with 14 days' written notice; work completed to that date is payable.";
// statuses whose content may still go out; everything else is final
const LIVE = ["generating", "draft", "pending_approval", "approved", "sent", "failed"];

const day = (d: Date) => d.toISOString().slice(0, 10);
const plain = <T>(v: T) => JSON.parse(JSON.stringify(v ?? null));

// the exact content an approval covers; any change to it invalidates the approval
export function proposalPayload(p: ProposalDoc, to: string) {
    return plain({
        proposalId: p._id.toString(), version: p.version, to, body: p.body, currency: p.currency, items: p.items,
        subtotalMinor: p.subtotalMinor, discountPercent: p.discountPercent, discountMinor: p.discountMinor, taxMinor: p.taxMinor,
        totalMinor: p.totalMinor, paymentSchedule: p.paymentSchedule, scope: p.scope, milestones: p.milestones,
        expiresAt: p.expiresAt?.toISOString(), termsTemplateVersion: p.termsTemplateVersion,
    });
}

type Narrative = Awaited<ReturnType<typeof writeProposal>>;

// renders the final document: prose and scope from the model, every number and all terms from code and config
export function renderProposal(n: Narrative, p: ProposalDoc, ctx: {
    customer: string; supplier: string; terms: string; revisionRounds: number; delivery?: string; preview?: string;
}) {
    const money = (m: number) => formatMoney(m, p.currency);
    const bullets = (xs: string[] = []) => xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- None";
    const lines = p.items.map((i) => `- ${i.name}${(i.quantity ?? 1) > 1 ? ` × ${i.quantity}` : ""}: ${money(i.priceMinor)}`).join("\n");
    const discount = p.discountMinor > 0 ? `\nDiscount (${p.discountPercent}%): -${money(p.discountMinor)}` : "";
    const tax = p.taxBasisPoints > 0 ? `\nTax (${p.taxBasisPoints / 100}%): ${money(p.taxMinor)}` : "";
    const valid = p.expiresAt ? day(p.expiresAt) : "30 days from today";
    return `${n.title}
Prepared for ${ctx.customer} by ${ctx.supplier} · Version ${p.version} · Valid until ${valid}

Our understanding
${n.understanding}

Approach
${bullets(n.approach)}

Scope of work
Deliverables:
${bullets(n.deliverables)}
Not included:
${bullets(n.exclusions)}
Assumptions:
${bullets(n.assumptions)}

Timeline and milestones
${n.milestones.map((m, i) => `${i + 1}. ${m.name}: ${m.description}`).join("\n")}${ctx.delivery ? `\nEstimated delivery: ${ctx.delivery} from kick-off.` : ""}${ctx.preview ? `

Live demo
${ctx.preview}` : ""}

Investment
${lines}
Subtotal: ${money(p.subtotalMinor)}${discount}${tax}
Total: ${money(p.totalMinor)}

Payment schedule
${p.paymentSchedule.map((s) => `- ${s.label} (${s.percent}%): ${money(s.amountMinor ?? 0)}`).join("\n")}

Revisions and changes
Includes up to ${ctx.revisionRounds} round${ctx.revisionRounds === 1 ? "" : "s"} of revisions. Anything beyond this scope follows a written change request, quoted separately.

Terms
${ctx.terms}

Next steps
${n.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

This proposal is valid until ${valid} and becomes binding only once a written agreement is signed by both parties.`;
}

/*
    A new proposal version for an opportunity: priced here from the current price book,
    written later by the proposal agent (202). Revisions go through the same path.
*/
export async function createProposal(
    organizationId: Id, leadId: Id,
    input: { services: Selection[]; discountPercent: number; prototypeId?: string; revisionNote?: string; previousVersionId?: Id },
    userId: string,
) {
    const lead = await Lead.findOne({ organizationId, _id: leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    const { config } = await getCurrentPolicy(organizationId);
    if (input.prototypeId && !await Prototype.exists({ organizationId, _id: input.prototypeId, opportunityId: leadId })) {
        throw new BadRequest("Prototype does not belong to this opportunity");
    }
    const priced = priceProposal(profile?.services ?? [], input.services, input.discountPercent, config.pricing.taxBasisPoints);
    const req = await latestRequirements(organizationId, leadId);

    let proposal: ProposalDoc | null = null;
    for (let attempt = 0; attempt < 3 && !proposal; attempt++) {
        const last = await Proposal.findOne({ organizationId, leadId }).sort({ version: -1 }).lean();
        try {
            proposal = await Proposal.create({
                organizationId, leadId, version: (last?.version ?? 0) + 1, previousVersionId: input.previousVersionId, revisionNote: input.revisionNote,
                requirementsVersion: req?.version ?? 0, priceBookVersion: profile?.version ?? 0, termsTemplateVersion: profile?.version ?? 0,
                prototypeId: input.prototypeId, currency: config.pricing.currency, ...priced,
                paymentSchedule: splitPayments(priced.totalMinor, profile?.paymentSchedule?.length ? profile.paymentSchedule as { label: string; percent: number }[] : DEFAULT_SCHEDULE),
                expiresAt: new Date(Date.now() + config.pricing.proposalValidityDays * 86400_000), status: "generating",
            });
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
        }
    }
    if (!proposal) throw new Conflict("Could not allocate a proposal version");

    const { workflow } = await startWorkflow({
        organizationId, type: "proposal.generate", entityType: "proposal", entityId: proposal._id,
        idempotencyKey: `proposal:${proposal._id}:generate`, startedBy: userId, actor: { type: "user", id: userId },
    });
    await audit({ organizationId, actorType: "user", actorId: userId, action: input.previousVersionId ? "proposal.revise" : "proposal.create", targetType: "proposal", targetId: proposal._id.toString(), outcome: "success", metadata: { version: proposal.version, totalMinor: proposal.totalMinor } });
    return { proposal, workflowId: workflow._id };
}

// background job body: the model writes the narrative and scope for an already-priced proposal
export async function generateProposalBody(organizationId: string, proposalId: string, workflowId: string, correlationId: string) {
    const proposal = await Proposal.findOne({ organizationId, _id: proposalId });
    if (!proposal) throw new NotFound("Proposal not found");
    if (proposal.status !== "generating") return proposal;

    const lead = await Lead.findOne({ organizationId, _id: proposal.leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const conversation = await Conversation.findOne({ organizationId, leadId: lead._id }).lean();
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    const req = proposal.requirementsVersion ? await latestRequirements(organizationId, lead._id) : null;
    const proto = proposal.prototypeId ? await Prototype.findOne({ organizationId, _id: proposal.prototypeId, status: "ready" }).lean() : null;

    const chosen = (profile?.services ?? []).filter((s) => proposal.items.some((i) => i.name === s.name));
    const minDays = Math.max(0, ...chosen.map((s) => s.deliveryDaysMin ?? 0));
    const maxDays = Math.max(0, ...chosen.map((s) => s.deliveryDaysMax ?? s.deliveryDaysMin ?? 0));

    try {
        const narrative = await writeProposal(
            { organizationId, workflowId, correlationId }, lead, conversation?.summary ?? "", proposal.items,
            (profile ?? {}) as ProfileForPrompt, req?.version === proposal.requirementsVersion ? req?.requirements : undefined,
        );
        proposal.scope = { deliverables: narrative.deliverables, exclusions: narrative.exclusions, assumptions: narrative.assumptions };
        proposal.set("milestones", narrative.milestones);
        proposal.body = renderProposal(narrative, proposal, {
            customer: lead.company.name, supplier: profile?.businessName || "us",
            terms: profile?.terms?.trim() || DEFAULT_TERMS, revisionRounds: profile?.revisionRounds ?? 2,
            delivery: maxDays ? `${minDays || maxDays}–${maxDays} days` : undefined,
            preview: proto?.previewUrl && proto.previewExpiresAt ? `${proto.previewUrl} (available until ${day(proto.previewExpiresAt)})` : undefined,
        });
        proposal.status = "draft";
    } catch (error) {
        proposal.status = "failed";
        await proposal.save();
        throw error;
    }
    await proposal.save();
    await Lead.updateOne({ organizationId, _id: lead._id, opportunityStage: { $in: ["new", "qualified", "discovery"] } }, { opportunityStage: "proposal" });
    return proposal;
}

async function load(organizationId: Id, proposalId: string | Id) {
    const proposal = await Proposal.findOne({ organizationId, _id: proposalId });
    if (!proposal) throw new NotFound("Proposal not found");
    const lead = await Lead.findOne({ organizationId, _id: proposal.leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    return { proposal, lead };
}

/*
    Re-checks a version against today's price book, requirements and policy. Anything
    stale or unresolved becomes an approval reason rather than silently passing.
*/
export async function validateProposal(organizationId: Id, proposalId: string | Id) {
    const { proposal, lead } = await load(organizationId, proposalId);
    const issues: string[] = [];
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    const { config, version } = await getCurrentPolicy(organizationId);

    if (proposal.expiresAt && proposal.expiresAt < new Date()) issues.push("Proposal has expired");
    if ((profile?.version ?? 0) !== proposal.priceBookVersion) {
        try {
            const now = priceProposal(profile?.services ?? [], proposal.items.map((i) => ({ name: i.name, quantity: i.quantity ?? 1 })), proposal.discountPercent, proposal.taxBasisPoints);
            if (now.totalMinor !== proposal.totalMinor) issues.push("Prices changed since this version was created; create a revision");
        } catch {
            issues.push("A service in this proposal is no longer in the price book; create a revision");
        }
    }
    const req = await latestRequirements(organizationId, lead._id);
    if (!req) issues.push("Scope is not backed by captured requirements");
    else {
        if (req.version !== proposal.requirementsVersion) issues.push(`Requirements changed (now v${req.version}); create a revision`);
        for (const q of openQuestionsOf(req.requirements as Reqs)) issues.push(`Unresolved requirement: ${q}`);
    }

    const result = evaluate({
        type: "proposal.send", totalMinor: proposal.totalMinor, discountPercent: proposal.discountPercent,
        currency: proposal.currency, scopeIssues: issues,
    }, config);
    return { proposal, lead, issues, decision: result.decision, reasons: result.reasons, policyVersion: version };
}

// queues the outbound email carrying the proposal (after policy / approval)
async function queueProposalMessage(organizationId: Id, proposal: ProposalDoc, lead: { _id: Id; contact?: { email?: string | null } | null }) {
    const conversation = await ensureConversation(organizationId.toString(), lead._id);
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    await Message.updateOne(
        { organizationId, idempotencyKey: `proposal:${proposal._id}` },
        {
            $setOnInsert: {
                organizationId, conversationId: conversation._id, leadId: lead._id, direction: "outbound", kind: "proposal",
                to: lead.contact?.email, subject: `Proposal from ${profile?.businessName || "us"}${proposal.version > 1 ? ` (v${proposal.version})` : ""}`, body: proposal.body,
                status: "queued", idempotencyKey: `proposal:${proposal._id}`, proposalId: proposal._id,
            },
        },
        { upsert: true },
    );
}

/*
    Draft → approved, either by policy (inside limits) or by a human approving the exact
    content: the approval stores a hash of the proposal payload it covers.
*/
export async function submitForApproval(organizationId: Id, proposalId: string | Id, actorId: string) {
    const v = await validateProposal(organizationId, proposalId);
    const { proposal, lead } = v;
    if (proposal.status !== "draft") throw new Conflict(`Proposal is ${proposal.status}; only drafts can be submitted`);
    if (proposal.expiresAt && proposal.expiresAt < new Date()) throw new Conflict("Proposal has expired; create a revision");
    if (!lead.contact?.email) throw new BadRequest("Lead has no contact email");
    if (await isSuppressed(organizationId, lead.contact.email)) throw new Conflict("Recipient has opted out");

    const payload = proposalPayload(proposal, lead.contact.email);
    if (v.decision === "allow") {
        Object.assign(proposal, { status: "approved", approvedBy: "policy", approvedAt: new Date(), payloadHash: hashPayload(payload) });
    } else {
        const approval = await Approval.create({
            organizationId, actionType: "proposal.send", targetType: "proposal", targetId: proposal._id, leadId: lead._id,
            payload, payloadHash: hashPayload(payload), policyVersion: v.policyVersion, reasons: v.reasons,
            requestedBy: `user:${actorId}`, expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        });
        Object.assign(proposal, { status: "pending_approval", approvalId: approval._id });
    }
    await proposal.save();
    await audit({
        organizationId, actorType: "user", actorId, action: "proposal.submit", targetType: "proposal", targetId: proposal._id.toString(),
        decision: v.decision, outcome: v.decision === "allow" ? "success" : "pending", policyVersion: v.policyVersion,
        metadata: { reasons: v.reasons, totalMinor: proposal.totalMinor, version: proposal.version },
    });
    return { proposal, lead, decision: v.decision, reasons: v.reasons };
}

// sends an approved version, but only if it is still byte-for-byte what was approved
async function sendApproved(organizationId: Id, proposal: ProposalDoc, lead: { _id: Id; contact?: { email?: string | null } | null }) {
    const to = lead.contact?.email;
    if (!to) throw new BadRequest("Lead has no contact email");
    if (proposal.expiresAt && proposal.expiresAt < new Date()) throw new Conflict("Proposal has expired; create a revision");
    if (!proposal.payloadHash || hashPayload(proposalPayload(proposal, to)) !== proposal.payloadHash) {
        throw new Conflict("Proposal no longer matches the approved content; submit it for approval again");
    }
    if (await isSuppressed(organizationId, to)) throw new Conflict("Recipient has opted out");
    await queueProposalMessage(organizationId, proposal, lead);
}

/*
    Send: a draft is submitted first (and goes out at once only when policy allows);
    an approved version is sent after its content hash is re-checked.
*/
export async function requestProposalSend(organizationId: Id, proposalId: string, actorId: string) {
    let { proposal, lead } = await load(organizationId, proposalId);
    let decision: "allow" | "needs_approval" | "deny" = "allow";
    let reasons: string[] = [];
    if (proposal.status === "draft") {
        ({ proposal, lead, decision, reasons } = await submitForApproval(organizationId, proposalId, actorId));
    } else if (proposal.status !== "approved") {
        throw new Conflict(`Proposal is ${proposal.status}; only drafts or approved proposals can be sent`);
    }
    if (proposal.status === "approved") {
        await sendApproved(organizationId, proposal, lead);
        await audit({ organizationId, actorType: "user", actorId, action: "proposal.send", targetType: "proposal", targetId: proposal._id.toString(), outcome: "success", metadata: { version: proposal.version } });
    }
    return { proposal, decision, reasons };
}

// a human approved the exact payload (checked by decideApproval): record it and send
export async function executeApprovedProposal(organizationId: Id, proposalId: Id, approval: { payloadHash: string; decidedBy?: string }) {
    const { proposal, lead } = await load(organizationId, proposalId);
    Object.assign(proposal, { status: "approved", approvedBy: approval.decidedBy, approvedAt: new Date(), payloadHash: approval.payloadHash });
    await proposal.save();
    await sendApproved(organizationId, proposal, lead);
}

/*
    Revision: never edits a version. It prices a new version from today's price book
    and requirements; the old one is superseded, its pending approval and unsent
    email are cancelled.
*/
export async function reviseProposal(
    organizationId: Id, proposalId: string,
    input: { services?: Selection[]; discountPercent?: number; prototypeId?: string; note: string }, userId: string,
) {
    const { proposal } = await load(organizationId, proposalId);
    if (!LIVE.includes(proposal.status)) throw new Conflict(`A ${proposal.status} proposal cannot be revised`);
    const created = await createProposal(organizationId, proposal.leadId, {
        services: input.services ?? proposal.items.map((i) => ({ name: i.name, quantity: i.quantity ?? 1 })),
        discountPercent: input.discountPercent ?? proposal.discountPercent,
        prototypeId: input.prototypeId ?? proposal.prototypeId?.toString(),
        revisionNote: input.note, previousVersionId: proposal._id,
    }, userId);
    await Proposal.updateOne({ organizationId, _id: proposal._id, status: { $in: LIVE } }, { status: "superseded" });
    await Approval.updateMany({ organizationId, targetId: proposal._id, status: "pending" }, { status: "expired" });
    await Message.updateMany({ organizationId, proposalId: proposal._id, status: { $in: ["queued", "pending_approval", "draft"] } }, { status: "rejected", error: "Superseded by a newer proposal version" });
    return created;
}

// client acceptance is a recorded commercial event; contract and payment stay separate, human steps
export async function recordAcceptance(
    organizationId: Id, proposalId: string,
    input: { acceptedBy: string; evidence: string; messageId?: string }, userId: string,
) {
    const { proposal, lead } = await load(organizationId, proposalId);
    if (proposal.status !== "sent") throw new Conflict(`Proposal is ${proposal.status}; only a sent proposal can be accepted`);
    if (proposal.expiresAt && proposal.expiresAt < new Date()) throw new Conflict("Proposal has expired; create a revision");
    if (input.messageId && !await Message.exists({ organizationId, _id: input.messageId, leadId: lead._id, direction: "inbound" })) {
        throw new BadRequest("messageId must be an inbound message from this opportunity");
    }
    const updated = await Proposal.findOneAndUpdate(
        { organizationId, _id: proposal._id, status: "sent" },
        { status: "accepted", acceptance: { acceptedBy: input.acceptedBy, evidence: input.evidence, messageId: input.messageId, acceptedAt: new Date(), recordedBy: userId } },
        { new: true },
    );
    if (!updated) throw new Conflict("Proposal changed; reload");
    await Lead.updateOne({ organizationId, _id: lead._id }, { opportunityStage: "negotiation" });
    await audit({ organizationId, actorType: "user", actorId: userId, action: "proposal.accepted", targetType: "proposal", targetId: proposal._id.toString(), outcome: "success", metadata: { version: proposal.version, evidence: input.evidence } });
    return updated;
}

// housekeeping: past their validity date, unsent and unanswered versions expire
export async function expireProposals(now = new Date()) {
    await Proposal.updateMany({ status: { $in: ["draft", "pending_approval", "approved", "sent"] }, expiresAt: { $lt: now } }, { status: "expired" }).setOptions({ crossTenant: true });
}
