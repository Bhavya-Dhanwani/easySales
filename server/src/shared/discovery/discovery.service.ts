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
    source: "openstreetmap" | "web";
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
            industry: clean(r.type?.replace(/_/g, " "), 120), source: "openstreetmap" as const,
        };
    });
}

// listings, directories and social sites are not the business itself
const NOT_A_BUSINESS = ["justdial.com", "indiamart.com", "sulekha.com", "yelp.com", "tripadvisor.com", "tripadvisor.in", "yellowpages.com", "facebook.com", "instagram.com",
    "linkedin.com", "x.com", "twitter.com", "youtube.com", "wikipedia.org", "google.com", "practo.com", "zomato.com", "swiggy.com", "quora.com", "reddit.com",
    "medium.com", "glassdoor.com", "indeed.com", "naukri.com", "amazon.in", "amazon.com", "flipkart.com", "clutch.co", "crunchbase.com", "lybrate.com", "magicpin.in"];
const isDirectory = (domain: string) => NOT_A_BUSINESS.some((d) => domain === d || domain.endsWith(`.${d}`));

// "Top 10 Dental Clinics in Pune", "15 best ...", "list of ...": articles about businesses, not a business
const LISTICLE = /\btop\s*\d+\b|\b\d+\s+best\b|\blist of\b|\bdirectory\b|\b20\d\d edition\b/i;
const SEO_WORDS = /\b(best|top|near me|no\.?\s?1|#1|leading|affordable|cheapest)\b/i;

// longest run of characters two strings share ("jupiterhospitalpune" vs "jupiterhospital" -> 15)
function sharedRun(a: string, b: string) {
    let best = 0;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
        let k = 0;
        while (a[i + k] && a[i + k] === b[j + k]) k++;
        if (k > best) best = k;
    }
    return best;
}

/*
    A page title is mostly SEO ("Best Dentist in Pune Near Me | Vanilla Smiles"). The business name is the
    part that matches its own website (vanillasmiles.dental), never a slogan or "<what> in <where>";
    else a name made from the domain (vanilla-smiles.in -> Vanilla Smiles).
*/
export function businessName(title: string, what: string, where: string, domain: string) {
    const city = where.split(",")[0].trim().toLowerCase();
    const label = domain.split(".")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
    const parts = title.split(/\s*[|–·:«»]\s*|\s+-\s*|\s*-\s+/).map((part) => part.trim()).filter((part) => part.length > 1);
    const generic = (part: string) => SEO_WORDS.test(part) || (part.toLowerCase().includes(what.toLowerCase()) && part.toLowerCase().includes(city));
    // most of the name must match the site's name: a shared common word ("dental", "hospital") is not enough
    const matching = parts.filter((part) => !generic(part))
        .map((part) => { const compact = part.toLowerCase().replace(/[^a-z0-9]/g, ""); return { part, run: sharedRun(compact, label), need: Math.max(5, 0.6 * Math.min(compact.length, label.length)) }; })
        .filter((m) => m.run >= m.need)
        .sort((x, y) => y.run - x.run)[0];
    return matching?.part ?? domain.split(".")[0].replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/*
    Tavily web search (free plan: 1,000 searches a month, no card). Turns on when TAVILY_API_KEY
    is set. Finds businesses that are on the web but not on the map; only their own sites are kept.
*/
async function searchWeb(what: string, where: string): Promise<Candidate[]> {
    type R = { results?: { title?: string; url?: string }[] };
    const { status, data } = await request<R>("https://api.tavily.com/search", {
        method: "POST", token: env.TAVILY_API_KEY,
        body: { query: `${what} in ${where}`, search_depth: "basic", topic: "general", max_results: 20, exclude_domains: NOT_A_BUSINESS },
    });
    if (status === 401 || status === 403) throw new Error("Web search: API key rejected");
    if (status === 432 || status === 433) throw new Error("Web search: monthly free searches used up");
    if (status < 200 || status >= 300) throw new Error(`Web search: HTTP ${status}`);
    return (data.results ?? []).flatMap((r) => {
        const site = domainOf(r.url);
        const title = clean(r.title);
        if (!site || !title || isDirectory(site.domain) || LISTICLE.test(title)) return [];
        return [{ name: businessName(title, what, where, site.domain).slice(0, 200), website: site.website, domain: site.domain, source: "web" as const }];
    });
}

const SOURCES = () => [searchOpenStreetMap, ...(env.TAVILY_API_KEY ? [searchWeb] : [])];
export const webSearchEnabled = () => Boolean(env.TAVILY_API_KEY);

const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// overlapping searches and sources return the same business: keep it once (same website, else same name; the map entry wins)
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
type Actor = { type: "user" | "agent"; id: string };

async function inNiche(organizationId: Id, actor: Actor, queries: Query[]) {
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
            await audit({ organizationId, actorType: actor.type, actorId: actor.id, action: "lead.discover", outcome: "denied", metadata: { what: q.what, where: q.where, reason: "outside niche" } });
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
    Runs each niche query on OpenStreetMap (and Tavily web search when keyed) in parallel; a failed
    search is reported, the rest still count. A per-workspace daily cap keeps the free usage low
    (30 a day stays under Tavily's 1,000 a month). Businesses matching a
    disqualifier are dropped. Nothing is saved here: the user picks candidates and imports them.
*/
export async function discoverLeads(organizationId: Id, actor: Actor, q: { queries: Query[]; limit: number }) {
    const { niche, queries } = await inNiche(organizationId, actor, q.queries);

    const today = await UsageRecord.countDocuments({ organizationId, kind: "discovery", createdAt: { $gte: startOfUtcDay() } });
    if (today + queries.length > env.DISCOVERY_SEARCHES_PER_DAY) throw new ApiError(429, `Daily lead search limit (${env.DISCOVERY_SEARCHES_PER_DAY}) reached; try again tomorrow.`);

    const jobs = queries.flatMap((query) => SOURCES().map((search) => ({ query, search })));
    const results = await Promise.allSettled(jobs.map((j) => j.search(j.query.what, j.query.where)));
    const provider = webSearchEnabled() ? "openstreetmap,tavily" : "openstreetmap";
    for (const x of queries) await recordUsage(organizationId, { kind: "discovery", quantity: 1, provider, agent: "discovery", refId: `${x.what}|${x.where}` });
    const failed = jobs.flatMap((j, i) => (results[i].status === "rejected" ? [{ ...j.query, error: ((results[i] as PromiseRejectedResult).reason as Error).message.slice(0, 200) }] : []));
    if (failed.length === jobs.length) throw new ApiError(502, `Lead search failed: ${failed[0].error}. Try again in a minute.`);

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
    await audit({ organizationId, actorType: actor.type, actorId: actor.id, action: "lead.discover", outcome: "success", metadata: { queries, failed, found: candidates.length, disqualified } });
    return { candidates, queries, failed, disqualified, webSearch: webSearchEnabled() };
}
