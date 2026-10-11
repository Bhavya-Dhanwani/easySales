// Importing modules
import BusinessProfile from "../models/businessProfile.model.js";
import { discoverLeads, nextNicheQueries } from "./discovery.service.js";
import { importRows } from "../../modules/private/leads/leads.router.js";
import { entitlementsFor } from "../billing/subscription.service.js";
import { startOfUtcDay } from "../policy/policy.service.js";
import logger from "../config/logger.config.js";

/*
    The daily lead finder: once a day per workspace that turned it on, the agent searches the next
    pairs of its niche, imports up to `dailyLeads` new businesses (with a website or email, so research
    can reach them) using the contact basis the owner chose, and queues research. Qualified leads
    then flow into any active campaign. Same niche lock, caps and dedupe as a manual search.
*/
export async function runLeadFinder(max = 10) {
    for (let n = 0; n < max; n++) {
        // claiming today's run first, so two workers never run the same workspace twice
        const profile = await BusinessProfile.findOneAndUpdate(
            { "leadFinder.enabled": true, "leadFinder.consentBasis": { $exists: true }, $or: [{ "leadFinder.lastRunAt": null }, { "leadFinder.lastRunAt": { $lt: startOfUtcDay() } }] },
            { "leadFinder.lastRunAt": new Date() },
            { new: true },
        ).setOptions({ crossTenant: true });
        if (!profile) return;
        const organizationId = profile.organizationId;
        const result = await findForWorkspace(organizationId, profile.leadFinder!.consentBasis!, profile.leadFinder!.dailyLeads ?? 20)
            .catch((error: Error) => `Failed: ${error.message}`);
        await BusinessProfile.updateOne({ organizationId, _id: profile._id }, { "leadFinder.lastResult": result.slice(0, 300) });
        logger.info({ organizationId: String(organizationId), result }, "Lead finder ran");
    }
}

async function findForWorkspace(organizationId: InstanceType<typeof BusinessProfile>["organizationId"], consentBasis: string, dailyLeads: number) {
    if ((await entitlementsFor(organizationId)).suspended) return "Skipped: subscription inactive";
    const queries = await nextNicheQueries(organizationId, 3);
    if (!queries.length) return "Skipped: add search terms and areas to your niche";
    const { candidates } = await discoverLeads(organizationId, { type: "agent", id: "lead_finder" }, { queries, limit: 100 });
    const label = queries.map((q) => `${q.what} in ${q.where}`).join("; ");
    const rows = candidates.filter((c) => !c.alreadyLead && (c.website || c.email)).slice(0, dailyLeads).map((c) => ({
        companyName: c.name, website: c.website ?? "", contactEmail: c.email ?? "", contactPhone: c.phone, industry: c.industry, country: c.country,
        description: c.address ? `Address: ${c.address}` : undefined,
        consentBasis, consentSource: `Lead finder (${c.source === "web" ? "web" : "OpenStreetMap"} search: ${label})`,
    }));
    if (!rows.length) return `No new businesses for ${label}`;
    const day = new Date().toISOString().slice(0, 10);
    const job = await importRows(organizationId, null, rows, { idempotencyKey: `lead-finder:${day}`, fileName: `Lead finder ${day}: ${label}`, source: "discovery", research: true });
    return `Added ${job?.createdRows ?? 0} leads from ${label}; research queued`;
}
