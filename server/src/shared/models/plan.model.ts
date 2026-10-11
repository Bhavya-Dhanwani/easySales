// Importing modules
import mongoose from "mongoose";

/*
    A subscription plan version. Versions are immutable: changing limits or price means a new
    version, and subscriptions keep a snapshot of the entitlements they signed up for.
    Platform data (not tenant-owned).
*/
const planSchema = new mongoose.Schema({

    key: { type: String, required: true, lowercase: true, trim: true },

    name: { type: String, required: true },

    version: { type: Number, required: true },

    priceMinorUnits: { type: Number, required: true, min: 0 },

    currency: { type: String, required: true, minlength: 3, maxlength: 3 },

    billingInterval: { type: String, enum: ["monthly", "yearly"], default: "monthly" },

    entitlements: {
        maxMembers: { type: Number, required: true },
        researchJobsPerMonth: { type: Number, required: true },
        emailSendsPerMonth: { type: Number, required: true },
        prototypeBuildsPerMonth: { type: Number, required: true },
        analyticsLevel: { type: String, enum: ["basic", "advanced"], required: true },
        apiAccess: { type: Boolean, default: false },
    },

    // only active versions can be chosen; old versions stay for existing subscriptions
    active: { type: Boolean, default: true },

    sortOrder: { type: Number, default: 0 },

}, { timestamps: true });

planSchema.index({ key: 1, version: 1 }, { unique: true });

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"] as const) {
    planSchema.pre(op, function () {
        // only the `active` switch may change on an existing version
        const u = this.getUpdate() as Record<string, unknown> | null;
        const keys = Object.keys(u ?? {}).flatMap((k) => (k.startsWith("$") ? Object.keys((u as Record<string, Record<string, unknown>>)[k] ?? {}) : [k]));
        if (keys.some((k) => k !== "active" && k !== "updatedAt")) throw new Error("Plan versions are immutable; create a new version");
    });
}

const Plan = mongoose.model("Plan", planSchema);

export default Plan;
