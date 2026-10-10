// Importing modules
import mongoose from "mongoose";

// an organization is the tenant boundary: every business record belongs to exactly one
const organizationSchema = new mongoose.Schema({

    name: { type: String, required: true, trim: true, maxlength: 120 },

    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },

    status: { type: String, enum: ["active", "suspended", "deleting"], default: "active" },

    plan: { type: String, enum: ["free", "starter", "pro", "enterprise"], default: "free" },

    timezone: { type: String, default: "Asia/Kolkata" },

    defaultCurrency: { type: String, default: "INR", minlength: 3, maxlength: 3 },

}, { timestamps: true });

const Organization = mongoose.model("Organization", organizationSchema);

export default Organization;
