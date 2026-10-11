// Importing modules
import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import BusinessProfile from "../models/businessProfile.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import { request } from "../integrations/core.js";
import { recordUsage } from "../billing/budget.service.js";
import { startOfUtcDay } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import env from "../config/env.config.js";
import ApiError from "../utils/ApiError.util.js";

type Id = mongoose.Types.ObjectId;

export interface Candidate {
    name: string;
    website?: string;
    domain?: string;
    email?: string;
    phone?: string;
    address?: string;
    country?: string;
    industry?: string;
    alreadyLead?: boolean;
}

const clean = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export function domainOf(raw?: string) {
    if (!raw) return undefined;
    try {
        const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return undefined;
        return { website: url.origin, domain: url.hostname.replace(/^www\./, "").toLowerCase() };
    } catch {
        return undefined;
    }
}

/*
    OpenStreetMap (Nominatim): free, no key. It understands "dentist in Pune". The public
    server asks for an identifying agent and low volume (hence the daily cap).
*/
async function searchOpenStreetMap(what: string, where: string): Promise<Candidate[]> {
    const q = new URLSearchParams({ q: `${what} in ${where}`, format: "jsonv2", extratags: "1", addressdetails: "1", limit: "40" });
    type R = { name?: string; display_name?: string; type?: string; extratags?: Record<string, string>; address?: { country?: string } };
    const { status, data } = await request<R[]>(`${env.NOMINATIM_URL.replace(/\/$/, "")}/search?${q}`, {
        headers: { "User-Agent": `easySales/1.0 (+${env.FRONTEND_URL})`, "Accept-Language": "en" },
    });
    if (status < 200 || status >= 300) throw new Error(`OpenStreetMap: HTTP ${status}`);
    return (Array.isArray(data) ? data : []).filter((r) => clean(r.name)).map((r) => {
        const t = r.extratags ?? {};
        const site = domainOf(clean(t.website ?? t["contact:website"], 500));
        return {
            name: clean(r.name)!, website: site?.website, domain: site?.domain, email: clean(t.email ?? t["contact:email"])?.toLowerCase(),
            phone: clean(t.phone ?? t["contact:phone"], 40), address: clean(r.display_name, 300), country: clean(r.address?.country, 80),
            industry: clean(r.type?.replace(/_/g, " "), 120),
        };
    });
}

const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// overlapping searches ("Pune" and "Pune, India") return the same business: keep it once (same website, else same name)
export function dedupe(found: Candidate[]) {
    const seen = new Set<string>();
    return found.filter((c) => {
        const keys = [c.domain && `d:${c.domain}`, `n:${nameKey(c.name)}`].filter(Boolean) as string[];
        if (keys.some((k) => seen.has(k))) return false;
        keys.forEach((k) => seen.add(k));
        return true;
    });
}

/* --------------------------------- niche --------------------------------- */

type Query = { what: string; where: string };
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function nicheOf(organizationId: Id) {
    const icp = (await BusinessProfile.findOne({ organizationId }, { idealCustomerProfile: 1 }).lean())?.idealCustomerProfile;
    return { searchTerms: icp?.searchTerms ?? [], searchAreas: icp?.searchAreas ?? [], disqualifiers: icp?.disqualifiers ?? [] };
}

/*
    Lead search is locked to the niche the owner configured: a search term and an area from
    the business profile, nothing else. Enforced here in code, whatever the client or an agent asks.
*/
async function inNiche(organizationId: Id, userId: string, queries: Query[]) {
    const niche = await nicheOf(organizationId);
    if (!niche.searchTerms.length || !niche.searchAreas.length) {
        throw new ApiError(400, "Add search terms and search areas to your ideal customer (Settings → Business) first: lead search only runs inside your niche.");
    }
    return {
        niche,
        queries: await Promise.all(queries.map(async (q) => {
            const what = niche.searchTerms.find((t) => same(t, q.what));
            const where = niche.searchAreas.find((a) => same(a, q.where));
            if (what && where) return { what, where };
            await audit({ organizationId, actorType: "user", actorId: userId, action: "lead.discover", outcome: "denied", metadata: { what: q.what, where: q.where, reason: "outside niche" } });
            throw new ApiError(403, `"${what ? q.where : q.what}" is outside your niche. Allowed ${what ? `areas: ${niche.searchAreas.join(", ")}` : `search terms: ${niche.searchTerms.join(", ")}`}.`);
        })),
    };
}

// the agent searching on its own: every term x area of the niche, least recently searched first
export async function nextNicheQueries(organizationId: Id, max: number) {
    const { searchTerms, searchAreas } = await nicheOf(organizationId);
    const all = searchTerms.flatMap((what) => searchAreas.map((where) => ({ what, where })));
    const last = await UsageRecord.aggregate([
        { $match: { organizationId, kind: "discovery" } },
        { $group: { _id: "$refId", at: { $max: "$createdAt" } } },
    ]);
    const at = new Map(last.map((l) => [String(l._id), new Date(l.at).getTime()]));
    return all.sort((a, b) => (at.get(`${a.what}|${a.where}`) ?? 0) - (at.get(`${b.what}|${b.where}`) ?? 0)).slice(0, max);
}

/* -------------------------------- search -------------------------------- */

/*
    Runs each niche query on OpenStreetMap in parallel; a failed query is reported, the rest still
    count. A per-workspace daily cap keeps the free server's usage low. Businesses matching a
    disqualifier are dropped. Nothing is saved here: the user picks candidates and imports them.
*/
export async function discoverLeads(organizationId: Id, userId: string, q: { queries: Query[]; limit: number }) {
    const { niche, queries } = await inNiche(organizationId, userId, q.queries);

    const today = await UsageRecord.countDocuments({ organizationId, kind: "discovery", createdAt: { $gte: startOfUtcDay() } });
    if (today + queries.length > env.DISCOVERY_SEARCHES_PER_DAY) throw new ApiError(429, `Daily lead search limit (${env.DISCOVERY_SEARCHES_PER_DAY}) reached; try again tomorrow.`);

    const results = await Promise.allSettled(queries.map((x) => searchOpenStreetMap(x.what, x.where)));
    for (const x of queries) await recordUsage(organizationId, { kind: "discovery", quantity: 1, provider: "openstreetmap", agent: "discovery", refId: `${x.what}|${x.where}` });
    const failed = queries.flatMap((x, i) => (results[i].status === "rejected" ? [{ ...x, error: ((results[i] as PromiseRejectedResult).reason as Error).message.slice(0, 200) }] : []));
    if (failed.length === queries.length) throw new ApiError(502, `Lead search failed: ${failed[0].error}. Try again in a minute.`);

    const found = dedupe(results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
    // the profile's disqualifiers apply before anyone sees the list
    const bad = niche.disqualifiers.map((d) => d.trim().toLowerCase()).filter((d) => d.length >= 3);
    const kept = found.filter((c) => !bad.some((d) => `${c.name} ${c.industry ?? ""}`.toLowerCase().includes(d)));
    // businesses with a website first (research needs one to find an email)
    const candidates = kept.sort((a, b) => Number(Boolean(b.website)) - Number(Boolean(a.website))).slice(0, q.limit);

    // mark what is already in the pipeline (by email, domain or name)
    const existing = await Lead.find({ organizationId, $or: [
        { "company.domain": { $in: candidates.flatMap((c) => (c.domain ? [c.domain] : [])) } },
        { "contact.email": { $in: candidates.flatMap((c) => (c.email ? [c.email] : [])) } },
        { dedupeKey: { $in: candidates.map((c) => `name:${nameKey(c.name)}`) } },
    ] }, { "company.domain": 1, "contact.email": 1, dedupeKey: 1 }).lean();
    const known = new Set(existing.flatMap((l) => [l.company?.domain, l.contact?.email, l.dedupeKey].filter(Boolean) as string[]));
    for (const c of candidates) c.alreadyLead = Boolean((c.domain && known.has(c.domain)) || (c.email && known.has(c.email)) || known.has(`name:${nameKey(c.name)}`));

    const disqualified = found.length - kept.length;
    await audit({ organizationId, actorType: "user", actorId: userId, action: "lead.discover", outcome: "success", metadata: { queries, failed, found: candidates.length, disqualified } });
    return { candidates, queries, failed, disqualified };
}
