// Importing modules
import mongoose from "mongoose";
import Policy from "../models/policy.model.js";
import Suppression from "../models/suppression.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import { DEFAULT_POLICY, PolicyConfig, PolicyConfigSchema } from "./policy.schema.js";

type OrgId = mongoose.Types.ObjectId | string;

// the effective (latest) policy for an organization
export async function getCurrentPolicy(organizationId: OrgId): Promise<{ version: number; config: PolicyConfig }> {
    const doc = await Policy.findOne({ organizationId }).sort({ version: -1 }).lean();
    if (!doc) return { version: 0, config: DEFAULT_POLICY };
    // re-validate on read: a malformed stored policy must fail closed, not half-apply
    return { version: doc.version, config: PolicyConfigSchema.parse(doc.config) };
}

// writes a new immutable version; concurrent writers collide on the unique (org, version) index
export async function publishPolicy(organizationId: OrgId, config: PolicyConfig, createdBy?: string) {
    const parsed = PolicyConfigSchema.parse(config);
    const current = await getCurrentPolicy(organizationId);
    return Policy.create({ organizationId, version: current.version + 1, config: parsed, createdBy });
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function isSuppressed(organizationId: OrgId, email: string | undefined | null) {
    if (!email) return false;
    return Boolean(await Suppression.exists({ organizationId, channel: "email", value: normalizeEmail(email) }));
}

export function startOfUtcDay(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function llmCallsToday(organizationId: OrgId) {
    return UsageRecord.countDocuments({ organizationId, createdAt: { $gte: startOfUtcDay() } });
}

// true if any prohibited phrase appears (case-insensitive) in the text
export function findProhibitedClaims(text: string, prohibited: string[] = []) {
    const lower = text.toLowerCase();
    return prohibited.filter((p) => p.trim() && lower.includes(p.trim().toLowerCase()));
}
