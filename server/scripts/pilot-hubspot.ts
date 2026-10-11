/*
    End-to-end pilot of the HubSpot integration against a REAL HubSpot test portal.

    It refuses to run on anything but a developer test account or sandbox, uses its own throwaway
    database, tags every record it creates, proves that nothing it did not create was changed, and
    deletes its own records at the end (also on failure).

    1. In a HubSpot developer test account (or sandbox): Settings → Integrations → Private apps →
       create one with scopes crm.objects.contacts/companies/deals read+write.
    2. Put its token in server/.env as HUBSPOT_PILOT_TOKEN=... (never commit it).
    3. npm run pilot:hubspot

    PILOT_SIMULATE=1 npm run pilot:hubspot runs the same script against the in-memory simulator.
*/
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import env from "../src/shared/config/env.config.js";
import { request, setIntegrationHttp } from "../src/shared/integrations/core.js";
import { pullSync, pushLead } from "../src/shared/integrations/sync.service.js";
import { IntegrationConnection, ExternalRecord } from "../src/shared/models/integration.model.js";
import Lead, { leadDedupeKey } from "../src/shared/models/lead.model.js";
import Organization from "../src/shared/models/organization.model.js";
import { encryptSecret } from "../src/shared/utils/crypto.util.js";

const HS = "https://api.hubapi.com";
const run = randomBytes(3).toString("hex");
const tag = (s: string) => `pilot-${run}-${s}`;
const results: { check: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ check: name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };

let token = process.env.HUBSPOT_PILOT_TOKEN ?? "";
if (process.env.PILOT_SIMULATE === "1") {
    const { createSims } = await import("../src/__tests__/providerSims.js");
    const sims = createSims();
    setIntegrationHttp(sims.http);
    token = sims.hs.access;
    // a pre-existing customer record the pilot must never touch
    sims.put("contacts", { email: "real-customer@example.com", firstname: "Existing", jobtitle: "CEO" });
}
if (!token) {
    console.error("Set HUBSPOT_PILOT_TOKEN in server/.env (a private app token from a HubSpot developer test account or sandbox).");
    process.exit(2);
}

type Obj = { id: string; properties: Record<string, string | null> };
const hs = async <T>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await request<T>(`${HS}${path}`, { ...init, token });
    if (r.status >= 400 && r.status !== 404) throw new Error(`HubSpot ${init.method ?? "GET"} ${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    return r;
};

// 0. safety: only a test portal
const account = await hs<{ portalId: number; accountType: string }>("/account-info/v3/details");
if (!["DEVELOPER_TEST", "SANDBOX", "STANDARD_SANDBOX", "DEVELOPMENT_SANDBOX"].includes(account.data.accountType)) {
    console.error(`Refusing to run: portal ${account.data.portalId} is a ${account.data.accountType} account. Use a developer test account or sandbox.`);
    process.exit(2);
}
console.log(`Pilot ${run} on test portal ${account.data.portalId} (${account.data.accountType})`);

// snapshot of every record that exists before we start: these must come out byte-for-byte unchanged
async function snapshot() {
    const out = new Map<string, string>();
    for (const object of ["contacts", "companies", "deals"]) {
        let after: string | undefined;
        for (let page = 0; page < 20; page++) {
            const r = await hs<{ results: Obj[]; paging?: { next?: { after: string } } }>(`/crm/v3/objects/${object}?limit=100&properties=email,firstname,lastname,jobtitle,phone,name,domain,industry,dealname,dealstage,amount${after ? `&after=${after}` : ""}`);
            for (const o of r.data.results ?? []) out.set(`${object}:${o.id}`, JSON.stringify(o.properties, Object.keys(o.properties).filter((k) => !/lastmodified|createdate/i.test(k)).sort()));
            after = r.data.paging?.next?.after;
            if (!after) break;
        }
    }
    return out;
}

const created: { object: string; id: string }[] = [];
const dbUri = (() => { const u = new URL(env.MONGO_URI); u.pathname = `/easysales_pilot_${run}`; return u.toString(); })();

try {
    const before = await snapshot();
    await mongoose.connect(dbUri);
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
    const org = await Organization.create({ name: `Pilot ${run}`, slug: tag("org"), activatedAt: new Date() });
    await IntegrationConnection.create({
        organizationId: org._id, provider: "hubspot", status: "connected", externalAccountId: String(account.data.portalId), accountLabel: "pilot",
        accessTokenEnc: encryptSecret(token), accessTokenExpiresAt: new Date(Date.now() + 365 * 86400_000),
    });

    // 1. records that exist in the CRM first
    const company = (await hs<Obj>("/crm/v3/objects/companies", { method: "POST", body: { properties: { name: `Pilot Clinic ${run}`, domain: `${tag("clinic")}.example.com`, industry: "HOSPITAL_HEALTH_CARE" } } })).data;
    created.push({ object: "companies", id: company.id });
    for (const who of ["a", "b"]) {
        const c = (await hs<Obj>("/crm/v3/objects/contacts", { method: "POST", body: {
            properties: { email: `${tag(who)}@example.com`, firstname: `Pilot ${who.toUpperCase()}`, jobtitle: "Manager" },
            associations: [{ to: { id: company.id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 279 }] }],
        } })).data;
        created.push({ object: "contacts", id: c.id });
    }

    // 2. import twice: same result, no duplicates, consent never assumed
    // ponytail: HubSpot search is eventually consistent; give fresh records a moment to become searchable
    if (process.env.PILOT_SIMULATE !== "1") await new Promise((r) => setTimeout(r, 8000));
    await pullSync(org._id);
    await pullSync(org._id);
    const imported = await Lead.find({ organizationId: org._id, "contact.email": { $regex: `^pilot-${run}-` } }).setOptions({ crossTenant: true }).lean();
    check("CRM contacts imported once each", imported.length === 2, `${imported.length} leads`);
    check("imported contacts are not emailable until consent is recorded", imported.every((l) => l.consent?.basis === "none"));
    check("company fields applied from the CRM", imported.every((l) => l.company.name === `Pilot Clinic ${run}`));
    const pilotIds = imported.map((l) => l._id);
    const mappings = await ExternalRecord.find({ organizationId: org._id, entityType: "contact" }).setOptions({ crossTenant: true }).lean();
    check("one mapping per external record", mappings.filter((m) => pilotIds.some((id) => String(id) === String(m.internalRecordId))).length === 2
        && new Set(mappings.map((m) => m.externalRecordId)).size === mappings.length, `${mappings.length} contact mappings`);

    // 3. push a lead that only exists here, twice: exactly one company, contact and deal in the CRM
    const doc = { company: { name: `Pilot Push ${run}`, domain: `${tag("push")}.example.com` }, contact: { name: "Pilot Pushed", email: `${tag("c")}@example.com` } };
    const lead = await Lead.create({ organizationId: org._id, ...doc, dedupeKey: leadDedupeKey(doc), status: "qualified", opportunityStage: "qualified", consent: { basis: "legitimate_interest" } });
    await pushLead(org._id, lead._id);
    await pushLead(org._id, lead._id);
    if (process.env.PILOT_SIMULATE !== "1") await new Promise((r) => setTimeout(r, 8000));
    const find = async (object: string, prop: string, value: string) => (await hs<{ results: Obj[] }>(`/crm/v3/objects/${object}/search`, { method: "POST", body: { filterGroups: [{ filters: [{ propertyName: prop, operator: "EQ", value }] }], limit: 10 } })).data.results;
    const pushedContacts = await find("contacts", "email", `${tag("c")}@example.com`);
    const pushedCompanies = await find("companies", "domain", `${tag("push")}.example.com`);
    const pushedDeals = await find("deals", "dealname", `Pilot Push ${run} · easySales ${String(lead._id).slice(-6)}`);
    created.push(...pushedContacts.map((o) => ({ object: "contacts", id: o.id })), ...pushedCompanies.map((o) => ({ object: "companies", id: o.id })), ...pushedDeals.map((o) => ({ object: "deals", id: o.id })));
    check("pushed lead → exactly one contact", pushedContacts.length === 1, `${pushedContacts.length}`);
    check("pushed lead → exactly one company", pushedCompanies.length === 1, `${pushedCompanies.length}`);
    check("pushed lead → exactly one deal", pushedDeals.length === 1, `${pushedDeals.length}`);

    // 4. a change made in the CRM arrives; platform-owned data is untouched
    const a = created.find((c) => c.object === "contacts")!;
    await Lead.updateOne({ organizationId: org._id, "contact.email": `${tag("a")}@example.com` }, { "research.summary": "platform-owned" }).setOptions({ crossTenant: true });
    await hs(`/crm/v3/objects/contacts/${a.id}`, { method: "PATCH", body: { properties: { jobtitle: "Director" } } });
    if (process.env.PILOT_SIMULATE !== "1") await new Promise((r) => setTimeout(r, 8000));
    await pullSync(org._id);
    const la = await Lead.findOne({ organizationId: org._id, "contact.email": `${tag("a")}@example.com` }).setOptions({ crossTenant: true }).lean();
    check("CRM-owned change applied", la?.contact?.title === "Director", la?.contact?.title ?? "missing");
    check("platform-owned data kept", la?.research?.summary === "platform-owned");

    // 5. nothing that existed before the pilot was changed or removed
    const after = await snapshot();
    const changed = [...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k);
    check("no pre-existing CRM record was changed or deleted", changed.length === 0, changed.length ? changed.slice(0, 5).join(", ") : `${before.size} records verified`);
} catch (error) {
    check("pilot ran to completion", false, (error as Error).message);
} finally {
    // clean up: our own CRM records, then the throwaway database
    for (const c of created) await hs(`/crm/v3/objects/${c.object}/${c.id}`, { method: "DELETE" }).catch((e) => console.error(`cleanup ${c.object}/${c.id}: ${(e as Error).message}`));
    if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${failed ? "PILOT FAILED" : "PILOT PASSED"}: ${results.length - failed}/${results.length} checks · ${created.length} pilot records cleaned up · run ${run}`);
    process.exit(failed ? 1 : 0);
}
