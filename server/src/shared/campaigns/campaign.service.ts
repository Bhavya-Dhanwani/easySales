// Importing modules
import mongoose from "mongoose";
import Campaign from "../models/campaign.model.js";
import Lead from "../models/lead.model.js";
import Suppression from "../models/suppression.model.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { escapeRegex } from "../utils/request.util.js";
import { startOfUtcDay } from "../policy/policy.service.js";

type CampaignDoc = { _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; audience?: { statuses?: string[]; minScore?: number | null; industries?: string[]; countries?: string[] } | null };

// the Mongo filter for leads a campaign may enroll: matching audience, contactable, not in another campaign
export function audienceFilter(c: CampaignDoc) {
    const a = c.audience ?? {};
    const anyOf = (values: string[] | undefined) => (values?.length ? { $in: values.map((v) => new RegExp(`^${escapeRegex(v)}$`, "i")) } : undefined);
    return {
        organizationId: c.organizationId,
        status: { $in: a.statuses?.length ? a.statuses : ["qualified"] },
        "qualification.score": { $gte: a.minScore ?? 0 },
        outreachStatus: { $in: ["not_started", "eligible"] },
        "contact.email": { $type: "string" },
        campaignId: { $exists: false },
        ...(anyOf(a.industries) && { "company.industry": anyOf(a.industries) }),
        ...(anyOf(a.countries) && { "company.country": anyOf(a.countries) }),
    };
}

/*
    Enrolls eligible leads into active campaigns, within each campaign's daily limit.
    Each enrollment starts the normal lead pipeline (draft → policy → approval/send);
    the policy engine and send-time checks still apply to every message.
*/
export async function enrollCampaigns(perTick = 20) {
    const active = await Campaign.find({ status: "active" }).setOptions({ crossTenant: true }).lean();
    for (const c of active) {
        const today = await Lead.countDocuments({ organizationId: c.organizationId, campaignId: c._id, "source.enrolledAt": { $gte: startOfUtcDay() } });
        let room = Math.min(perTick, c.dailyLimit - today);
        if (room <= 0) continue;
        const suppressed = new Set((await Suppression.find({ organizationId: c.organizationId }, { value: 1 }).lean()).map((s) => s.value));
        const candidates = await Lead.find(audienceFilter(c), { "contact.email": 1 }).sort({ "qualification.score": -1 }).limit(room * 2).lean();
        for (const lead of candidates) {
            if (room <= 0) break;
            if (suppressed.has(String(lead.contact?.email))) continue;
            // claim the lead atomically so two workers can never enroll it twice
            const claimed = await Lead.updateOne({ organizationId: c.organizationId, _id: lead._id, campaignId: { $exists: false } }, { campaignId: c._id, "source.enrolledAt": new Date() });
            if (!claimed.modifiedCount) continue;
            await startWorkflow({
                organizationId: c.organizationId, type: "lead.pipeline", entityType: "lead", entityId: lead._id,
                input: { campaignId: String(c._id) }, idempotencyKey: `campaign:${c._id}:${lead._id}`, actor: { type: "system", id: `campaign:${c._id}` },
            });
            room--;
        }
    }
}
