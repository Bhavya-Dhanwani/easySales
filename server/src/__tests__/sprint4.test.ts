import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY, PolicyConfig } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { priceProposal, splitPayments } from "../shared/utils/pricing.util.js";
import { ensureConversation } from "../agents/graphs/common.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import Prototype from "../shared/models/prototype.model.js";
import Proposal from "../shared/models/proposal.model.js";

before(startDb);
after(stopDb);
beforeEach(() => resetAlertThrottle());

const PROFILE = {
    businessName: "Studio", businessType: "Web agency", description: "We build booking websites.", website: "",
    services: [
        { name: "Booking website", description: "Website with online booking", basePriceMinor: 30_000_00, deliveryDaysMin: 14, deliveryDaysMax: 21 },
        { name: "Booking feature", description: "Extra booking flow", basePriceMinor: 5_000_00 },
    ],
    idealCustomerProfile: { industries: [], companySizes: [], regions: [], requiredSignals: [], disqualifiers: [] },
    brandVoice: "warm", approvedClaims: [], prohibitedClaims: ["guaranteed results"], caseStudies: [],
    terms: "Approved terms v1: payment within 15 days of invoice.",
};

const policy = (over: Partial<PolicyConfig["prototypes"]> = {}, proposals = { autoSend: false }): PolicyConfig => ({
    ...DEFAULT_POLICY, proposals,
    outreach: { ...DEFAULT_POLICY.outreach, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } },
    pricing: { ...DEFAULT_POLICY.pricing, taxBasisPoints: 1800, minimumDealValueMinor: 10_000_00 },
    prototypes: { ...DEFAULT_POLICY.prototypes, ...over },
});

const REQS = (sourceIds: string[], over: Record<string, unknown> = {}) => ({
    title: "Clinic booking site", projectType: "landing_page", problemStatement: "Patients can only book by phone.",
    targetUsers: ["Patients"],
    features: [
        { name: "Online booking", description: "Pick a slot", priority: "must", status: "confirmed" },
        { name: "SMS reminders", description: "Day-before reminder", priority: "should", status: "assumed" },
    ],
    design: { brandColors: ["#123456"], visualDirection: "calm", referenceUrls: [] },
    constraints: { budgetMinorUnits: 150_000_00, currency: "INR", targetDate: null, technologies: [] },
    acceptanceCriteria: ["A patient can book a slot in under a minute"], openQuestions: [], sourceMessageIds: sourceIds, ...over,
});

const CONTENT = (headline = "Book your visit in a minute", extra = "") => ({
    brandName: "Acme Dental", tagline: "Demo", headline, subheadline: `Calm, quick booking. ${extra}`.trim(), primaryCta: "Book now",
    palette: { primary: "#123456", accent: "#abcdef" },
    sections: [{ heading: "Features", body: "Everything a clinic needs.", items: [{ title: "Online booking", text: "Pick a slot." }] }],
    metrics: [{ label: "Bookings", value: "1,204" }], table: { columns: ["Patient", "Slot"], rows: [["A. Sample", "10:30"]] },
});

const NARRATIVE = {
    title: "Online booking for Acme Dental", understanding: "Phone-only booking is costing patients.", approach: ["Booking flow", "Launch"],
    nextSteps: ["Kick-off call"], deliverables: ["Booking website"], exclusions: ["Native apps"], assumptions: ["Content provided by client"],
    milestones: [{ name: "Design", description: "Screens" }, { name: "Build", description: "Site and booking" }],
};

// owner + profile + policy + a qualified lead with one inbound reply
async function workspace(name: string, p = policy()) {
    const owner = await createAccount(name);
    await request(app).put("/api/v1/business-profile").set(owner.auth).send(PROFILE);
    await request(app).put("/api/v1/policies").set(owner.auth).send(p);
    const lead = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: `${name} Dental`, contactEmail: `priya@${name.toLowerCase()}.test`, consentBasis: "legitimate_interest" })).body.data.lead;
    await Lead.updateOne({ organizationId: owner.organizationId, _id: lead._id }, { status: "qualified", "qualification.score": 90 });
    const conv = await ensureConversation(owner.organizationId, new mongoose.Types.ObjectId(String(lead._id)));
    const msg = await Message.create({
        organizationId: owner.organizationId, conversationId: conv._id, leadId: lead._id, direction: "inbound", kind: "inbound",
        body: "We need online booking for our clinic. Budget is about 1.5 lakh.", status: "received", idempotencyKey: `in:${lead._id}`,
    });
    return { owner, leadId: String(lead._id), msgId: msg._id.toString() };
}

const sid = (u: string) => [...u.matchAll(/message ([a-f0-9]{24})/g)].map((m) => m[1]);

test("pricing: integer minor units, discount then tax, payment split always adds up", () => {
    const p = priceProposal(PROFILE.services, ["Booking website", "Booking feature"], 5, 1800);
    assert.equal(p.subtotalMinor, 35_000_00);
    assert.equal(p.discountMinor, 1_750_00);
    assert.equal(p.taxMinor, 5_985_00);
    assert.equal(p.totalMinor, 39_235_00);
    const parts = splitPayments(1001, [{ label: "a", percent: 33 }, { label: "b", percent: 33 }, { label: "c", percent: 34 }]);
    assert.equal(parts.reduce((a, b) => a + b.amountMinor, 0), 1001);
    assert.throws(() => priceProposal(PROFILE.services, [{ name: "Booking website", quantity: 2 ** 53 }], 0));
    assert.throws(() => priceProposal(PROFILE.services, ["Booking website", "Booking website"], 0));
});

test("requirements: versioned, cited messages verified, other tenants locked out", async () => {
    const { owner, leadId, msgId } = await workspace("Reqs");
    const foreign = new mongoose.Types.ObjectId().toString();
    fakeLlm({ requirements: (u: string) => REQS([...sid(u), foreign]) });

    const ex = await request(app).post(`/api/v1/opportunities/${leadId}/requirements/extract`).set(owner.auth);
    assert.equal(ex.status, 202);
    await runOnce();
    const v1 = (await request(app).get(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth)).body.data.requirements;
    assert.equal(v1.version, 1);
    assert.deepEqual(v1.sourceMessageIds, [msgId], "an id the model was not shown is dropped");
    assert.equal(v1.requirements.features[0].status, "confirmed");
    assert.equal(v1.requirements.features[1].status, "assumed");

    const put = await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth).send({ requirements: REQS([foreign]), changeSummary: "x" });
    assert.equal(put.status, 400, "cannot cite a message outside this opportunity");
    const v2 = await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth).send({ requirements: REQS([msgId], { title: "Booking v2" }), changeSummary: "Prospect confirmed scope" });
    assert.equal(v2.body.data.requirements.version, 2);
    const old = (await request(app).get(`/api/v1/opportunities/${leadId}/requirements?version=1`).set(owner.auth)).body.data.requirements;
    assert.equal(old.requirements.title, "Clinic booking site", "earlier versions are immutable");

    const other = await createAccount("Intruder");
    assert.equal((await request(app).get(`/api/v1/opportunities/${leadId}`).set(other.auth)).status, 404);
    assert.equal((await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(other.auth).send({ requirements: REQS([]), changeSummary: "x" })).status, 404);
});

test("prototype: unclear scope refused, injected markup escaped, bounded repair, QA-gated publish, sandboxed expiring preview", async () => {
    const { owner, leadId, msgId } = await workspace("Proto");
    await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth).send({ requirements: REQS([msgId], { openQuestions: ["Which clinics first?"] }), changeSummary: "v1" });
    const refused = await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).set("Idempotency-Key", "p0").send({});
    assert.equal(refused.status, 409);
    assert.ok(refused.body.data.reasons.some((r: string) => r.includes("Which clinics first?")));
    assert.equal((await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).send({})).status, 400, "idempotency key required");

    await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth).send({ requirements: REQS([msgId]), changeSummary: "answered" });
    let n = 0;
    const calls = fakeLlm({
        // first attempt: hostile content (script + link); the repair must fix it
        prototype_builder: () => (++n === 1 ? CONTENT("<script>alert(document.cookie)</script>", "Visit https://evil.example") : CONTENT("<b>Book</b> & go")),
    });
    const req1 = await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).set("Idempotency-Key", "p1").send({});
    assert.equal(req1.status, 202);
    const again = await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).set("Idempotency-Key", "p1").send({});
    assert.equal(again.body.data.prototype._id, req1.body.data.prototype._id, "same key, same prototype");
    const id = req1.body.data.prototype._id;

    await runOnce();
    const built = (await request(app).get(`/api/v1/prototypes/${id}`).set(owner.auth)).body.data.prototype;
    assert.equal(built.status, "needs_review");
    assert.equal(built.attempts, 2);
    assert.equal(built.costMinorUnits, 2 * DEFAULT_POLICY.prototypes.costPerAttemptMinor);
    assert.ok(calls[1].user.includes("Security: content contains a URL"), "sanitized QA findings are fed back");
    assert.equal(built.artifactHtml, undefined, "artifact is never exposed by the API");
    const stored = await Prototype.findById(id).select("+artifactHtml").setOptions({ crossTenant: true });
    assert.ok(!/<script|<b>/i.test(stored!.artifactHtml!));
    assert.ok(stored!.artifactHtml!.includes("&lt;b&gt;Book&lt;/b&gt; &amp; go"));

    // another tenant cannot publish; tampering with the stored page fails the integrity check
    const intruder = await createAccount("Viewer");
    assert.equal((await request(app).post(`/api/v1/prototypes/${id}/publish`).set(intruder.auth)).status, 404);
    await Prototype.updateOne({ _id: id }, { artifactHtml: `${stored!.artifactHtml}<script>x()</script>` }).setOptions({ crossTenant: true });
    assert.equal((await request(app).post(`/api/v1/prototypes/${id}/publish`).set(owner.auth)).status, 409);
    await Prototype.updateOne({ _id: id }, { artifactHtml: stored!.artifactHtml }).setOptions({ crossTenant: true });

    const pub = await request(app).post(`/api/v1/prototypes/${id}/publish`).set(owner.auth);
    assert.equal(pub.status, 200);
    const url = new URL(pub.body.data.prototype.previewUrl);
    const page = await request(app).get(url.pathname);
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"], /^sandbox; default-src 'none'/);
    assert.match(page.text, /Online booking/);

    await request(app).post(`/api/v1/prototypes/${id}/expire`).set(owner.auth);
    assert.equal((await request(app).get(url.pathname)).status, 410, "revoked previews stop working");
    assert.equal((await request(app).get("/api/preview/not-a-token")).status, 410);
});

test("prototype budgets: per-prototype limit needs approval, monthly budget denies, repair budget ends in failure", async () => {
    const { owner, leadId, msgId } = await workspace("Budget", policy({ maxPerPrototypeMinor: 10_00, monthlyBudgetMinor: 150_00 }));
    await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth).send({ requirements: REQS([msgId]), changeSummary: "v1" });
    // never passes QA: the must-have feature is missing
    fakeLlm({ prototype_builder: () => ({ ...CONTENT(), sections: [{ heading: "Other", body: "x", items: [{ title: "Gallery", text: "y" }] }] }) });

    const r = await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).set("Idempotency-Key", "b1").send({});
    assert.equal(r.body.data.decision, "needs_approval");
    const approval = (await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals.find((a: { actionType: string }) => a.actionType === "prototype.build");
    assert.ok(approval);
    await runOnce();
    assert.equal((await Prototype.findById(r.body.data.prototype._id).setOptions({ crossTenant: true }))!.attempts, 0, "nothing runs before approval");

    await request(app).post(`/api/v1/approvals/${approval._id}/approve`).set(owner.auth).send({ payloadHash: approval.payloadHash });
    await runOnce();
    const failed = (await request(app).get(`/api/v1/prototypes/${r.body.data.prototype._id}/qa-report`).set(owner.auth)).body.data;
    assert.equal(failed.failureCode, "REPAIR_BUDGET_EXHAUSTED");
    assert.equal(failed.attempts, 2);
    assert.ok(failed.qaReport.findings.some((f: string) => f.includes("Online booking")));

    // 100 spent of 150: another 100 estimate is over the monthly budget
    const denied = await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).set("Idempotency-Key", "b2").send({});
    assert.equal(denied.status, 409);
    assert.ok(denied.body.data.reasons.includes("Monthly prototype budget exhausted"));
    assert.equal((await request(app).post(`/api/v1/prototypes/${r.body.data.prototype._id}/retry`).set(owner.auth)).status, 409);
});

test("proposals: immutable versions, approval bound to content, revisions supersede, acceptance only after sending", async () => {
    const { owner, leadId, msgId } = await workspace("Deal", policy({}, { autoSend: true }));
    await request(app).put(`/api/v1/opportunities/${leadId}/requirements`).set(owner.auth).send({ requirements: REQS([msgId]), changeSummary: "v1" });
    fakeLlm({ proposal: NARRATIVE });
    const mailbox = fakeMailbox();

    const created = await request(app).post(`/api/v1/opportunities/${leadId}/proposals`).set(owner.auth).send({ services: ["Booking website", "Booking feature"], discountPercent: 5 });
    assert.equal(created.status, 202);
    await runOnce();
    const v1 = (await request(app).get(`/api/v1/proposals/${created.body.data.proposal._id}`).set(owner.auth)).body.data.proposal;
    assert.equal(v1.version, 1);
    assert.equal(v1.totalMinor, 39_235_00);
    assert.match(v1.body, /Tax \(18%\): ₹5,985\.00/);
    assert.match(v1.body, /Approved terms v1/);
    assert.match(v1.body, /Not included:\n- Native apps/);
    assert.equal(v1.paymentSchedule.reduce((a: number, s: { amountMinor: number }) => a + s.amountMinor, 0), v1.totalMinor);

    // inside policy: approved by policy; then the content is tampered with and sending refuses
    const sub = await request(app).post(`/api/v1/proposals/${v1._id}/submit-approval`).set(owner.auth);
    assert.equal(sub.body.data.decision, "allow");
    await Proposal.updateOne({ _id: v1._id }, { totalMinor: 1 }).setOptions({ crossTenant: true });
    const tampered = await request(app).post(`/api/v1/proposals/${v1._id}/send`).set(owner.auth);
    assert.equal(tampered.status, 409, "approval is invalid once content changes");
    await Proposal.updateOne({ _id: v1._id }, { totalMinor: 39_235_00 }).setOptions({ crossTenant: true });
    assert.equal((await request(app).post(`/api/v1/proposals/${v1._id}/record-acceptance`).set(owner.auth).send({ acceptedBy: "Priya", evidence: "email" })).status, 409, "not sent yet");
    await request(app).post(`/api/v1/proposals/${v1._id}/send`).set(owner.auth);
    await runOnce();
    assert.equal(mailbox.length, 1);
    assert.equal((await Proposal.findById(v1._id).setOptions({ crossTenant: true }))!.status, "sent");

    // a new price book and requirements make v1 stale; a revision is a new version, v1 is untouched
    await request(app).put("/api/v1/business-profile").set(owner.auth).send({ ...PROFILE, services: [{ ...PROFILE.services[0], basePriceMinor: 40_000_00 }, PROFILE.services[1]] });
    const val = (await request(app).post(`/api/v1/proposals/${v1._id}/validate`).set(owner.auth)).body.data;
    assert.equal(val.valid, false);
    assert.ok(val.issues.some((i: string) => i.includes("Prices changed")));
    const rev = await request(app).post(`/api/v1/proposals/${v1._id}/revisions`).set(owner.auth).send({ discountPercent: 15, note: "Client asked for a discount" });
    assert.equal(rev.status, 202);
    await runOnce();
    const versions = (await request(app).get(`/api/v1/proposals/${v1._id}/versions`).set(owner.auth)).body.data.versions;
    assert.deepEqual(versions.map((v: { version: number; status: string }) => [v.version, v.status]), [[2, "draft"], [1, "superseded"]]);
    const old = await Proposal.findById(v1._id).setOptions({ crossTenant: true });
    assert.equal(old!.totalMinor, 39_235_00, "a sent version is never modified");

    // 15% is over the 10% policy: exceptional pricing needs a human, who approves the exact content
    const v2id = versions[0]._id;
    const s2 = await request(app).post(`/api/v1/proposals/${v2id}/send`).set(owner.auth);
    assert.equal(s2.body.data.decision, "needs_approval");
    const ap = (await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals.find((a: { targetId: string }) => a.targetId === v2id);
    await request(app).post(`/api/v1/approvals/${ap._id}/approve`).set(owner.auth).send({ payloadHash: ap.payloadHash });
    await runOnce();
    assert.equal(mailbox.length, 2);
    assert.match(mailbox[1].subject, /\(v2\)/);

    const accepted = await request(app).post(`/api/v1/proposals/${v2id}/record-acceptance`).set(owner.auth).send({ acceptedBy: "Priya", evidence: "Replied 'go ahead' by email", messageId: msgId });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.proposal.status, "accepted");
    assert.equal((await request(app).post(`/api/v1/proposals/${v2id}/revisions`).set(owner.auth).send({ note: "x" })).status, 409);

    const timeline = (await request(app).get(`/api/v1/opportunities/${leadId}/timeline`).set(owner.auth)).body.data.events.map((e: { action: string }) => e.action);
    for (const a of ["requirements.version", "proposal.create", "proposal.revise", "proposal.accepted"]) assert.ok(timeline.includes(a), a);

    const other = await createAccount("Rival");
    assert.equal((await request(app).get(`/api/v1/proposals/${v2id}`).set(other.auth)).status, 404);
    assert.equal((await request(app).post(`/api/v1/proposals/${v2id}/revisions`).set(other.auth).send({ note: "x" })).status, 404);
});

test("expiry: proposals and previews past their date expire in housekeeping", async () => {
    const { owner, leadId } = await workspace("Expiry");
    fakeLlm({ proposal: NARRATIVE });
    const created = await request(app).post(`/api/v1/opportunities/${leadId}/proposals`).set(owner.auth).send({ services: ["Booking website"] });
    await runOnce();
    const id = created.body.data.proposal._id;
    await Proposal.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) }).setOptions({ crossTenant: true });
    await runOnce();
    assert.equal((await Proposal.findById(id).setOptions({ crossTenant: true }))!.status, "expired");
    assert.equal((await request(app).post(`/api/v1/proposals/${id}/send`).set(owner.auth)).status, 409);
});
