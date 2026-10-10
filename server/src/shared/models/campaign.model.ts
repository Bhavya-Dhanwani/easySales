// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// an outreach campaign: who to contact, how often, and how many per day
const campaignSchema = new mongoose.Schema({

    ...tenantFields,

    name: { type: String, required: true, trim: true, maxlength: 120 },

    objective: { type: String, default: "", maxlength: 500 },

    status: { type: String, enum: ["draft", "active", "paused", "completed"], default: "draft" },

    audience: {
        statuses: { type: [String], default: ["qualified"] },
        minScore: { type: Number, min: 0, max: 100, default: 70 },
        industries: [String],
        countries: [String],
    },

    // follow-up delays in business days after each previous message, e.g. [3, 4] = two follow-ups
    followUpDelaysDays: { type: [Number], default: [3, 4] },

    dailyLimit: { type: Number, min: 1, max: 1000, default: 20 },

    // send without approval when the tenant policy also allows automatic sending
    autoSend: { type: Boolean, default: false },

    policyVersion: Number,

    startedAt: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

}, { timestamps: true });

campaignSchema.plugin(tenantPlugin);
campaignSchema.index({ organizationId: 1, createdAt: -1 });
campaignSchema.index({ status: 1 });

const Campaign = mongoose.model("Campaign", campaignSchema);

export default Campaign;
