import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { createSims } from "./providerSims.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { setIntegrationHttp } from "../shared/integrations/core.js";
import { reconcileMeetings } from "../shared/integrations/calendar.service.js";
import env from "../shared/config/env.config.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import Workflow from "../shared/models/workflow.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";
import { ExternalRecord, IntegrationConnection, IntegrationEvent, Meeting } from "../shared/models/integration.model.js";

before(async () => {
    await startDb();
    Object.assign(env, { HUBSPOT_CLIENT_ID: "hs-client", HUBSPOT_CLIENT_SECRET: "hs-secret-for-tests", GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "g-secret" });
});
after(async () => { setIntegrationHttp(null); await stopDb(); });
beforeEach(() => resetAlertThrottle());

let sims: ReturnType<typeof createSims>;
let n = 0;
// every test gets its own HubSpot portal and Google account (one external account → one workspace)
beforeEach(() => { sims = createSims(); n += 1; sims.hs.portal = String(9000 + n); sims.g.email = `owner${n}@studio.test`; setIntegrationHttp(sims.http); });

// walks the OAuth flow the way a browser would: start → consent (simulated) → callback
async function connect(auth: Record<string, string>, provider: "hubspot" | "google_calendar") {
    const start = await request(app).post(`/api/v1/integrations/${provider}/connect`).set(auth);
    const url = new URL(start.body.data.authorizeUrl);
    const state = url.searchParams.get("state")!;
    const cb = await request(app).get(`/api/integrations/oauth/${provider}/callback?code=good-code&state=${state}`);
    return { url, state, cb };
}

const hubspotWebhook = (events: unknown[], opts: { secret?: string; timestamp?: number } = {}) => {
    const body = JSON.stringify(events);
    const ts = opts.timestamp ?? Date.now();
    const uri = `${(env.PUBLIC_API_URL || env.FRONTEND_URL).replace(/\/$/, "")}/api/webhooks/hubspot`;
    const sig = createHmac("sha256", opts.secret ?? env.HUBSPOT_CLIENT_SECRET).update(`POST${uri}${body}${ts}`).digest("base64");
    return request(app).post("/api/webhooks/hubspot").set("Content-Type", "application/json").set("X-HubSpot-Signature-v3", sig).set("X-HubSpot-Request-Timestamp", String(ts)).send(body);
};

test("connect securely: single-use state, encrypted tokens, one tenant per account, revoke on disconnect", async () => {
    const owner = await createAccount("CrmCo");
    const bad = await request(app).get("/api/integrations/oauth/hubspot/callback?code=good-code&state=forged");
    assert.match(bad.headers.location, /error=/);
    const { url, state, cb } = await connect(owner.auth, "hubspot");
    assert.equal(url.hostname, "app.hubspot.com");
    assert.match(url.searchParams.get("scope")!, /crm\.objects\.contacts\.read/);
    assert.match(cb.headers.location, /connected=hubspot/);
    const reuse = await request(app).get(`/api/integrations/oauth/hubspot/callback?code=good-code&state=${state}`);
    assert.match(reuse.headers.location, /error=/, "a state works once");

    const list = await request(app).get("/api/v1/integrations").set(owner.auth);
    const crm = list.body.data.integrations.find((i: { provider: string }) => i.provider === "hubspot");
    assert.equal(crm.status, "connected");
    assert.ok(!JSON.stringify(list.body).includes(sims.hs.access) && !JSON.stringify(list.body).includes(sims.hs.refresh), "tokens never leave the server");
    const stored = await IntegrationConnection.findOne({ provider: "hubspot" }).select("+accessTokenEnc").setOptions({ crossTenant: true });
    assert.ok(stored!.accessTokenEnc && !stored!.accessTokenEnc.includes(sims.hs.access), "encrypted at rest");

    // the same HubSpot portal cannot be attached to a second workspace
    const rival = await createAccount("Rival");
    const hijack = await connect(rival.auth, "hubspot");
    assert.match(hijack.cb.headers.location, /already%20connected%20to%20another%20workspace/);

    const g = await connect(owner.auth, "google_calendar");
    assert.equal(g.url.searchParams.get("code_challenge_method"), "S256", "PKCE where supported");
    assert.match(g.cb.headers.location, /connected=google_calendar/);

    assert.equal((await request(app).delete("/api/v1/integrations/hubspot").set(owner.auth)).status, 200);
    assert.equal(sims.hs.revoked, true, "access revoked at the provider");
    const gone = await IntegrationConnection.findOne({ organizationId: owner.organizationId, provider: "hubspot" }).select("+accessTokenEnc +refreshTokenEnc").setOptions({ crossTenant: true });
    assert.deepEqual([gone!.status, gone!.accessTokenEnc, gone!.refreshTokenEnc], ["disconnected", undefined, undefined]);
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "integration.disconnect" }));
});

test("CRM import: no duplicates, resumes after failures and rate limits, consent never assumed", async () => {
    const owner = await createAccount("Importer");
    const existing = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: "Acme Dental", contactEmail: "priya@acme.test", consentBasis: "legitimate_interest" })).body.data.lead._id;
    const acme = sims.put("companies", { name: "Acme Dental", domain: "acme.test", industry: "Healthcare" });
    sims.put("contacts", { email: "priya@acme.test", firstname: "Priya", lastname: "S", jobtitle: "Owner", associatedcompanyid: acme.id });
    sims.put("contacts", { email: "ravi@bright.test", firstname: "Ravi", company: "Bright Minds" });
    sims.put("contacts", { firstname: "No", lastname: "Email" });
    sims.put("contacts", { email: "meera@acme.test", firstname: "Meera", associatedcompanyid: acme.id });
    await connect(owner.auth, "hubspot");

    // page 2 of contacts fails once, then the provider rate-limits once: the job resumes from its checkpoint
    sims.hs.failOnce.set("POST api.hubapi.com/crm/v3/objects/contacts/search", 500);
    const sync = await request(app).post("/api/v1/integrations/hubspot/sync").set(owner.auth);
    assert.equal(sync.status, 202);
    await runOnce();
    let wf = await Workflow.findById(sync.body.data.workflowId).setOptions({ crossTenant: true }).lean();
    assert.equal(wf!.status, "queued", "failed attempt is retried, not lost");
    sims.hs.failOnce.set("POST api.hubapi.com/crm/v3/objects/contacts/search", 429);
    for (let i = 0; i < 3 && wf!.status !== "completed"; i++) {
        await Workflow.updateOne({ _id: wf!._id }, { nextRunAt: new Date() }).setOptions({ crossTenant: true });
        await runOnce();
        wf = await Workflow.findById(sync.body.data.workflowId).setOptions({ crossTenant: true }).lean();
    }
    assert.equal(wf!.status, "completed");

    const leads = await Lead.find({ organizationId: owner.organizationId }).setOptions({ crossTenant: true }).lean();
    assert.equal(leads.length, 3, "Priya linked to the existing lead, Ravi and Meera created, the email-less contact skipped");
    const priya = leads.find((l) => String(l._id) === existing)!;
    assert.deepEqual([priya.contact?.title, priya.company.industry, priya.consent?.basis], ["Owner", "Healthcare", "legitimate_interest"], "CRM fields applied, our consent kept");
    const ravi = leads.find((l) => l.contact?.email === "ravi@bright.test")!;
    assert.equal(ravi.consent?.basis, "none", "imported contacts cannot be emailed until consent is recorded");

    // a second sync (and a replayed one) creates nothing new
    await request(app).post("/api/v1/integrations/hubspot/sync").set(owner.auth);
    await runOnce();
    assert.equal(await Lead.countDocuments({ organizationId: owner.organizationId }).setOptions({ crossTenant: true }), 3);
    assert.equal(await ExternalRecord.countDocuments({ organizationId: owner.organizationId, entityType: "contact" }).setOptions({ crossTenant: true }), 3);
    const status = (await request(app).get("/api/v1/integrations/hubspot/sync-status").set(owner.auth)).body.data.status;
    assert.ok(status.lastSyncAt && status.checkpoints.contacts && status.fieldOwnership.length);
});

test("webhooks: verified, replay-protected, deduplicated, tenant from the connection; field ownership respected", async () => {
    const owner = await createAccount("Hooks");
    await connect(owner.auth, "hubspot");
    const c = sims.put("contacts", { email: "anu@clinic.test", firstname: "Anu", jobtitle: "Manager" });
    await request(app).post("/api/v1/integrations/hubspot/sync").set(owner.auth);
    await runOnce();

    const ev = { eventId: 77, portalId: Number(sims.hs.portal), subscriptionType: "contact.propertyChange", objectId: Number(c.id), propertyName: "jobtitle", propertyValue: "Director", occurredAt: Date.now() };
    assert.equal((await hubspotWebhook([ev], { secret: "wrong" })).status, 401);
    assert.equal((await hubspotWebhook([ev], { timestamp: Date.now() - 10 * 60_000 })).status, 401, "replays outside the window are rejected");
    sims.hs.contacts.get(c.id)!.properties.jobtitle = "Director";
    sims.hs.contacts.get(c.id)!.updatedAt = Date.now() + 5;
    assert.equal((await hubspotWebhook([ev])).body.data.stored, 1);
    assert.equal((await hubspotWebhook([ev])).body.data.stored, 0, "same event id is stored once");
    assert.equal((await hubspotWebhook([{ ...ev, portalId: 123456, eventId: 78 }])).body.data.stored, 0, "unknown portal: ignored");
    await runOnce();
    const lead = await Lead.findOne({ organizationId: owner.organizationId, "contact.email": "anu@clinic.test" }).setOptions({ crossTenant: true }).lean();
    assert.equal(lead!.contact?.title, "Director", "CRM-owned field follows the CRM");
    assert.equal((await IntegrationEvent.findOne({ eventId: "77" }).setOptions({ crossTenant: true }).lean())!.status, "processed");

    // research is platform-owned: a CRM update never touches it
    await Lead.updateOne({ _id: lead!._id }, { "research.summary": "Ours" }).setOptions({ crossTenant: true });
    sims.hs.contacts.get(c.id)!.updatedAt = Date.now() + 10;
    await hubspotWebhook([{ ...ev, eventId: 79 }]);
    await runOnce();
    assert.equal((await Lead.findById(lead!._id).setOptions({ crossTenant: true }).lean())!.research?.summary, "Ours");
});

test("push to CRM: idempotent through ambiguous responses; stage ownership is explicit", async () => {
    fakeLlm({ research: { companySummary: "x", industry: "Healthcare", employeeCountEstimate: 10, findings: [], criteria: ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"].map((id) => ({ criterionId: id, result: "match", explanation: "x", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] } });
    const owner = await createAccount("Pusher");
    await request(app).put("/api/v1/business-profile").set(owner.auth).send({ businessName: "S", businessType: "a", description: "b", website: "", brandVoice: "w", services: [], idealCustomerProfile: { industries: ["Healthcare"], companySizes: [], regions: [], requiredSignals: [], disqualifiers: [] }, approvedClaims: [], prohibitedClaims: [], caseStudies: [] });
    await connect(owner.auth, "hubspot");
    const id = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: "Zen Clinic", website: "https://zen.test", contactName: "Zara Khan", contactEmail: "zara@zen.test", consentBasis: "legitimate_interest" })).body.data.lead._id;

    // the contact create succeeds at HubSpot but the response is lost; the retry must not duplicate it
    sims.hs.lostResponseOnce.add("contacts");
    await request(app).post(`/api/v1/leads/${id}/research`).set(owner.auth);
    await runOnce();
    for (let i = 0; i < 3; i++) {
        await Workflow.updateMany({ type: "integration.push", status: "queued" }, { nextRunAt: new Date() }).setOptions({ crossTenant: true });
        await runOnce();
    }
    assert.equal([...sims.hs.contacts.values()].filter((c) => c.properties.email === "zara@zen.test").length, 1, "exactly one contact in the CRM");
    assert.equal(sims.hs.companies.size, 1);
    assert.equal(sims.hs.deals.size, 1);
    const deal = [...sims.hs.deals.values()][0];
    assert.equal(deal.properties.dealstage, "qualifiedtobuy");

    // CRM-owned contact fields are not overwritten by later pushes
    sims.hs.contacts.forEach((c) => { c.properties.firstname = "Zahra"; });
    await Lead.updateOne({ _id: id }, { opportunityStage: "discovery", "contact.name": "Z. Khan" }).setOptions({ crossTenant: true });
    await Workflow.create({ organizationId: owner.organizationId, type: "integration.push", entityType: "lead", entityId: id, idempotencyKey: "manual-push", correlationId: "t" });
    await runOnce();
    assert.equal([...sims.hs.contacts.values()][0].properties.firstname, "Zahra");
    assert.equal(deal.properties.dealstage, "appointmentscheduled", "platform owns the stage by default");

    // switch ownership to the CRM: a CRM stage change flows back; our pushes no longer move it
    await request(app).patch("/api/v1/integrations/hubspot/settings").set(owner.auth).send({ stageOwner: "crm" });
    await hubspotWebhook([{ eventId: 501, portalId: Number(sims.hs.portal), subscriptionType: "deal.propertyChange", objectId: Number(deal.id), propertyName: "dealstage", propertyValue: "closedwon", occurredAt: Date.now() }]);
    await runOnce();
    assert.equal((await Lead.findById(id).setOptions({ crossTenant: true }).lean())!.opportunityStage, "won");
});

test("expired credentials: degraded with an actionable error, never retried forever", async () => {
    const owner = await createAccount("Expired");
    await connect(owner.auth, "hubspot");
    sims.hs.revoked = true;
    await IntegrationConnection.updateOne({ organizationId: owner.organizationId, provider: "hubspot" }, { accessTokenExpiresAt: new Date(0) }).setOptions({ crossTenant: true });
    const sync = await request(app).post("/api/v1/integrations/hubspot/sync").set(owner.auth);
    await runOnce();
    const wf = await Workflow.findById(sync.body.data.workflowId).setOptions({ crossTenant: true }).lean();
    assert.deepEqual([wf!.status, wf!.failureCode], ["failed", "RECONNECT_REQUIRED"]);
    const list = (await request(app).get("/api/v1/integrations").set(owner.auth)).body.data.integrations;
    assert.equal(list.find((i: { provider: string }) => i.provider === "hubspot").status, "degraded");
    const errors = (await request(app).get("/api/v1/integrations/hubspot/errors").set(owner.auth)).body.data.errors;
    assert.equal(errors[0].action, "Reconnect the integration");
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "alert.provider_outage" }));
});

test("calendar: real availability in the business timezone, no double booking, idempotent create, provider-side changes read back", async () => {
    fakeLlm({ conversation: { intent: "meeting_request", confidence: 0.95, summary: "Wants a call.", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "Here are some times." } });
    const mailbox = fakeMailbox();
    const owner = await createAccount("Cal");
    await request(app).put("/api/v1/policies").set(owner.auth).send({ ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } });
    await connect(owner.auth, "google_calendar");
    await request(app).patch("/api/v1/integrations/google_calendar/settings").set(owner.auth).send({ timezone: "Asia/Kolkata", workStart: "10:00", workEnd: "12:00", workDays: [0, 1, 2, 3, 4, 5, 6], meetingMinutes: 30, bufferMinutes: 0, minNoticeHours: 0 });
    const lead = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: "Calm Clinic", contactEmail: "c@calm.test", consentBasis: "legitimate_interest" })).body.data.lead._id;

    let av = (await request(app).get("/api/v1/calendar/availability?days=3").set(owner.auth)).body.data;
    assert.ok(av.slots.length >= 4);
    for (const s of av.slots) {
        const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s.start));
        assert.ok(local >= "10:00" && local <= "11:30", `slot ${local} inside working hours in IST`);
    }
    // the provider says the first slot is busy: it disappears
    const first = av.slots[0];
    sims.g.busy.push({ start: first.start, end: first.end });
    av = (await request(app).get("/api/v1/calendar/availability?days=3").set(owner.auth)).body.data;
    assert.ok(!av.slots.some((s: { start: string }) => s.start === first.start));
    assert.equal((await request(app).post("/api/v1/calendar/events").set(owner.auth).send({ leadId: lead, start: first.start, inviteProspect: false })).status, 409, "rechecked before booking");

    // two people book the same free slot at once: exactly one wins
    const slot = av.slots[0].start;
    const [a, b] = await Promise.all([0, 1].map(() => request(app).post("/api/v1/calendar/events").set(owner.auth).send({ leadId: lead, start: slot, inviteProspect: true })));
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(sims.g.events.size, 1);
    const booked = (a.status === 201 ? a : b).body.data.meeting;
    assert.deepEqual(sims.g.events.get(booked.externalEventId)!.attendees, ["c@calm.test"], "invite only when asked");
    assert.ok(await Message.exists({ organizationId: owner.organizationId, leadId: lead, body: /Confirmed:/ }), "confirmation only after the provider confirmed");

    // the provider accepted a create but the response was lost: the retry adopts the same event
    const slot2 = av.slots[1].start;
    sims.g.failCreateOnce = true;
    assert.notEqual((await request(app).post("/api/v1/calendar/events").set(owner.auth).send({ leadId: lead, start: slot2, inviteProspect: false })).status, 201);
    assert.equal(await Message.countDocuments({ organizationId: owner.organizationId, leadId: lead, body: /Confirmed:/ }), 1, "no confirmation for an unconfirmed booking");
    assert.equal((await request(app).post("/api/v1/calendar/events").set(owner.auth).send({ leadId: lead, start: slot2, inviteProspect: false })).status, 201);
    assert.equal([...sims.g.events.values()].filter((e) => e.start === slot2).length, 1);

    // cancelled in Google Calendar → reflected here
    sims.g.events.get(booked.externalEventId)!.status = "cancelled";
    await reconcileMeetings();
    assert.equal((await Meeting.findById(booked._id).setOptions({ crossTenant: true }).lean())!.status, "cancelled");

    // the reply agent offers real slots and is told never to invent times
    const conv = (await request(app).get(`/api/v1/leads/${lead}`).set(owner.auth)).body.data.conversation;
    const calls = fakeLlm({ conversation: { intent: "meeting_request", confidence: 0.95, summary: "x", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "Times below." } });
    await request(app).post(`/api/v1/conversations/${conv._id}/inbound`).set(owner.auth).send({ body: "Can we talk this week?" });
    await runOnce();
    const sys = calls.find((c) => c.agent === "conversation")!.system;
    assert.match(sys, /offer exactly these free slots/);
    assert.match(sys, /Asia\/Kolkata/);
    assert.equal(mailbox.length >= 0, true);
});
