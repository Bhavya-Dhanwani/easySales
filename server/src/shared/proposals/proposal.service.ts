// Importing modules
import mongoose from "mongoose";
import Proposal from "../models/proposal.model.js";
import Lead from "../models/lead.model.js";
import Conversation from "../models/conversation.model.js";
import Message from "../models/message.model.js";
import Approval from "../models/approval.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import { evaluate } from "../policy/policy.engine.js";
import { getCurrentPolicy, isSuppressed } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { hashPayload } from "../utils/hash.util.js";
import { formatMoney } from "../utils/pricing.util.js";
import { writeProposal } from "../../agents/proposal.agent.js";
import { ProfileForPrompt } from "../../agents/prompts.js";
import { ensureConversation } from "../../agents/graphs/common.js";
import BadRequest from "../errors/BadRequest.error.js";
import NotFound from "../errors/NotFound.error.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId;

// renders the final document: prose from the model, every number from code
export function renderProposal(
    narrative: { title: string; understanding: string; approach: string[]; nextSteps: string[] },
    p: { items: { name: string; priceMinor: number }[]; subtotalMinor: number; discountPercent: number; totalMinor: number; currency: string },
) {
    const money = (m: number) => formatMoney(m, p.currency);
    const lines = p.items.map((i) => `- ${i.name}: ${money(i.priceMinor)}`).join("\n");
    const discount = p.discountPercent > 0 ? `\nDiscount (${p.discountPercent}%): -${money(p.subtotalMinor - p.totalMinor)}` : "";
    return `${narrative.title}

Our understanding
${narrative.understanding}

Approach
${narrative.approach.map((a) => `- ${a}`).join("\n")}

Investment
${lines}
Subtotal: ${money(p.subtotalMinor)}${discount}
Total: ${money(p.totalMinor)}

Next steps
${narrative.nextSteps.map((n, i) => `${i + 1}. ${n}`).join("\n")}

This proposal is valid for 30 days and becomes binding only once a written agreement is signed by both parties.`;
}

// background job body: the model writes the narrative for an already-priced proposal
export async function generateProposalBody(organizationId: string, proposalId: string, workflowId: string, correlationId: string) {
    const proposal = await Proposal.findOne({ organizationId, _id: proposalId });
    if (!proposal) throw new NotFound("Proposal not found");
    if (proposal.status !== "generating") return proposal;

    const lead = await Lead.findOne({ organizationId, _id: proposal.leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const conversation = await Conversation.findOne({ organizationId, leadId: lead._id }).lean();
    const profile = (await BusinessProfile.findOne({ organizationId }).lean() ?? {}) as ProfileForPrompt;

    try {
        const narrative = await writeProposal({ organizationId, workflowId, correlationId }, lead, conversation?.summary ?? "", proposal.items, profile);
        proposal.body = renderProposal(narrative, proposal);
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

// queues the outbound email carrying the proposal (after policy / approval)
async function queueProposalMessage(organizationId: Id, proposal: InstanceType<typeof Proposal>, lead: { _id: Id; contact?: { email?: string | null } | null }) {
    const conversation = await ensureConversation(organizationId.toString(), lead._id);
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    await Message.updateOne(
        { organizationId, idempotencyKey: `proposal:${proposal._id}` },
        {
            $setOnInsert: {
                organizationId, conversationId: conversation._id, leadId: lead._id, direction: "outbound", kind: "proposal",
                to: lead.contact?.email, subject: `Proposal from ${profile?.businessName || "us"}`, body: proposal.body,
                status: "queued", idempotencyKey: `proposal:${proposal._id}`, proposalId: proposal._id,
            },
        },
        { upsert: true },
    );
}

/*
    Sending a proposal: pricing limits are checked by the policy engine. Inside policy
    it is queued; outside policy (discount, minimum value, auto-send disabled) a human
    must approve the exact proposal body.
*/
export async function requestProposalSend(organizationId: Id, proposalId: string, actorId: string) {
    const proposal = await Proposal.findOne({ organizationId, _id: proposalId });
    if (!proposal) throw new NotFound("Proposal not found");
    if (proposal.status !== "draft") throw new Conflict(`Proposal is ${proposal.status}, only drafts can be sent`);
    const lead = await Lead.findOne({ organizationId, _id: proposal.leadId }).lean();
    if (!lead?.contact?.email) throw new BadRequest("Lead has no contact email");
    if (await isSuppressed(organizationId, lead.contact.email)) throw new Conflict("Recipient has opted out");

    const { config, version } = await getCurrentPolicy(organizationId);
    const result = evaluate({
        type: "proposal.send", totalMinor: proposal.totalMinor, discountPercent: proposal.discountPercent, currency: proposal.currency,
    }, config);

    if (result.decision === "allow") {
        proposal.status = "approved";
        await proposal.save();
        await queueProposalMessage(organizationId, proposal, lead);
    } else {
        const payload = { proposalId: proposal._id.toString(), body: proposal.body, totalMinor: proposal.totalMinor, discountPercent: proposal.discountPercent, to: lead.contact.email };
        const approval = await Approval.create({
            organizationId, actionType: "proposal.send", targetType: "proposal", targetId: proposal._id, leadId: lead._id,
            payload, payloadHash: hashPayload(payload), policyVersion: version, reasons: result.reasons,
            requestedBy: `user:${actorId}`, expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
        });
        proposal.status = "pending_approval";
        proposal.approvalId = approval._id;
        await proposal.save();
    }

    await audit({
        organizationId, actorType: "user", actorId, action: "proposal.send", targetType: "proposal", targetId: proposal._id.toString(),
        decision: result.decision, outcome: result.decision === "allow" ? "success" : "pending", policyVersion: version,
        metadata: { reasons: result.reasons, totalMinor: proposal.totalMinor },
    });
    return { proposal, decision: result.decision, reasons: result.reasons };
}

export async function executeApprovedProposal(organizationId: Id, proposalId: Id) {
    const proposal = await Proposal.findOne({ organizationId, _id: proposalId });
    if (!proposal) throw new NotFound("Proposal not found");
    const lead = await Lead.findOne({ organizationId, _id: proposal.leadId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    proposal.status = "approved";
    await proposal.save();
    await queueProposalMessage(organizationId, proposal, lead);
}
