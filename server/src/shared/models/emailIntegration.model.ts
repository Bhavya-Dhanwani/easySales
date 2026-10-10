// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// a tenant's connected sending account; secrets are stored encrypted (crypto.util)
const emailIntegrationSchema = new mongoose.Schema({

    ...tenantFields,

    provider: { type: String, enum: ["smtp"], default: "smtp" },

    status: { type: String, enum: ["connected", "error", "disconnected"], default: "connected" },

    // sender identity used for every outbound message of this tenant
    fromName: { type: String, required: true, maxlength: 120 },
    fromEmail: { type: String, required: true, lowercase: true, trim: true },
    replyTo: { type: String, lowercase: true, trim: true },

    smtp: {
        host: { type: String, required: true },
        port: { type: Number, required: true },
        secure: { type: Boolean, default: false },
        user: { type: String, required: true },
        passwordEnc: { type: String, required: true },
    },

    // HMAC secret for this account's inbound/event webhook (encrypted)
    webhookSecretEnc: { type: String, required: true },

    lastVerifiedAt: Date,
    lastError: String,
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

}, { timestamps: true });

emailIntegrationSchema.plugin(tenantPlugin);
emailIntegrationSchema.index({ organizationId: 1 }, { unique: true });

const EmailIntegration = mongoose.model("EmailIntegration", emailIntegrationSchema);

export default EmailIntegration;
