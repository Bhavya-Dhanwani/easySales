// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// one immutable version of an opportunity's requirements; a change is a new version
const requirementsSchema = new mongoose.Schema({

    ...tenantFields,

    // ponytail: the lead is the opportunity; split out an Opportunity model if one lead can hold several deals
    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true, immutable: true },

    version: { type: Number, required: true, immutable: true },

    // validated by RequirementsSchema before it is stored
    requirements: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },

    // messages the requirements were taken from; verified to belong to this tenant and opportunity
    sourceMessageIds: { type: [mongoose.Schema.Types.ObjectId], immutable: true },

    createdBy: { type: String, required: true, immutable: true },

    changeSummary: { type: String, default: "", maxlength: 500, immutable: true },

}, { timestamps: { createdAt: true, updatedAt: false } });

requirementsSchema.plugin(tenantPlugin);
requirementsSchema.index({ organizationId: 1, opportunityId: 1, version: 1 }, { unique: true });

const Requirements = mongoose.model("Requirements", requirementsSchema);

export default Requirements;
