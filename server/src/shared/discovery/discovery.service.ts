// Importing modules
import mongoose from "mongoose";
import Lead from "../models/lead.model.js";
import UsageRecord from "../models/usageRecord.model.js";
import { request } from "../integrations/core.js";
import { recordUsage, reserve, settle, release } from "../billing/budget.service.js";
import { startOfUtcDay } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import env from "../config/env.config.js";
import ApiError from "../utils/ApiError.util.js";

type Id = mongoose.Types.ObjectId;

export const DISCOVERY_SOURCES = ["openstreetmap", "google_places", "apollo", "web_search"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export interface Candidate {
    name: string;
    website?: string;
    domain?: string;
    email?: string;
    phone?: string;
    address?: string;
    country?: string;
    industry?: string;
    employeeCount?: number;
    sources: DiscoverySource[];
    alreadyLead?: boolean;
}

// a source returns plain candidates; anything it cannot provide stays undefined
type Search = (what: string, where: string) => Promise<Omit<Candidate, "sources">[]>;

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

async function json<T>(source: string, url: string, init: Parameters<typeof request>[1] = {}) {
    const { status, data } = await request<T>(url, init);
    if (status === 401 || status === 403) throw new Error(`${source}: API key rejected`);
    if (status < 200 || status >= 300) throw new Error(`${source}: HTTP ${status}`);
    return data;
}

/* ------------------------------- sources ------------------------------- */

// free: Nominatim understands "dentist in Pune"; usage policy asks for an identifying agent and low volume
const openstreetmap: Search = async (what, where) => {
    const q = new URLSearchParams({ q: `${what} in ${where}`, format: "jsonv2", extratags: "1", addressdetails: "1", limit: "40" });
    type R = { name?: string; display_name?: string; type?: string; extratags?: Record<string, string>; address?: { country?: string } };
    const rows = await json<R[]>("OpenStreetMap", `${env.NOMINATIM_URL.replace(/\/$/, "")}/search?${q}`, {
        headers: { "User-Agent": `easySales/1.0 (+${env.FRONTEND_URL})`, "Accept-Language": "en" },
    });
    return (Array.isArray(rows) ? rows : []).filter((r) => clean(r.name)).map((r) => {
        const t = r.extratags ?? {};
        return {
            name: clean(r.name)!, website: clean(t.website ?? t["contact:website"], 500), email: clean(t.email ?? t["contact:email"]),
            phone: clean(t.phone ?? t["contact:phone"], 40), address: clean(r.display_name, 300), country: clean(r.address?.country, 80),
            industry: clean(r.type?.replace(/_/g, " "), 120),
        };
    });
};

// ponytail: Google's terms limit storing Places content beyond the place id; the business decides whether to use this source
const googlePlaces: Search = async (what, where) => {
    type R = { places?: { displayName?: { text?: string }; websiteUri?: string; internationalPhoneNumber?: string; formattedAddress?: string; primaryTypeDisplayName?: { text?: string }; businessStatus?: string }[] };
    const data = await json<R>("Google Places", "https://places.googleapis.com/v1/places:searchText", {
        method: "POST", body: { textQuery: `${what} in ${where}`, pageSize: 20 },
        headers: {
            "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
            "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.internationalPhoneNumber,places.formattedAddress,places.primaryTypeDisplayName,places.businessStatus",
        },
    });
    return (data.places ?? []).filter((p) => clean(p.displayName?.text) && p.businessStatus !== "CLOSED_PERMANENTLY").map((p) => ({
        name: clean(p.displayName?.text)!, website: clean(p.websiteUri, 500), phone: clean(p.internationalPhoneNumber, 40),
        address: clean(p.formattedAddress, 300), country: clean(p.formattedAddress?.split(",").pop(), 80), industry: clean(p.primaryTypeDisplayName?.text, 120),
    }));
};

// B2B companies by keyword and location (people emails need paid credits; the website gives a contact)
const apollo: Search = async (what, where) => {
    type O = { name?: string; website_url?: string; primary_domain?: string; phone?: string; primary_phone?: { number?: string }; industry?: string; estimated_num_employees?: number; country?: string; city?: string };
    const data = await json<{ organizations?: O[]; accounts?: O[] }>("Apollo", "https://api.apollo.io/api/v1/mixed_companies/search", {
        method: "POST", headers: { "X-Api-Key": env.APOLLO_API_KEY, "Cache-Control": "no-cache" },
        body: { q_organization_keyword_tags: [what], organization_locations: [where], per_page: 25, page: 1 },
    });
    return [...(data.organizations ?? []), ...(data.accounts ?? [])].filter((o) => clean(o.name)).map((o) => ({
        name: clean(o.name)!, website: clean(o.website_url ?? o.primary_domain, 500), phone: clean(o.phone ?? o.primary_phone?.number, 40),
        address: clean([o.city, o.country].filter(Boolean).join(", "), 300), country: clean(o.country, 80), industry: clean(o.industry, 120),
        employeeCount: typeof o.estimated_num_employees === "number" && o.estimated_num_employees >= 0 ? o.estimated_num_employees : undefined,
    }));
};

// listings, directories and social sites are not the business itself
const NOT_A_BUSINESS = /(^|\.)(justdial|indiamart|sulekha|yelp|tripadvisor|yellowpages|facebook|instagram|linkedin|twitter|x|youtube|wikipedia|google|practo|zomato|swiggy|quora|reddit|medium|glassdoor|indeed|naukri|amazon|flipkart|clutch|crunchbase)\.[a-z.]+$/i;

const webSearch: Search = async (what, where) => {
    const q = new URLSearchParams({ q: `${what} in ${where}`, count: "20" });
    type R = { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    const data = await json<R>("Web search", `https://api.search.brave.com/res/v1/web/search?${q}`, { headers: { "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY } });
    return (data.web?.results ?? []).flatMap((r) => {
        const site = domainOf(r.url);
        if (!site || NOT_A_BUSINESS.test(site.domain) || !clean(r.title)) return [];
        // "Smile Dental Clinic | Best dentist in Pune" -> "Smile Dental Clinic"
        return [{ name: clean(r.title!.split(/\s[|\-–:·]\s/)[0])!, website: site.website }];
    });
};

const SEARCH: Record<DiscoverySource, { search: Search; enabled: () => boolean; paid: boolean; label: string }> = {
    openstreetmap: { search: openstreetmap, enabled: () => env.DISCOVERY_OSM, paid: false, label: "OpenStreetMap" },
    google_places: { search: googlePlaces, enabled: () => Boolean(env.GOOGLE_PLACES_API_KEY), paid: true, label: "Google Places" },
    apollo: { search: apollo, enabled: () => Boolean(env.APOLLO_API_KEY), paid: true, label: "Apollo" },
    web_search: { search: webSearch, enabled: () => Boolean(env.BRAVE_SEARCH_API_KEY), paid: true, label: "Web search" },
};

export const discoverySources = () => DISCOVERY_SOURCES.map((id) => ({ id, label: SEARCH[id].label, enabled: SEARCH[id].enabled(), paid: SEARCH[id].paid }));

/* -------------------------------- search -------------------------------- */

const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// one business seen by several sources becomes one candidate: same domain, else same name
export function mergeCandidates(found: { source: DiscoverySource; items: Omit<Candidate, "sources">[] }[]) {
    const out: Candidate[] = [];
    const byDomain = new Map<string, Candidate>();
    const byName = new Map<string, Candidate>();
    for (const { source, items } of found) {
        for (const raw of items) {
            const site = domainOf(raw.website);
            const c: Candidate = { ...raw, website: site?.website, domain: site?.domain, email: raw.email?.toLowerCase(), sources: [source] };
            const same = (c.domain && byDomain.get(c.domain)) || byName.get(nameKey(c.name));
            if (same) {
                // first source wins for each field; later sources only fill gaps
                for (const [k, v] of Object.entries(c)) if (k !== "sources" && v !== undefined && same[k as keyof Candidate] === undefined) Object.assign(same, { [k]: v });
                if (!same.sources.includes(source)) same.sources.push(source);
            } else out.push(c);
            const target = same || c;
            if (target.domain) byDomain.set(target.domain, target);
            byName.set(nameKey(target.name), target);
        }
    }
    return out;
}

/*
    Searches every enabled source (or the requested ones) in parallel. A failing source is
    reported, never fatal. Paid searches are reserved against the spend limit first and
    metered in the usage ledger; a per-workspace daily cap stops runaway searching.
    Nothing is saved here: the user picks candidates and imports them.
*/
export async function discoverLeads(organizationId: Id, userId: string, q: { what: string; where: string; sources?: DiscoverySource[]; limit: number }) {
    const chosen = (q.sources?.length ? q.sources : DISCOVERY_SOURCES).filter((s) => SEARCH[s].enabled());
    if (!chosen.length) throw new ApiError(400, "No lead source is enabled. Turn on OpenStreetMap or add a source API key.");

    const today = await UsageRecord.countDocuments({ organizationId, kind: "discovery", createdAt: { $gte: startOfUtcDay() } });
    if (today >= env.DISCOVERY_SEARCHES_PER_DAY) throw new ApiError(429, `Daily lead search limit (${env.DISCOVERY_SEARCHES_PER_DAY}) reached; try again tomorrow.`);

    const paid = chosen.filter((s) => SEARCH[s].paid);
    const cost = paid.length * env.DISCOVERY_COST_MINOR;
    const reservation = cost > 0 ? await reserve(organizationId, "discovery", cost) : null;

    const results = await Promise.allSettled(chosen.map((s) => SEARCH[s].search(q.what, q.where)));
    const report = chosen.map((source, i) => {
        const r = results[i];
        return r.status === "fulfilled" ? { source, ok: true, count: r.value.length } : { source, ok: false, count: 0, error: (r.reason as Error).message.slice(0, 200) };
    });
    // only searches that ran cost money
    const actual = paid.filter((s) => report.find((r) => r.source === s)?.ok).length * env.DISCOVERY_COST_MINOR;
    if (reservation) await (actual ? settle(organizationId, reservation._id, actual) : release(organizationId, reservation._id));
    await recordUsage(organizationId, { kind: "discovery", quantity: chosen.length, costMinor: actual, provider: chosen.join(","), agent: "discovery" });

    const candidates = mergeCandidates(chosen.flatMap((source, i) => (results[i].status === "fulfilled" ? [{ source, items: (results[i] as PromiseFulfilledResult<Omit<Candidate, "sources">[]>).value }] : [])))
        // businesses found by more sources, and with a website, first
        .sort((a, b) => b.sources.length - a.sources.length || Number(Boolean(b.website)) - Number(Boolean(a.website)))
        .slice(0, q.limit);

    // mark what is already in the pipeline (by email, domain or name)
    const existing = await Lead.find({ organizationId, $or: [
        { "company.domain": { $in: candidates.flatMap((c) => (c.domain ? [c.domain] : [])) } },
        { "contact.email": { $in: candidates.flatMap((c) => (c.email ? [c.email] : [])) } },
        { dedupeKey: { $in: candidates.map((c) => `name:${nameKey(c.name)}`) } },
    ] }, { "company.domain": 1, "contact.email": 1, dedupeKey: 1 }).lean();
    const known = new Set(existing.flatMap((l) => [l.company?.domain, l.contact?.email, l.dedupeKey].filter(Boolean) as string[]));
    for (const c of candidates) c.alreadyLead = Boolean((c.domain && known.has(c.domain)) || (c.email && known.has(c.email)) || known.has(`name:${nameKey(c.name)}`));

    await audit({ organizationId, actorType: "user", actorId: userId, action: "lead.discover", outcome: "success", metadata: { what: q.what, where: q.where, sources: report, found: candidates.length, costMinor: actual } });
    return { candidates, sources: report, costMinor: actual, currency: env.BILLING_CURRENCY };
}
