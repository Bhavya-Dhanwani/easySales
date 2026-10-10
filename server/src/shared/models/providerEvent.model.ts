// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

/*
    Durable record of every provider webhook event: persisted (deduplicated by the
    provider-scoped event id) before we acknowledge, then processed by the worker.
*/
const providerEventSchema = new mongoose.Schema({

    ...tenantFields,

    integrationId: { type: mongoose.Schema.Types.ObjectId, ref: "EmailIntegration", required: true },

    eventId: { type: String, required: true },

    type: { type: String, enum: ["inbound", "delivered", "bounced", "complained"], required: true },

    payload: { type: mongoose.Schema.Types.Mixed, required: true },

    occurredAt: { type: Date, required: true },

    status: { type: String, enum: ["pending", "processing", "processed", "ignored", "failed"], default: "pending" },

    attempts: { type: Number, default: 0 },

    lockedUntil: Date,

    error: String,

}, { timestamps: true });

providerEventSchema.plugin(tenantPlugin);
providerEventSchema.index({ organizationId: 1, integrationId: 1, eventId: 1 }, { unique: true });
providerEventSchema.index({ status: 1, createdAt: 1 });

const ProviderEvent = mongoose.model("ProviderEvent", providerEventSchema);

export default ProviderEvent;
