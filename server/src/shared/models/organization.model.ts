// Importing modules
import mongoose from "mongoose";

// an organization is the tenant boundary: every business record belongs to exactly one
const organizationSchema = new mongoose.Schema({

    name: { type: String, required: true, trim: true, maxlength: 120 },

    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    status: { type: String, enum: ["active", "suspended", "deleting"], default: "active" },

    industry: { type: String, trim: true, maxlength: 120 },

    timezone: { type: String, default: "Asia/Kolkata" },

    defaultCurrency: { type: String, default: "INR", minlength: 3, maxlength: 3 },

    // outreach to real prospects is possible only after onboarding passes and someone activates
    activatedAt: { type: Date, default: null },

    activatedBy: String,

    onboarding: {
        voiceConfirmedAt: Date,
        limitsConfirmedAt: Date,
        testLeadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead" },
    },

}, { timestamps: true });

const Organization = mongoose.model("Organization", organizationSchema);

export default Organization;
