// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// do-not-contact list, checked immediately before every send
const suppressionSchema = new mongoose.Schema({

    ...tenantFields,

    channel: { type: String, enum: ["email"], default: "email" },

    // normalized (lowercased, trimmed) address
    value: { type: String, required: true, lowercase: true, trim: true },

    reason: { type: String, enum: ["opt_out", "complaint", "bounce", "manual"], required: true },

    source: String,

}, { timestamps: true });

suppressionSchema.plugin(tenantPlugin);
suppressionSchema.index({ organizationId: 1, channel: 1, value: 1 }, { unique: true });

const Suppression = mongoose.model("Suppression", suppressionSchema);

export default Suppression;
