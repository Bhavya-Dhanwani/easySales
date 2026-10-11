// Importing modules
import env from "../config/env.config.js";
import {
    CalendarAdapter, CrmAdapter, fail, NormalizedCompany, NormalizedContact, ok, ProviderError, ReconnectRequiredError, request,
} from "./core.js";

/* ============================== HubSpot ============================== */

const HS = "https://api.hubapi.com";
const CONTACT_PROPS = ["email", "firstname", "lastname", "jobtitle", "phone", "associatedcompanyid", "company", "lastmodifieddate"];
const COMPANY_PROPS = ["name", "domain", "industry", "numberofemployees", "country", "hs_lastmodifieddate"];
// HubSpot-defined association type ids
const ASSOC = { contactToCompany: 279, dealToContact: 3, dealToCompany: 341 };
const STAGE_OUT: Record<string, string> = { qualified: "qualifiedtobuy", discovery: "appointmentscheduled", proposal: "presentationscheduled", negotiation: "contractsent", won: "closedwon", lost: "closedlost" };
const STAGE_IN: Record<string, string> = { ...Object.fromEntries(Object.entries(STAGE_OUT).map(([k, v]) => [v, k])), decisionmakerboughtin: "negotiation" };

type HsObject = { id: string; properties: Record<string, string | null>; updatedAt?: string };

const contactOf = (o: HsObject): NormalizedContact => ({
    externalId: o.id, email: o.properties.email?.toLowerCase() || undefined, firstName: o.properties.firstname || undefined, lastName: o.properties.lastname || undefined,
    title: o.properties.jobtitle || undefined, phone: o.properties.phone || undefined, companyExternalId: o.properties.associatedcompanyid || undefined,
    companyName: o.properties.company || undefined, updatedAt: new Date(o.properties.lastmodifieddate ?? o.updatedAt ?? Date.now()),
});
const companyOf = (o: HsObject): NormalizedCompany => ({
    externalId: o.id, name: o.properties.name || o.properties.domain || "Unnamed company", domain: o.properties.domain || undefined,
    industry: o.properties.industry || undefined, employees: o.properties.numberofemployees ? Number(o.properties.numberofemployees) : undefined,
    country: o.properties.country || undefined, updatedAt: new Date(o.properties.hs_lastmodifieddate ?? o.updatedAt ?? Date.now()),
});
const clean = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));

async function hsTokenCall(form: Record<string, string>) {
    const r = await request<{ access_token?: string; refresh_token?: string; expires_in?: number; status?: string; message?: string }>(`${HS}/oauth/v1/token`, {
        method: "POST", form: { ...form, client_id: env.HUBSPOT_CLIENT_ID, client_secret: env.HUBSPOT_CLIENT_SECRET },
    });
    if (r.status === 400 && form.grant_type === "refresh_token") throw new ReconnectRequiredError("HubSpot");
    if (!ok(r.status) || !r.data.access_token) fail("HubSpot", "token exchange", r.status, r.data);
    return r.data as { access_token: string; refresh_token?: string; expires_in: number };
}

async function hsSearch(token: string, object: "contacts" | "companies", modifiedProp: string, props: string[], sinceMs: number, after?: string) {
    const r = await request<{ results: HsObject[]; paging?: { next?: { after: string } } }>(`${HS}/crm/v3/objects/${object}/search`, {
        method: "POST", token,
        body: { filterGroups: [{ filters: [{ propertyName: modifiedProp, operator: "GTE", value: String(sinceMs) }] }], sorts: [{ propertyName: modifiedProp, direction: "ASCENDING" }], properties: props, limit: 100, ...(after ? { after } : {}) },
    });
    if (r.status === 401) throw new ReconnectRequiredError("HubSpot");
    if (!ok(r.status)) fail("HubSpot", `${object} search`, r.status, r.data);
    return r.data;
}

async function hsFindBy(token: string, object: "contacts" | "companies" | "deals", prop: string, value: string) {
    const r = await request<{ results: HsObject[] }>(`${HS}/crm/v3/objects/${object}/search`, {
        method: "POST", token, body: { filterGroups: [{ filters: [{ propertyName: prop, operator: "EQ", value }] }], properties: [prop], limit: 1 },
    });
    if (!ok(r.status)) fail("HubSpot", `${object} lookup`, r.status, r.data);
    return r.data.results[0]?.id ?? null;
}

async function hsGet(token: string, object: "contacts" | "companies", id: string, props: string[]) {
    const r = await request<HsObject>(`${HS}/crm/v3/objects/${object}/${encodeURIComponent(id)}?properties=${props.join(",")}`, { token });
    if (r.status === 404) return null;
    if (r.status === 401) throw new ReconnectRequiredError("HubSpot");
    if (!ok(r.status)) fail("HubSpot", `${object} read`, r.status, r.data);
    return r.data;
}

// create-or-update; a create that HubSpot rejects as a duplicate adopts the existing record instead
async function hsWrite(token: string, object: "contacts" | "companies" | "deals", existingId: string | null, properties: Record<string, string>, associations: { id: string; typeId: number }[] = []) {
    if (existingId) {
        const r = await request<HsObject>(`${HS}/crm/v3/objects/${object}/${encodeURIComponent(existingId)}`, { method: "PATCH", token, body: { properties } });
        if (r.status === 404) return hsWrite(token, object, null, properties, associations);
        if (!ok(r.status)) fail("HubSpot", `${object} update`, r.status, r.data);
        return existingId;
    }
    const r = await request<HsObject & { message?: string }>(`${HS}/crm/v3/objects/${object}`, {
        method: "POST", token,
        body: { properties, associations: associations.map((a) => ({ to: { id: a.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.typeId }] })) },
    });
    if (r.status === 409) {
        const existing = /Existing ID:\s*(\d+)/.exec(r.data.message ?? "")?.[1];
        if (existing) return existing;
    }
    if (!ok(r.status)) fail("HubSpot", `${object} create`, r.status, r.data);
    return r.data.id;
}

export const hubspot: CrmAdapter = {
    provider: "hubspot",
    scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.companies.read", "crm.objects.companies.write", "crm.objects.deals.read", "crm.objects.deals.write"],
    pkce: false,
    authorizeUrl: (state, redirectUri) => `https://app.hubspot.com/oauth/authorize?${new URLSearchParams({ client_id: env.HUBSPOT_CLIENT_ID, redirect_uri: redirectUri, scope: hubspot.scopes.join(" "), state })}`,
    async exchangeCode(code, redirectUri) {
        const t = await hsTokenCall({ grant_type: "authorization_code", redirect_uri: redirectUri, code });
        const info = await request<{ hub_id?: number; hub_domain?: string; scopes?: string[] }>(`${HS}/oauth/v1/access-tokens/${encodeURIComponent(t.access_token)}`);
        if (!ok(info.status) || !info.data.hub_id) fail("HubSpot", "account lookup", info.status, info.data);
        return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, accountId: String(info.data.hub_id), accountLabel: info.data.hub_domain, scopes: info.data.scopes };
    },
    async refresh(refreshToken) {
        const t = await hsTokenCall({ grant_type: "refresh_token", refresh_token: refreshToken });
        return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in };
    },
    async revoke(refreshToken) {
        await request(`${HS}/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, { method: "DELETE" });
    },
    async testConnection(token) {
        const r = await request(`${HS}/crm/v3/objects/contacts?limit=1`, { token });
        if (r.status === 401) throw new ReconnectRequiredError("HubSpot");
        if (!ok(r.status)) fail("HubSpot", "connection test", r.status, r.data);
    },
    async searchContacts(token, sinceMs, after) {
        const d = await hsSearch(token, "contacts", "lastmodifieddate", CONTACT_PROPS, sinceMs, after);
        return { items: d.results.map(contactOf), next: d.paging?.next?.after };
    },
    async searchCompanies(token, sinceMs, after) {
        const d = await hsSearch(token, "companies", "hs_lastmodifieddate", COMPANY_PROPS, sinceMs, after);
        return { items: d.results.map(companyOf), next: d.paging?.next?.after };
    },
    getContact: async (token, id) => { const o = await hsGet(token, "contacts", id, CONTACT_PROPS); return o && contactOf(o); },
    getCompany: async (token, id) => { const o = await hsGet(token, "companies", id, COMPANY_PROPS); return o && companyOf(o); },
    findContactByEmail: (token, email) => hsFindBy(token, "contacts", "email", email.toLowerCase()),
    findCompanyByDomain: (token, domain) => hsFindBy(token, "companies", "domain", domain.toLowerCase()),
    findDealByName: (token, name) => hsFindBy(token, "deals", "dealname", name),
    upsertCompany: (token, id, c) => hsWrite(token, "companies", id, clean({ name: c.name, domain: c.domain, industry: c.industry, numberofemployees: c.employees, country: c.country })),
    upsertContact: (token, id, c) => hsWrite(token, "contacts", id, clean({ email: c.email, firstname: c.firstName, lastname: c.lastName, jobtitle: c.title, phone: c.phone }),
        c.companyExternalId ? [{ id: c.companyExternalId, typeId: ASSOC.contactToCompany }] : []),
    upsertDeal: (token, id, d, onlyStageAndAmount) => hsWrite(token, "deals", id,
        clean(onlyStageAndAmount ? { dealstage: d.stage, amount: d.amountMinor !== undefined ? (d.amountMinor / 100).toFixed(2) : undefined } : { dealname: d.name, pipeline: "default", dealstage: d.stage, amount: d.amountMinor !== undefined ? (d.amountMinor / 100).toFixed(2) : undefined }),
        [...(d.contactExternalId ? [{ id: d.contactExternalId, typeId: ASSOC.dealToContact }] : []), ...(d.companyExternalId ? [{ id: d.companyExternalId, typeId: ASSOC.dealToCompany }] : [])]),
    stageOut: (s) => STAGE_OUT[s] ?? null,
    stageIn: (s) => STAGE_IN[s] ?? null,
};

/* =========================== Google Calendar =========================== */

const GCAL = "https://www.googleapis.com/calendar/v3";

async function googleToken(form: Record<string, string>) {
    const r = await request<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>("https://oauth2.googleapis.com/token", {
        method: "POST", form: { ...form, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET },
    });
    if (r.data.error === "invalid_grant") throw new ReconnectRequiredError("Google Calendar");
    if (!ok(r.status) || !r.data.access_token) fail("Google", "token exchange", r.status, r.data);
    return r.data as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

function gcalCheck(what: string, status: number, data: unknown) {
    if (status === 401) throw new ReconnectRequiredError("Google Calendar");
    if (!ok(status)) fail("Google Calendar", what, status, data);
}

const gTime = (d: Date, timeZone: string) => ({ dateTime: d.toISOString(), timeZone });

export const googleCalendar: CalendarAdapter = {
    provider: "google_calendar",
    // least privilege: events on the user's calendars, free/busy, and the account email to bind the connection
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"],
    pkce: true,
    authorizeUrl: (state, redirectUri, codeChallenge) => `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: googleCalendar.scopes.join(" "),
        access_type: "offline", prompt: "consent", state, code_challenge: codeChallenge ?? "", code_challenge_method: "S256",
    })}`,
    async exchangeCode(code, redirectUri, codeVerifier) {
        const t = await googleToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier ?? "" });
        const me = await request<{ email?: string; sub?: string }>("https://openidconnect.googleapis.com/v1/userinfo", { token: t.access_token });
        if (!ok(me.status) || !me.data.email) fail("Google", "account lookup", me.status, me.data);
        return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in, accountId: me.data.email!.toLowerCase(), accountLabel: me.data.email, scopes: t.scope?.split(" ") };
    },
    async refresh(refreshToken) {
        const t = await googleToken({ grant_type: "refresh_token", refresh_token: refreshToken });
        return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresIn: t.expires_in };
    },
    async revoke(token) {
        await request("https://oauth2.googleapis.com/revoke", { method: "POST", form: { token } });
    },
    async testConnection(token) {
        const r = await request(`${GCAL}/calendars/primary/events?maxResults=1`, { token });
        gcalCheck("connection test", r.status, r.data);
    },
    async freeBusy(token, from, to, timezone) {
        const r = await request<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(`${GCAL}/freeBusy`, {
            method: "POST", token, body: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: timezone, items: [{ id: "primary" }] },
        });
        gcalCheck("free/busy", r.status, r.data);
        const cal = r.data.calendars?.primary;
        if (cal?.errors?.length) throw new ProviderError("Google Calendar free/busy returned an error for the primary calendar");
        return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    },
    async createEvent(token, e) {
        const r = await request<{ id: string; hangoutLink?: string; htmlLink?: string }>(`${GCAL}/calendars/primary/events?sendUpdates=${e.sendInvites ? "all" : "none"}&conferenceDataVersion=1`, {
            method: "POST", token,
            body: {
                id: e.id, summary: e.summary, description: e.description, start: gTime(e.start, e.timezone), end: gTime(e.end, e.timezone),
                attendees: e.attendees.map((email) => ({ email })),
                conferenceData: { createRequest: { requestId: e.id, conferenceSolutionKey: { type: "hangoutsMeet" } } },
            },
        });
        // the same id already exists: an earlier attempt succeeded (uncertain response); adopt it
        if (r.status === 409) return { id: e.id, created: false };
        gcalCheck("event create", r.status, r.data);
        return { id: r.data.id, link: r.data.hangoutLink, created: true };
    },
    async updateEvent(token, id, e) {
        const r = await request(`${GCAL}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${e.sendInvites ? "all" : "none"}`, {
            method: "PATCH", token, body: { start: gTime(e.start, e.timezone), end: gTime(e.end, e.timezone) },
        });
        gcalCheck("event update", r.status, r.data);
    },
    async deleteEvent(token, id, sendInvites) {
        const r = await request(`${GCAL}/calendars/primary/events/${encodeURIComponent(id)}?sendUpdates=${sendInvites ? "all" : "none"}`, { method: "DELETE", token });
        if (r.status === 404 || r.status === 410) return;
        gcalCheck("event delete", r.status, r.data);
    },
    async getEvent(token, id) {
        const r = await request<{ status: "confirmed" | "tentative" | "cancelled"; start?: { dateTime?: string }; end?: { dateTime?: string } }>(`${GCAL}/calendars/primary/events/${encodeURIComponent(id)}`, { token });
        if (r.status === 404 || r.status === 410) return null;
        gcalCheck("event read", r.status, r.data);
        return { status: r.data.status, start: new Date(r.data.start?.dateTime ?? 0), end: new Date(r.data.end?.dateTime ?? 0) };
    },
};

export const ADAPTERS = { hubspot, google_calendar: googleCalendar } as const;
