// Importing modules
import { recordStage } from "../analytics/analytics.service.js";
import mongoose from "mongoose";
import Requirements from "../models/requirements.model.js";
import Lead from "../models/lead.model.js";
import Message from "../models/message.model.js";
import { audit } from "../audit/audit.service.js";
import { getCurrentPolicy } from "../policy/policy.service.js";
import { extractRequirements, Requirements as Reqs, RequirementsSchema } from "../../agents/requirements.agent.js";
import { loadProfile } from "../../agents/graphs/common.js";
import BadRequest from "../errors/BadRequest.error.js";
import NotFound from "../errors/NotFound.error.js";

type Id = mongoose.Types.ObjectId | string;

// messages the agent may read: what was actually exchanged, never rejected drafts
const CONTEXT_STATUSES = ["received", "sent", "delivered"];

export const latestRequirements = (organizationId: Id, opportunityId: Id) =>
    Requirements.findOne({ organizationId, opportunityId }).sort({ version: -1 }).lean();

// unresolved scope blocks a build and flags a proposal for review
export function openQuestionsOf(r: Reqs) {
    return [
        ...r.openQuestions,
        ...r.features.filter((f) => f.priority === "must" && f.status === "needs_clarification").map((f) => `${f.name}: needs clarification`),
    ];
}

// every cited message must be one of this tenant's messages on this opportunity
async function verifySources(organizationId: Id, opportunityId: Id, ids: string[]) {
    if (!ids.length) return [];
    const found = await Message.find({ organizationId, leadId: opportunityId, _id: { $in: ids } }, { _id: 1 }).lean();
    return found.map((m) => m._id);
}

/*
    Stores a new immutable version. Concurrent writers collide on the unique
    (org, opportunity, version) index and retry with the next number.
*/
export async function saveRequirementsVersion(organizationId: Id, opportunityId: Id, requirements: Reqs, createdBy: string, changeSummary = "") {
    const parsed = RequirementsSchema.parse(requirements);
    const sources = await verifySources(organizationId, opportunityId, parsed.sourceMessageIds);
    if (sources.length !== new Set(parsed.sourceMessageIds).size) throw new BadRequest("sourceMessageIds must reference this opportunity's messages");

    for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await latestRequirements(organizationId, opportunityId);
        try {
            const doc = await Requirements.create({
                organizationId, opportunityId, version: (latest?.version ?? 0) + 1,
                requirements: parsed, sourceMessageIds: sources, createdBy, changeSummary,
            });
            await recordStage(organizationId, opportunityId, "qualified_opportunity", { via: "requirements" });
            await audit({
                organizationId, actorType: createdBy.startsWith("user:") ? "user" : "agent", actorId: createdBy.split(":")[1] ?? createdBy,
                action: "requirements.version", targetType: "lead", targetId: String(opportunityId), outcome: "success",
                metadata: { version: doc.version, changeSummary, openQuestions: openQuestionsOf(parsed).length },
            });
            return doc;
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
        }
    }
    throw new Error("Could not allocate a requirements version");
}

export async function conversationContext(organizationId: Id, opportunityId: Id) {
    const msgs = await Message.find({ organizationId, leadId: opportunityId, status: { $in: CONTEXT_STATUSES }, body: { $ne: "" } })
        .sort({ createdAt: -1 }).limit(40).lean();
    return msgs.reverse().map((m) => ({ id: m._id.toString(), direction: m.direction, at: m.createdAt, body: m.body ?? "" }));
}

// worker body for requirements.extract
export async function runRequirementsExtraction(organizationId: Id, opportunityId: Id, workflowId: string, correlationId: string) {
    const lead = await Lead.findOne({ organizationId, _id: opportunityId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const messages = await conversationContext(organizationId, opportunityId);
    const { config } = await getCurrentPolicy(organizationId);
    const out = await extractRequirements({ organizationId, workflowId, correlationId }, lead, messages, await loadProfile(String(organizationId)), config.pricing.currency);

    // the model may only cite messages it was shown; anything else is dropped, not trusted
    const shown = new Set(messages.map((m) => m.id));
    const cited = out.sourceMessageIds.filter((id) => shown.has(id));
    const doc = await saveRequirementsVersion(organizationId, opportunityId, { ...out, sourceMessageIds: [...new Set(cited)] }, "agent:requirements", "Extracted from conversation");
    return { version: doc.version, droppedSources: out.sourceMessageIds.length - cited.length };
}
