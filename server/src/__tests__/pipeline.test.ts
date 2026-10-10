import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY } from "../shared/policy/policy.schema.js";
import Workflow from "../shared/models/workflow.model.js";
import Message from "../shared/models/message.model.js";

before(startDb);
after(stopDb);

const FIXTURES = {
    research: {
        companySummary: "Acme Dental runs three clinics in Pune and takes bookings by phone only.",
        industry: "Healthcare", employeeCountEstimate: 30,
        findings: [{ claim: "Bookings are phone-only", sourceUrl: "", confidence: 0.7 }],
        criteria: ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"].map((id) => ({ criterionId: id, result: "match", explanation: "From the imported record", evidenceUrls: ["lead-record"] })),
        potentialNeeds: [{ need: "Online appointment booking", evidenceUrls: ["lead-record"], confidence: 0.6 }],
        disqualifiers: [], conflicts: [],
    },
    outreach: { subject: "Online booking for Acme Dental", body: "Hi Priya, I noticed bookings at Acme Dental are phone-only. We build booking flows for clinics. Would a short call next week be useful?" },
    follow_up: { subject: "Following up", body: "Hi Priya, just floating this back up in case online booking is on your list this quarter." },
    conversation: (user: string) => user.includes("price") ? {
        intent: "question", summary: "Asked about price.", requirements: { needs: ["booking"], budget: "", timeline: "" },
        shouldReply: true, reply: "Happy to put together a tailored proposal after a short chat.", needsHuman: true,
    } : {
        intent: "interested", summary: "Interested in online booking for 3 clinics, wants to launch before January.",
        requirements: { needs: ["online booking", "patient reminders"], budget: "around 1 lakh", timeline: "before January" },
        shouldReply: true, reply: "Great to hear, Priya. Would Tuesday or Wednesday work for a 20-minute discovery call?", needsHuman: false,
    },
    proposal: { title: "Online booking for Acme Dental", understanding: "Three clinics need online booking and reminders.", approach: ["Booking flow", "SMS reminders"], nextSteps: ["Discovery call", "Kick-off"] },
};

async function setup() {
    const owner = await createAccount("Agency");
    const profile = {
        businessName: "Pixel Forge", businessType: "Web agency", description: "We build websites and booking systems for clinics.",
        website: "", brandVoice: "warm, concise",
        services: [{ name: "Booking website", description: "Website with online booking", basePriceMinor: 80_000_00 }, { name: "SMS reminders", description: "", basePriceMinor: 20_000_00 }],
        idealCustomerProfile: { industries: ["Healthcare"], companySizes: [], regions: ["India"], requiredSignals: [], disqualifiers: ["government body"] },
        approvedClaims: ["We have built booking systems for 12 clinics"], prohibitedClaims: ["guaranteed results"], caseStudies: [],
    };
    assert.equal((await request(app).put("/api/v1/business-profile").set(owner.auth).send(profile)).status, 200);
    // human-approval mode (the default) but without quiet hours so the test is time-independent
    const policy = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };
    assert.equal((await request(app).put("/api/v1/policies").set(owner.auth).send(policy)).status, 200);
    const lead = await request(app).post("/api/v1/leads").set(owner.auth).send({
        companyName: "Acme Dental", contactName: "Priya", contactEmail: "priya@acmedental.in", consentBasis: "legitimate_interest", country: "India",
    });
    return { owner, leadId: lead.body.data.lead._id as string };
}

test("lead pipeline: research → qualify → draft → human approval → send", async () => {
    const calls = fakeLlm(FIXTURES);
    const mailbox = fakeMailbox();
    const { owner, leadId } = await setup();

    const run = await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth);
    assert.equal(run.status, 202);
    // a second click does not start a second pipeline
    const again = await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth);
    assert.equal(String(again.body.data.workflowId), String(run.body.data.workflowId));

    await runOnce();
    const wf = await Workflow.findOne({ organizationId: owner.organizationId, _id: run.body.data.workflowId }).lean();
    assert.equal(wf?.status, "waiting_approval");
    assert.deepEqual(calls.map((c) => c.agent), ["research", "outreach"]);
    assert.equal(mailbox.length, 0, "nothing is sent before approval");

    const lead = (await request(app).get(`/api/v1/leads/${leadId}`).set(owner.auth)).body.data;
    assert.equal(lead.lead.status, "qualified");
    assert.equal(lead.lead.qualification.score, 100);
    assert.equal(lead.lead.research.evidence[0].verified, false, "claims not from a fetched page stay unverified");
    assert.match(lead.messages[0].body, /unsubscribe/, "opt-out footer is always appended");

    const approvals = (await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals;
    assert.equal(approvals.length, 1);
    const approval = approvals[0];

    // approving a stale view of the payload is refused
    const stale = await request(app).post(`/api/v1/approvals/${approval._id}/approve`).set(owner.auth).send({ payloadHash: "f".repeat(64) });
    assert.equal(stale.status, 409);

    // reviewer edits the draft; the approval re-binds to the new content
    const edited = await request(app).patch(`/api/v1/approvals/${approval._id}`).set(owner.auth).send({ subject: "Booking for Acme Dental", body: "Hi Priya, short note about online booking." });
    assert.equal(edited.status, 200);
    const ok = await request(app).post(`/api/v1/approvals/${approval._id}/approve`).set(owner.auth).send({ payloadHash: edited.body.data.approval.payloadHash });
    assert.equal(ok.status, 200);

    await runOnce();
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].to, "priya@acmedental.in");
    assert.equal(mailbox[0].subject, "Booking for Acme Dental");
    const done = await Workflow.findOne({ organizationId: owner.organizationId, _id: run.body.data.workflowId }).lean();
    assert.equal(done?.status, "completed");
    assert.equal((done?.result as { outcome: string }).outcome, "outreach_approved");

    // replaying the worker never re-sends
    await runOnce();
    assert.equal(mailbox.length, 1);

    // ---- the prospect replies with interest ----
    const conversationId = lead.conversation._id;
    const inbound = await request(app).post(`/api/v1/conversations/${conversationId}/inbound`).set(owner.auth).send({ body: "Yes, interested! We want it before January." });
    assert.equal(inbound.status, 202);
    await runOnce();
    const after = (await request(app).get(`/api/v1/leads/${leadId}`).set(owner.auth)).body.data;
    assert.equal(after.lead.opportunityStage, "discovery");
    assert.deepEqual(after.lead.requirements.needs, ["online booking", "patient reminders"]);
    assert.equal(after.lead.requirements.timeline, "before January");
    const replyApproval = (await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals[0];
    assert.equal(replyApproval.actionType, "reply.send");

    // ---- proposal: deterministic price, AI prose, out-of-policy discount needs approval ----
    const prop = await request(app).post(`/api/v1/leads/${leadId}/proposals`).set(owner.auth).send({ services: ["Booking website", "SMS reminders"], discountPercent: 15 });
    assert.equal(prop.status, 202);
    assert.equal(prop.body.data.proposal.totalMinor, 85_000_00);
    await runOnce();
    const proposalId = prop.body.data.proposal._id;
    const drafted = (await request(app).get(`/api/v1/proposals/${proposalId}`).set(owner.auth)).body.data.proposal;
    assert.equal(drafted.status, "draft");
    assert.match(drafted.body, /Total: ₹85,000\.00/);
    const send = await request(app).post(`/api/v1/proposals/${proposalId}/send`).set(owner.auth);
    assert.equal(send.body.data.decision, "needs_approval");
    assert.ok(send.body.data.reasons.some((r: string) => r.includes("Discount")));
});

test("opt-out: suppression is immediate and blocks everything after it", async () => {
    fakeLlm(FIXTURES);
    const mailbox = fakeMailbox();
    const { owner, leadId } = await setup();
    // auto-send mode for this tenant
    const policy = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };
    await request(app).put("/api/v1/policies").set(owner.auth).send(policy);

    await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth);
    await runOnce();
    assert.equal(mailbox.length, 1, "inside policy the agent sends on its own");

    const lead = (await request(app).get(`/api/v1/leads/${leadId}`).set(owner.auth)).body.data;
    await request(app).post(`/api/v1/conversations/${lead.conversation._id}/inbound`).set(owner.auth).send({ body: "Please remove me from your list." });
    await runOnce();

    const after = (await request(app).get(`/api/v1/leads/${leadId}`).set(owner.auth)).body.data;
    assert.equal(after.lead.outreachStatus, "opted_out");
    assert.equal(after.conversation.status, "suppressed");
    const suppressions = (await request(app).get("/api/v1/suppressions").set(owner.auth)).body.data.suppressions;
    assert.equal(suppressions[0].value, "priya@acmedental.in");

    // even a human-written reply is blocked now
    const human = await request(app).post(`/api/v1/conversations/${lead.conversation._id}/reply`).set(owner.auth).send({ body: "One last thing..." });
    assert.equal(human.body.data.status, "rejected");
    await runOnce();
    assert.equal(mailbox.length, 1);
});

test("pricing questions are escalated to a human even in auto-send mode", async () => {
    fakeLlm(FIXTURES);
    fakeMailbox();
    const { owner, leadId } = await setup();
    const policy = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };
    await request(app).put("/api/v1/policies").set(owner.auth).send(policy);
    await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth);
    await runOnce();
    const lead = (await request(app).get(`/api/v1/leads/${leadId}`).set(owner.auth)).body.data;
    await request(app).post(`/api/v1/conversations/${lead.conversation._id}/inbound`).set(owner.auth).send({ body: "What is the price?" });
    await runOnce();
    const pending = await Message.findOne({ organizationId: owner.organizationId, kind: "reply" }).lean();
    assert.equal(pending?.status, "pending_approval");
});

test("signed webhook: rejects bad signatures, dedupes redelivery", async () => {
    fakeLlm(FIXTURES);
    fakeMailbox();
    const { owner, leadId } = await setup();
    await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth);
    await runOnce();
    const lead = (await request(app).get(`/api/v1/leads/${leadId}`).set(owner.auth)).body.data;

    const payload = JSON.stringify({ eventId: "evt-1", organizationId: owner.organizationId, conversationId: lead.conversation._id, from: "priya@acmedental.in", text: "Interested!" });
    const sig = createHmac("sha256", "test_webhook_secret").update(payload).digest("hex");
    const post = (signature: string) => request(app).post("/api/webhooks/email/inbound").set("Content-Type", "application/json").set("X-EasySales-Signature", signature).send(payload);

    assert.equal((await post("0".repeat(64))).status, 401);
    const first = await post(sig);
    assert.equal(first.status, 202);
    const second = await post(sig);
    assert.equal(second.body.message, "Duplicate event ignored");
    assert.equal(String(second.body.data.workflowId), String(first.body.data.workflowId));
});

test("AI budget exhaustion fails the workflow without retries", async () => {
    fakeLlm(FIXTURES);
    const { owner, leadId } = await setup();
    await request(app).put("/api/v1/policies").set(owner.auth).send({ ...DEFAULT_POLICY, budgets: { maxLlmCallsPerDay: 0 } });
    const run = await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth);
    await runOnce();
    const wf = await Workflow.findOne({ organizationId: owner.organizationId, _id: run.body.data.workflowId }).lean();
    assert.equal(wf?.status, "failed");
    assert.equal(wf?.failureCode, "BUDGET_EXCEEDED");
});
