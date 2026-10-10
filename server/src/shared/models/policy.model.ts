// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// immutable, versioned policy snapshots; the highest version is the effective policy
const policySchema = new mongoose.Schema({

    ...tenantFields,

    version: { type: Number, required: true, min: 1, immutable: true },

    // validated by PolicyConfigSchema before it is ever written
    config: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", immutable: true },

}, { timestamps: true });

policySchema.plugin(tenantPlugin);
policySchema.index({ organizationId: 1, version: -1 }, { unique: true });

const Policy = mongoose.model("Policy", policySchema);

export default Policy;
