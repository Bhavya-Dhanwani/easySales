// Importing modules
import mongoose from "mongoose";

export const FLAGS = ["live_email", "auto_send", "prototypes"] as const;
export type FlagKey = (typeof FLAGS)[number];

/*
    Operator-controlled rollout switches. A row without organizationId is the global
    default; a row with one overrides it for that tenant. Not tenant-owned data, so no
    tenant plugin: only platform admins write it.
*/
const featureFlagSchema = new mongoose.Schema({

    key: { type: String, enum: FLAGS, required: true },

    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },

    enabled: { type: Boolean, required: true },

    note: { type: String, maxlength: 300 },

    updatedBy: String,

}, { timestamps: true });

featureFlagSchema.index({ key: 1, organizationId: 1 }, { unique: true });

const FeatureFlag = mongoose.model("FeatureFlag", featureFlagSchema);

export default FeatureFlag;
