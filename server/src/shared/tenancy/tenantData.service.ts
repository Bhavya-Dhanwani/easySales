// Importing modules
import mongoose from "mongoose";
import Organization from "../models/organization.model.js";

// append-only collections: only export/purge touch them, through the raw collection
const RAW_DELETE = new Set(["AuditEvent", "UsageRecord"]);
// never exported, even encrypted
const SECRET_FIELDS = "-smtp.passwordEnc -webhookSecretEnc -previewToken -artifactHtml";

/*
    Every model with an organizationId is tenant data. Derived from the registered models
    so a new collection can never be forgotten by export or deletion.
*/
function tenantModels() {
    return Object.values(mongoose.models).filter((m) => m.modelName !== "Organization" && m.schema.path("organizationId"));
}

export async function exportTenant(organizationId: mongoose.Types.ObjectId) {
    const out: Record<string, unknown> = { organization: await Organization.findById(organizationId).lean(), exportedAt: new Date() };
    for (const model of tenantModels()) {
        out[model.collection.collectionName] = await model.find({ organizationId }).select(SECRET_FIELDS).setOptions({ strictQuery: false }).lean();
    }
    return out;
}

/*
    Deletes all tenant data. Audit events are append-only for application code, so they
    are removed through the raw collection, which only this function does.
*/
export async function purgeTenant(organizationId: mongoose.Types.ObjectId) {
    await Organization.updateOne({ _id: organizationId }, { status: "deleting" });
    for (const model of tenantModels()) {
        if (RAW_DELETE.has(model.modelName)) await model.collection.deleteMany({ organizationId });
        else await model.deleteMany({ organizationId }).setOptions({ crossTenant: true });
    }
    // LangGraph checkpoints are keyed by workflow id; they expire via TTL
    await Organization.deleteOne({ _id: organizationId });
}
