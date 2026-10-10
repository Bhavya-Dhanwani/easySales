// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";

// the structured "business brain" every agent reads from, instead of a giant prompt
const businessProfileSchema = new mongoose.Schema({

    ...tenantFields,

    businessName: { type: String, default: "", maxlength: 120 },

    businessType: { type: String, default: "", maxlength: 120 },

    description: { type: String, default: "", maxlength: 4000 },

    website: { type: String, default: "" },

    services: [{
        _id: false,
        name: { type: String, required: true, maxlength: 120 },
        description: { type: String, default: "", maxlength: 1000 },
        // money is stored as integer minor units (paise/cents), never floats
        basePriceMinor: { type: Number, required: true, min: 0 },
        deliveryDaysMin: { type: Number, min: 0 },
        deliveryDaysMax: { type: Number, min: 0 },
    }],

    idealCustomerProfile: {
        industries: [String],
        companySizes: [String],
        regions: [String],
        requiredSignals: [String],
        disqualifiers: [String],
    },

    brandVoice: { type: String, default: "professional, concise, warm", maxlength: 500 },

    approvedClaims: [String],

    prohibitedClaims: [String],

    caseStudies: [{
        _id: false,
        title: { type: String, maxlength: 200 },
        summary: { type: String, maxlength: 1500 },
    }],

}, { timestamps: true });

businessProfileSchema.plugin(tenantPlugin);
businessProfileSchema.index({ organizationId: 1 }, { unique: true });

const BusinessProfile = mongoose.model("BusinessProfile", businessProfileSchema);

export default BusinessProfile;
