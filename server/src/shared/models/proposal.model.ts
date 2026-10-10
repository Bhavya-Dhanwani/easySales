// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// a priced offer; numbers come from the deterministic pricing engine, prose from the AI
const proposalSchema = new mongoose.Schema({

    ...tenantFields,

    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", required: true },

    items: [{
        _id: false,
        name: { type: String, required: true },
        priceMinor: { type: Number, required: true, min: 0 },
    }],

    currency: { type: String, required: true },

    subtotalMinor: { type: Number, required: true },

    discountPercent: { type: Number, default: 0 },

    totalMinor: { type: Number, required: true },

    body: { type: String, default: "" },

    status: {
        type: String,
        enum: ["generating", "draft", "pending_approval", "sent", "accepted", "rejected", "failed"],
        default: "generating",
    },

    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: "Approval" },

}, { timestamps: true });

proposalSchema.plugin(tenantPlugin);
proposalSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });

const Proposal = mongoose.model("Proposal", proposalSchema);

export default Proposal;
