import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, createAccount, fakeInbox, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { setSmtpVerifier } from "../modules/private/integrations/integrations.router.js";
import { setIntegrationHttp } from "../shared/integrations/core.js";
import { setImapClient } from "../shared/conversations/imap.service.js";
import { contactEmailFrom } from "../agents/research.agent.js";
import env from "../shared/config/env.config.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import Workflow from "../shared/models/workflow.model.js";
import UsageRecord from "../shared/models/usageRecord.model.js";
import ProviderEvent from "../shared/models/providerEvent.model.js";
import EmailIntegration from "../shared/models/emailIntegration.model.js";
import BusinessProfile from "../shared/models/businessProfile.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";

before(startDb);
after(async () => { setIntegrationHttp(null); await stopDb(); });
beforeEach(() => { resetAlertThrottle(); setSmtpVerifier(async () => undefined); fakeInbox(); });

/* ------------------------------ lead discovery ------------------------------ */

const reply = (status: number, body: unknown) => ({ status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });

// OpenStreetMap answers from memory: overlapping areas return the same clinic; Mumbai is down
function fakeOsm(calls: string[]) {
    setIntegrationHttp(async (url, init) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        calls.push(q);
        assert.match(init.headers?.["User-Agent"] ?? "", /easySales/, "Nominatim requires an identifying agent");
        if (q.endsWith("Mumbai")) return reply(503, {});
        return reply(200, [
            { name: "Tooth Care", type: "dentist", display_name: "Tooth Care, Pune", extratags: { "contact:email": "Hello@ToothCare.test" } },
            { name: "Smile Dental", type: "dentist", display_name: "Smile Dental, FC Road, Pune, India", address: { country: "India" }, extratags: { website: "https://www.smiledental.test/", phone: "+91 20 1234 5678" } },
            { name: "Smile Dental Clinic", type: "dentist", extratags: { "contact:website": "http://smiledental.test" } },
            { name: "Pearl Dental Studio", type: "dentist", extratags: { website: "https://pearldental.test" } },
            { name: "Bright Smiles", type: "dentist", extratags: { website: "https://brightsmiles.test" } },
            { display_name: "unnamed node" },
        ]);
    });
}

test("lead discovery: locked to the niche, OpenStreetMap without a web key, deduplicated, disqualifiers applied, daily cap", async () => {
    Object.assign(env, { DISCOVERY_SEARCHES_PER_DAY: 5 });
    const calls: string[] = [];
    fakeOsm(calls);
    const owner = await createAccount("Finder");
    await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: "Bright Smiles", website: "brightsmiles.test" });

    // no niche configured: the search refuses to run at all
    assert.equal((await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "dentist", where: "Pune" })).status, 400);
    await BusinessProfile.updateOne({ organizationId: owner.organizationId }, { $set: {
        "idealCustomerProfile.searchTerms": ["Dentist"], "idealCustomerProfile.searchAreas": ["Pune, India", "Pune", "Mumbai"], "idealCustomerProfile.disqualifiers": ["Pearl"],
    } }, { upsert: true });
    // outside the niche: refused in code and audited, whoever asks
    const off = await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "restaurant", where: "Pune" });
    assert.equal(off.status, 403);
    assert.match(off.body.message, /outside your niche.*Dentist/);
    assert.equal((await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "dentist", where: "Delhi" })).status, 403);
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "lead.discover", outcome: "denied" }));
    assert.equal(calls.length, 0, "nothing was searched");
    assert.deepEqual((await request(app).get("/api/v1/leads/discover/niche").set(owner.auth)).body.data.niche, { searchTerms: ["Dentist"], searchAreas: ["Pune, India", "Pune", "Mumbai"] });

    const r = await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "dentist", where: "Pune, India" });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ["Dentist in Pune, India"], "the niche's own wording is searched");
    const { candidates, disqualified } = r.body.data;
    assert.deepEqual(candidates.map((c: { name: string }) => c.name), ["Smile Dental", "Bright Smiles", "Tooth Care"], "same website kept once, unnamed dropped, websites first");
    assert.equal(disqualified, 1, "the profile's disqualifier removed Pearl Dental Studio");
    const smile = candidates[0];
    assert.deepEqual([smile.domain, smile.website, smile.phone], ["smiledental.test", "https://www.smiledental.test", "+91 20 1234 5678"]);
    assert.equal(candidates[2].email, "hello@toothcare.test");
    assert.equal(candidates[1].alreadyLead, true, "existing lead is marked");
    assert.equal(await UsageRecord.countDocuments({ organizationId: owner.organizationId, kind: "discovery", costMinor: 0 }), 1, "metered at no cost");

    // the agent searching on its own: never-searched pairs first; one failing area does not sink the rest
    const auto = await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ auto: true });
    assert.equal(auto.status, 200);
    assert.deepEqual(auto.body.data.queries, [{ what: "Dentist", where: "Pune" }, { what: "Dentist", where: "Mumbai" }, { what: "Dentist", where: "Pune, India" }]);
    assert.deepEqual(auto.body.data.failed.map((f: { where: string }) => f.where), ["Mumbai"]);
    assert.equal(auto.body.data.candidates.length, 3, "overlapping areas deduplicated");
    // when every query fails the search says so; then the daily cap stops further searches
    assert.equal((await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "dentist", where: "Mumbai" })).status, 502);
    assert.equal((await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "dentist", where: "Pune" })).status, 429);

    // chosen candidates go through the normal import (dedupe, error report) and straight into research
    const rows = candidates.filter((c: { alreadyLead: boolean }) => !c.alreadyLead).map((c: { name: string; website?: string; email?: string; phone?: string }) => ({
        companyName: c.name, website: c.website ?? "", contactEmail: c.email ?? "", contactPhone: c.phone, consentBasis: "legitimate_interest", consentSource: "Public business listing",
    }));
    const imp = await request(app).post("/api/v1/leads/import").set(owner.auth).send({ rows, source: "discovery", research: true });
    assert.equal(imp.status, 201);
    assert.equal(imp.body.data.job.createdRows, 2);
    assert.equal(await Lead.countDocuments({ organizationId: owner.organizationId, "source.provider": "discovery", status: "research_queued" }), 2);
    assert.equal(await Workflow.countDocuments({ organizationId: owner.organizationId, type: "lead.research" }), 2);

    // other tenants never see the search or its leads
    const other = await createAccount("Other");
    assert.equal(await Lead.countDocuments({ organizationId: other.organizationId }), 0);
    Object.assign(env, { DISCOVERY_SEARCHES_PER_DAY: 30 });
});

test("lead discovery: Tavily web search adds businesses not on the map; directories skipped; its failures are reported", async () => {
    Object.assign(env, { TAVILY_API_KEY: "tvly-test" });
    let tavilyDown = false;
    setIntegrationHttp(async (url, init) => {
        if (url.includes("api.tavily.com")) {
            assert.equal(init.headers?.Authorization, "Bearer tvly-test");
            const body = JSON.parse(init.body ?? "{}");
            assert.equal(body.query, "Dentist in Pune");
            assert.ok(body.exclude_domains.includes("justdial.com"), "directories excluded at the source too");
            if (tavilyDown) return reply(432, { detail: "usage limit" });
            return reply(200, { results: [
                { title: "Best Dentists in Pune - Justdial", url: "https://www.justdial.com/Pune/Dentists" },
                { title: "Smile Dental | Dentist in Pune", url: "https://smiledental.test/contact" },
                { title: "Pearl Dental Studio | Dentist in Pune", url: "https://pearldental.test/about" },
                { title: "Kids Dental Care - Pediatric dentist", url: "https://kidsdental.test/" },
            ] });
        }
        return reply(200, [{ name: "Smile Dental", type: "dentist", extratags: { website: "https://smiledental.test", phone: "+91 20 1234 5678" } }]);
    });
    const owner = await createAccount("WebFinder");
    await BusinessProfile.updateOne({ organizationId: owner.organizationId }, { $set: {
        "idealCustomerProfile.searchTerms": ["Dentist"], "idealCustomerProfile.searchAreas": ["Pune"], "idealCustomerProfile.disqualifiers": ["Pearl"],
    } }, { upsert: true });
    assert.equal((await request(app).get("/api/v1/leads/discover/niche").set(owner.auth)).body.data.webSearch, true);

    const r = await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "Dentist", where: "Pune" });
    assert.equal(r.status, 200);
    const found = r.body.data.candidates.map((c: { name: string; source: string; phone?: string }) => [c.name, c.source, c.phone ?? null]);
    assert.deepEqual(found, [["Smile Dental", "openstreetmap", "+91 20 1234 5678"], ["Kids Dental Care", "web", null]], "map entry wins the duplicate; directory and disqualified dropped");

    // Tavily out of free searches: the map results still come back, the failure is shown
    tavilyDown = true;
    const r2 = await request(app).post("/api/v1/leads/discover").set(owner.auth).send({ what: "Dentist", where: "Pune" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.data.candidates.length, 1);
    assert.match(r2.body.data.failed[0].error, /monthly free searches used up/);
    Object.assign(env, { TAVILY_API_KEY: "" });
});

test("research finds a public contact email on the prospect's own site", () => {
    const html = [
        `<img src="logo@2x.png"><a href="mailto:owner@gmail.com">Mail us</a>`,
        `<footer>Write to info@smiledental.test or see example@example.com</footer>`,
    ];
    assert.equal(contactEmailFrom(html, "www.smiledental.test"), "info@smiledental.test", "own domain first");
    assert.equal(contactEmailFrom([html[0]], "smiledental.test"), "owner@gmail.com", "else a mailto link on their site");
    assert.equal(contactEmailFrom(["<p>call us</p>", "x@sentry.io.png"], "smiledental.test"), undefined, "nothing guessed");
});

/* ------------------------------- inbox reading ------------------------------- */

const ALL = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const research = { companySummary: "Clinic.", industry: "Healthcare", employeeCountEstimate: null, findings: [], criteria: ALL.map((id) => ({ criterionId: id, result: "match", explanation: "x", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] };
const draft = { subject: "Booking for your clinic", body: "Hi, a short note about online booking for your clinic. Worth a quick chat?", personalizationClaims: [{ claim: "Runs a clinic", evidenceUrl: "lead-record" }], proposedCallToAction: "Chat", confidence: 0.9, needsReview: false };
const AUTO = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 50, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };

const mail = (from: string, subject: string, body: string, extra = "") =>
    `From: ${from}\r\nTo: hello@studio.test\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@mail.test>\r\nDate: ${new Date().toUTCString()}\r\n${extra}\r\n${body}`;

test("inbox reading: replies are picked up over IMAP; other mail is never downloaded or stored", async () => {
    fakeLlm({ research, outreach: draft, follow_up: draft, conversation: { intent: "interested", confidence: 0.9, summary: "Interested.", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "Great, does Tuesday work?" } });
    const sent = fakeMailbox();
    const inbox = fakeInbox({ uidValidity: 7, messages: [{ uid: 1, from: "old@else.test", raw: mail("old@else.test", "Old", "before connecting") }] });

    const owner = await createAccount("Inbox");
    await request(app).put("/api/v1/policies").set(owner.auth).send(AUTO);
    const lead = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: "Inbox Clinic", contactEmail: "dr@inboxclinic.test", consentBasis: "legitimate_interest" })).body.data.lead;
    await Lead.updateOne({ organizationId: owner.organizationId, _id: lead._id }, { status: "qualified", "qualification.score": 90, "research.status": "done", "research.summary": "Clinic." });

    const c = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromName: "Studio", fromEmail: "hello@studio.test", host: "smtp.gmail.com", port: 587, user: "hello@studio.test", password: "app-password" });
    assert.equal(c.status, 200);
    assert.deepEqual({ enabled: c.body.data.integration.imap.enabled, host: c.body.data.integration.imap.host }, { enabled: true, host: "imap.gmail.com" }, "IMAP host derived from SMTP");
    const stored = await EmailIntegration.findOne({ organizationId: owner.organizationId }).lean();
    assert.equal(stored?.imap?.lastUid, 1, "starts from now: mail already in the inbox is not read");

    const camp = (await request(app).post("/api/v1/campaigns").set(owner.auth).send({ name: "Seq", audience: { statuses: ["qualified"], minScore: 0 }, autoSend: true })).body.data.campaign;
    await request(app).post(`/api/v1/campaigns/${camp._id}/start`).set(owner.auth);
    await runOnce({ force: true });
    await runOnce({ force: true });
    assert.equal(sent.length, 1);

    // a personal email and the prospect's reply land in the inbox
    inbox.state.messages.push(
        { uid: 2, from: "friend@else.test", raw: mail("friend@else.test", "Dinner?", "private") },
        { uid: 3, from: "dr@inboxclinic.test", inReplyTo: "fake-1", raw: mail("Dr <dr@inboxclinic.test>", "Re: Booking for your clinic", "Yes, tell me more about pricing.", "In-Reply-To: <fake-1>\r\n") },
    );
    await EmailIntegration.updateOne({ organizationId: owner.organizationId }, { "imap.lastPolledAt": new Date(0) }); // a minute passes
    await runOnce({ force: true }); // poll
    await runOnce({ force: true }); // process event, answer
    assert.deepEqual(inbox.downloaded, [3], "only the matching reply was downloaded");
    assert.equal(await ProviderEvent.countDocuments({ organizationId: owner.organizationId }), 1, "the personal email was never stored");
    const inbound = await Message.findOne({ organizationId: owner.organizationId, direction: "inbound" }).lean();
    assert.match(inbound?.body ?? "", /tell me more about pricing/);
    assert.equal((await EmailIntegration.findOne({ organizationId: owner.organizationId }).lean())?.imap?.lastUid, 3);

    // polling again reads nothing twice
    await EmailIntegration.updateOne({ organizationId: owner.organizationId }, { "imap.lastPolledAt": new Date(0) });
    await runOnce({ force: true });
    assert.equal(await Message.countDocuments({ organizationId: owner.organizationId, direction: "inbound" }), 1);

    // the mailbox was rebuilt (new uidValidity): start from now instead of re-reading everything
    inbox.state.uidValidity = 8;
    await EmailIntegration.updateOne({ organizationId: owner.organizationId }, { "imap.lastPolledAt": new Date(0) });
    await runOnce({ force: true });
    const after = await EmailIntegration.findOne({ organizationId: owner.organizationId }).lean();
    assert.deepEqual([after?.imap?.uidValidity, after?.imap?.lastUid], ["8", 3]);
    assert.equal(await ProviderEvent.countDocuments({ organizationId: owner.organizationId }), 1);
});

test("inbox reading: a failed IMAP sign-in blocks connecting with a clear message; can be turned off", async () => {
    setImapClient(async () => { throw new Error("Invalid credentials (Failure)"); });
    const owner = await createAccount("NoImap");
    const body = { fromName: "Studio", fromEmail: "hello@studio.test", host: "smtp.studio.test", port: 587, user: "hello@studio.test", password: "pw" };
    const bad = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send(body);
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /reading the inbox at imap\.studio\.test failed: Invalid credentials/);
    const ok = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ ...body, readInbox: false });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.integration.imap.enabled, false);
});
