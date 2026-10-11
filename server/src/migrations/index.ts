// Importing modules
import mongoose from "mongoose";
import Organization from "../shared/models/organization.model.js";
import Message from "../shared/models/message.model.js";
import { getSubscription } from "../shared/billing/subscription.service.js";
import logger from "../shared/config/logger.config.js";

/*
    Versioned data migrations, applied in order, each exactly once (recorded in the
    `migrations` collection). Run before a release goes live (Render preDeployCommand /
    `npm run migrate`), never implicitly at API start. Every migration must be idempotent and
    additive, so the previous release keeps working on the migrated data (rollback-safe).
*/
export const MIGRATIONS: { id: string; description: string; up: () => Promise<unknown> }[] = [
    {
        id: "001-sync-indexes",
        description: "Create or update every index declared by the models (production does not auto-build indexes)",
        up: async () => { for (const m of Object.values(mongoose.models)) await m.syncIndexes(); },
    },
    {
        id: "002-subscriptions-for-existing-workspaces",
        description: "Workspaces created before plans existed get the standard trial",
        up: async () => { for (const o of await Organization.find({}, { _id: 1 }).lean()) await getSubscription(o._id); },
    },
    {
        id: "003-activate-workspaces-already-sending",
        description: "Workspaces that already contacted prospects before the activation gate stay live",
        up: async () => {
            const live = await Message.distinct("organizationId", { direction: "outbound", status: { $in: ["sent", "delivered"] } }).setOptions({ crossTenant: true });
            return Organization.updateMany({ _id: { $in: live }, activatedAt: null }, { activatedAt: new Date(), activatedBy: "migration:003" });
        },
    },
    {
        id: "004-remove-legacy-plan-field",
        description: "The old Organization.plan field was replaced by subscriptions",
        up: async () => Organization.collection.updateMany({ plan: { $exists: true } }, { $unset: { plan: "" } }),
    },
];

const Migration = mongoose.models.Migration ?? mongoose.model("Migration", new mongoose.Schema({
    _id: String, description: String, status: { type: String, enum: ["running", "done", "failed"] }, startedAt: Date, finishedAt: Date, durationMs: Number, error: String,
}, { versionKey: false }));

/*
    Applies pending migrations. A migration row is claimed by inserting it as "running"
    (unique _id), so two deploys starting at once cannot run the same migration twice.
*/
export async function migrate() {
    const done: string[] = [];
    for (const m of MIGRATIONS) {
        const existing = await Migration.findById(m.id).lean<{ status: string } | null>();
        if (existing?.status === "done") continue;
        if (existing?.status === "running") throw new Error(`Migration ${m.id} is marked running (another deploy, or a crash). Check it, then delete that row to retry.`);
        if (existing) await Migration.deleteOne({ _id: m.id, status: "failed" });
        await Migration.create({ _id: m.id, description: m.description, status: "running", startedAt: new Date() });
        const t = Date.now();
        try {
            await m.up();
            await Migration.updateOne({ _id: m.id }, { status: "done", finishedAt: new Date(), durationMs: Date.now() - t });
            logger.info({ migration: m.id, ms: Date.now() - t }, "Migration applied");
            done.push(m.id);
        } catch (error) {
            await Migration.updateOne({ _id: m.id }, { status: "failed", finishedAt: new Date(), error: (error as Error).message.slice(0, 500) });
            throw error;
        }
    }
    return done;
}

export async function migrationStatus() {
    const rows = await Migration.find().lean<{ _id: string; status: string; finishedAt?: Date }[]>();
    return MIGRATIONS.map((m) => ({ id: m.id, description: m.description, status: rows.find((r) => r._id === m.id)?.status ?? "pending" }));
}
