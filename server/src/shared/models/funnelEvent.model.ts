// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

export const FUNNEL_STAGES = [
    "discovered", "researched", "icp_qualified", "contacted", "delivered", "positive_reply",
    "qualified_opportunity", "proposal_sent", "won", "lost",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/*
    The first time a lead reaches a funnel stage. One row per (lead, stage), written
    idempotently, so every metric is a count of distinct leads computed from the same events.
*/
const funnelEventSchema = new mongoose.Schema({

    ...tenantFields,

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    stage: { type: String, enum: FUNNEL_STAGES, required: true },

    occurredAt: { type: Date, required: true },

    // cohort and segment are frozen at write time so later edits do not move history
    cohortMonth: String,

    cohortWeek: String,

    segment: String,

    experimentId: { type: mongoose.Schema.Types.ObjectId, ref: "Experiment" },

    variantId: String,

    workflowVersion: String,

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

});

funnelEventSchema.plugin(tenantPlugin);
funnelEventSchema.index({ organizationId: 1, leadId: 1, stage: 1 }, { unique: true });
funnelEventSchema.index({ organizationId: 1, cohortMonth: 1, stage: 1 });
funnelEventSchema.index({ organizationId: 1, experimentId: 1, stage: 1 });

const FunnelEvent = mongoose.model("FunnelEvent", funnelEventSchema);

export default FunnelEvent;
