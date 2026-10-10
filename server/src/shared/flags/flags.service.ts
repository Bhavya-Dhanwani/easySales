// Importing modules
import mongoose from "mongoose";
import FeatureFlag, { FlagKey } from "../models/featureFlag.model.js";

// behaviour when no operator has set a flag
export const FLAG_DEFAULTS: Record<FlagKey, boolean> = {
    // false: email is captured as "sent" by a test provider instead of reaching the recipient
    live_email: true,
    // false: every outbound message and proposal waits for a human, whatever the policy says
    auto_send: true,
    prototypes: true,
};

// tenant override, else global row, else the default
export async function isEnabled(organizationId: mongoose.Types.ObjectId | string, key: FlagKey) {
    const rows = await FeatureFlag.find({ key, organizationId: { $in: [new mongoose.Types.ObjectId(String(organizationId)), null] } }).lean();
    const own = rows.find((r) => r.organizationId);
    const global = rows.find((r) => !r.organizationId);
    return (own ?? global)?.enabled ?? FLAG_DEFAULTS[key];
}
