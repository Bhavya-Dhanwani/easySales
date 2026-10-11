// Importing modules
import { getSubscription } from "../billing/subscription.service.js";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import Organization from "../models/organization.model.js";
import Membership from "../models/membership.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import { publishPolicy } from "../policy/policy.service.js";
import { DEFAULT_POLICY } from "../policy/policy.schema.js";
import { audit } from "../audit/audit.service.js";

function slugify(name: string) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";
    return `${base}-${randomBytes(3).toString("hex")}`;
}

// creates a tenant with its owner, an empty business profile and the conservative default policy
export async function createOrganizationForUser(user: { _id: mongoose.Types.ObjectId; email: string }, name: string) {
    const org = await Organization.create({ name, slug: slugify(name) });
    await Membership.create({ organizationId: org._id, userId: user._id, email: user.email, role: "owner", status: "active" });
    await BusinessProfile.create({ organizationId: org._id, businessName: name });
    await publishPolicy(org._id, DEFAULT_POLICY, user._id.toString());
    await getSubscription(org._id);
    await audit({
        organizationId: org._id, actorType: "user", actorId: user._id.toString(),
        action: "organization.create", targetType: "organization", targetId: org._id.toString(), outcome: "success",
    });
    return org;
}

// attaches pending invitations for this email to the (now verified) user
export async function activateInvitations(user: { _id: mongoose.Types.ObjectId; email: string }) {
    await Membership.updateMany(
        { email: user.email.toLowerCase(), status: "invited", userId: null },
        { $set: { userId: user._id, status: "active" } },
    ).setOptions({ crossTenant: true });
}

// lists every active organization the user belongs to (for the org switcher)
export async function listUserOrganizations(userId: string) {
    const memberships = await Membership.find({ userId, status: "active" }).setOptions({ crossTenant: true }).lean();
    const orgs = await Organization.find({ _id: { $in: memberships.map((m) => m.organizationId) } }).lean();
    return memberships.map((m) => {
        const org = orgs.find((o) => o._id.equals(m.organizationId));
        return { id: m.organizationId.toString(), name: org?.name ?? "", role: m.role };
    });
}
