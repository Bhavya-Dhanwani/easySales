// Importing modules
import mongoose from "mongoose";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { BaseCheckpointSaver } from "@langchain/langgraph";
import Workflow from "../../shared/models/workflow.model.js";
import BusinessProfile from "../../shared/models/businessProfile.model.js";
import Conversation from "../../shared/models/conversation.model.js";
import { ProfileForPrompt } from "../prompts.js";

let saver: BaseCheckpointSaver | null = null;

/*
    Durable LangGraph checkpoints in MongoDB (same cluster as the app). Each workflow
    is a thread; a crashed or paused workflow resumes from its last completed node.
*/
export async function getCheckpointer() {
    if (!saver) {
        const mongo = new MongoDBSaver({
            // mongoose bundles its own driver copy; the runtime client is compatible
            client: mongoose.connection.getClient() as unknown as ConstructorParameters<typeof MongoDBSaver>[0]["client"],
            dbName: mongoose.connection.name,
            checkpointCollectionName: "lg_checkpoints",
            checkpointWritesCollectionName: "lg_checkpoint_writes",
            ttl: 60 * 60 * 24 * 30,
        });
        await mongo.setup();
        saver = mongo;
    }
    return saver;
}

// lets tests reset the singleton between database instances
export function resetCheckpointer() {
    saver = null;
}

// records the node a workflow is in, for the live UI timeline
export async function markStep(organizationId: string, workflowId: string, step: string) {
    await Workflow.updateOne({ organizationId, _id: workflowId }, { currentStep: step });
}

export async function loadProfile(organizationId: string): Promise<ProfileForPrompt> {
    const profile = await BusinessProfile.findOne({ organizationId }).lean();
    return (profile ?? {}) as ProfileForPrompt;
}

// one email conversation per lead (created on first contact)
export async function ensureConversation(organizationId: string, leadId: mongoose.Types.ObjectId) {
    return Conversation.findOneAndUpdate(
        { organizationId, leadId, channel: "email" },
        { $setOnInsert: { organizationId, leadId, channel: "email", status: "open" } },
        { upsert: true, new: true },
    );
}
