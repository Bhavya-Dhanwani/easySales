// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// one variable per experiment, so a difference can be attributed to it
export const EXPERIMENT_VARIABLES = ["subject_line", "opening", "value_proposition", "call_to_action"] as const;
export const EXPERIMENT_METRICS = ["positive_reply_rate", "qualified_opportunity_rate"] as const;

/*
    A controlled outreach test: approved variants of one element of the first email.
    Variants only change what the writer is told; policy, caps, suppression and
    approvals apply exactly as for any other message.
*/
const experimentSchema = new mongoose.Schema({

    ...tenantFields,

    name: { type: String, required: true, maxlength: 120 },

    hypothesis: { type: String, required: true, maxlength: 1000 },

    variable: { type: String, enum: EXPERIMENT_VARIABLES, required: true },

    // who may be enrolled: campaign, industries and a minimum fit score (all optional)
    audience: {
        campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
        industries: [String],
        minScore: Number,
    },

    // the first variant is the control
    variants: [{
        _id: false,
        id: { type: String, required: true },
        label: { type: String, required: true, maxlength: 80 },
        // approved instruction for the writer, e.g. the exact subject line to use
        instruction: { type: String, required: true, maxlength: 600 },
    }],

    primaryMetric: { type: String, enum: EXPERIMENT_METRICS, default: "positive_reply_rate" },

    // stopping rule: results are not called before every variant has this many contacted prospects
    minSamplePerVariant: { type: Number, default: 50, min: 10 },

    status: { type: String, enum: ["draft", "running", "paused", "completed"], default: "draft" },

    startedAt: Date,

    endedAt: Date,

    createdBy: String,

}, { timestamps: true });

experimentSchema.plugin(tenantPlugin);
experimentSchema.index({ organizationId: 1, status: 1, createdAt: 1 });

const Experiment = mongoose.model("Experiment", experimentSchema);

export default Experiment;
