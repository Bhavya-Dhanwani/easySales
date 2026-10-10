// Importing modules
import mongoose from "mongoose";
import tenantPlugin, { tenantFields } from "../tenancy/tenant.plugin.js";
import { ROLES } from "../tenancy/rbac.js";

// links a user identity to an organization with a role; one user may belong to many organizations
const membershipSchema = new mongoose.Schema({

    ...tenantFields,

    // null until an invited person signs up
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // the invited address, used to attach the membership on signup/login
    email: { type: String, required: true, lowercase: true, trim: true },

    role: { type: String, enum: ROLES, required: true },

    status: { type: String, enum: ["invited", "active", "suspended"], default: "invited" },

    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

}, { timestamps: true });

membershipSchema.plugin(tenantPlugin);
membershipSchema.index({ organizationId: 1, email: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });

const Membership = mongoose.model("Membership", membershipSchema);

export default Membership;
