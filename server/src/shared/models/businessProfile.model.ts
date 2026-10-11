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
        // the niche lead search is locked to: what to look for ("dentist") and where ("Pune")
        searchTerms: [String],
        searchAreas: [String],
    },

    // daily lead finder: searches the niche on its own and imports new businesses with this contact basis
    leadFinder: {
        enabled: { type: Boolean, default: false },
        consentBasis: { type: String, enum: ["legitimate_interest", "opt_in", "existing_customer"] },
        dailyLeads: { type: Number, default: 20, min: 1, max: 50 },
        lastRunAt: Date,
        lastResult: String,
    },

    // shared with prospects who ask for a meeting (Calendly, Cal.com, Google booking page...)
    meetingLink: { type: String, default: "" },

    brandVoice: { type: String, default: "professional, concise, warm", maxlength: 500 },

    approvedClaims: [String],

    prohibitedClaims: [String],

    // weight per ICP criterion (see qualification/scoring.ts); unset criteria use the defaults
    scoringWeights: { type: Map, of: Number, default: undefined },

    // bumped on every save, recorded on each research report and qualification
    version: { type: Number, default: 1 },

    // approved commercial terms copied verbatim into every proposal (never written by the AI)
    terms: { type: String, default: "", maxlength: 8000 },

    revisionRounds: { type: Number, default: 2, min: 0 },

    // percentages of the total; must add up to 100
    paymentSchedule: {
        type: [{ _id: false, label: { type: String, maxlength: 80 }, percent: { type: Number, min: 1, max: 100 } }],
        default: undefined,
    },

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
