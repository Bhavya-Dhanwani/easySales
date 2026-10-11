// Importing modules
import Lead from "../models/lead.model.js";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import Workflow, { WORKFLOW_TYPES } from "../models/workflow.model.js";
import { getCurrentPolicy } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { currentRequestId } from "../ops/requestContext.js";

type Id = mongoose.Types.ObjectId;

export interface StartWorkflow {
    organizationId: Id;
    type: (typeof WORKFLOW_TYPES)[number];
    entityType: "lead" | "conversation" | "proposal" | "prototype" | "integration";
    entityId: Id;
    input?: Record<string, unknown>;
    idempotencyKey: string;
    startedBy?: string;
    actor: { type: "user" | "agent" | "system"; id: string };
}

/*
    Enqueues a durable workflow. The idempotency key makes repeated requests (double
    clicks, client retries, webhook redelivery) return the original workflow.
*/
export async function startWorkflow(req: StartWorkflow) {
    const existing = await Workflow.findOne({ organizationId: req.organizationId, idempotencyKey: req.idempotencyKey }).lean();
    if (existing) return { workflow: existing, created: false };

    const { version } = await getCurrentPolicy(req.organizationId);
    const band = req.entityType === "lead" ? (await Lead.findOne({ organizationId: req.organizationId, _id: req.entityId }, { "qualification.priority": 1 }).lean())?.qualification?.priority : undefined;
    try {
        const workflow = await Workflow.create({
            organizationId: req.organizationId, type: req.type, entityType: req.entityType, entityId: req.entityId,
            input: req.input ?? {}, idempotencyKey: req.idempotencyKey, policyVersion: version, priority: band === "high" ? 2 : band === "medium" ? 1 : 0,
            startedBy: req.startedBy, correlationId: currentRequestId() ?? randomUUID(),
        });
        await audit({
            organizationId: req.organizationId, actorType: req.actor.type, actorId: req.actor.id, action: "workflow.start",
            targetType: req.entityType, targetId: req.entityId.toString(), outcome: "success", policyVersion: version,
            correlationId: workflow.correlationId, metadata: { type: req.type, workflowId: workflow._id.toString() },
        });
        return { workflow: workflow.toObject(), created: true };
    } catch (error) {
        // lost a race on the unique idempotency index: return the winner
        if ((error as { code?: number }).code === 11000) {
            const winner = await Workflow.findOne({ organizationId: req.organizationId, idempotencyKey: req.idempotencyKey }).lean();
            if (winner) return { workflow: winner, created: false };
        }
        throw error;
    }
}

// an active run for this entity, if any (used to stop parallel pipelines on one lead)
export async function activeWorkflowFor(organizationId: Id, entityId: Id, type: StartWorkflow["type"]) {
    return Workflow.findOne({ organizationId, entityId, type, status: { $in: ["queued", "running", "waiting_approval"] } }).lean();
}
