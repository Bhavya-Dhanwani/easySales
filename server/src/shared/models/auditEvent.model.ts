// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// append-only record of who did what, under which policy, with what result
const auditEventSchema = new mongoose.Schema({

    ...tenantFields,

    actorType: { type: String, enum: ["user", "agent", "system"], required: true },

    actorId: { type: String, required: true },

    action: { type: String, required: true },

    targetType: String,

    targetId: String,

    decision: { type: String, enum: ["allow", "needs_approval", "deny", null], default: null },

    outcome: { type: String, enum: ["success", "failure", "pending", "uncertain", "denied"], required: true },

    policyVersion: Number,

    correlationId: String,

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

}, { timestamps: { createdAt: true, updatedAt: false } });

auditEventSchema.plugin(tenantPlugin);
auditEventSchema.index({ organizationId: 1, createdAt: -1 });

// append-only at the application level
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
    auditEventSchema.pre(op, function () {
        throw new Error("Audit events are append-only");
    });
}

const AuditEvent = mongoose.model("AuditEvent", auditEventSchema);

export default AuditEvent;
