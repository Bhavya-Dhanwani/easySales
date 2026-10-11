import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY, PolicyConfig } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { emitSalesEvent, evaluate } from "../shared/sales/sales.service.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import Proposal from "../shared/models/proposal.model.js";
import Conversation from "../shared/models/conversation.model.js";
import SalesDecision from "../shared/models/salesDecision.model.js";
import Approval from "../shared/models/approval.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";

before(startDb);
after(stopDb);
beforeEach(() => resetAlertThrottle());

const CRITERIA = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const research = { companySummary: "Clinic.", industry: "Healthcare", employeeCountEstimate: 20, findings: [], criteria: CRITERIA.map((id) => ({ criterionId: id, result: "match", explanation: "x", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] };
const outreach = { subject: "Booking", body: "Hi, would online booking help your clinic? Happy to share how others do it.", personalizationClaims: [], proposedCallToAction: "Reply", confidence: 0.9, needsReview: false };
const reply = (intent: string, extra: Record<string, unknown> = {}) => ({ intent, confidence: 0.9, summary: "x", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "", ...extra });
const proposalNarrative = { title: "Booking", understanding: "x", approach: ["a", "b"], nextSteps: ["c"], deliverables: ["Site"], exclusions: [], assumptions: [], milestones: [{ name: "Build", description: "d" }] };

const policy = (level: 1 | 2 | 3, eventDriven = true): PolicyConfig => ({
    ...DEFAULT_POLICY, automation: { level, eventDriven, inactivityDays: 7 }, proposals: { autoSend: false },
    outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 100, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } },
});

async function workspace(name: string, p: PolicyConfig) {
    const owner = await createAccount(name);
    await request(app).put("/api/v1/business-profile").set(owner.auth).send({ businessName: "S", businessType: "a", description: "b", website: "", brandVoice: "w", services: [{ name: "Booking website", description: "", basePriceMinor: 80_000_00 }], idealCustomerProfile: { industries: ["Healthcare"], companySizes: [], regions: [], requiredSignals: [], disqualifiers: [] }, approvedClaims: [], prohibitedClaims: [], caseStudies: [] });
    await request(app).put("/api/v1/policies").set(owner.auth).send(p);
    return owner;
}
const lead = async (auth: Record<string, string>, i = 1) => (await request(app).post("/api/v1/leads").set(auth).send({ companyName: `Clinic ${i}`, contactName: "Asha", contactEmail: `a${i}@clinic${i}.test`, consentBasis: "legitimate_interest", industry: "Healthcare" })).body.data.lead._id as string;
const decisions = async (orgId: string, leadId: string) => SalesDecision.find({ organizationId: orgId, leadId }).sort({ createdAt: 1 }).lean();

test("events drive the next action once: research → first email, duplicated events change nothing", async () => {
    fakeLlm({ research, outreach });
    const mailbox = fakeMailbox();
    const owner = await workspace("Events", policy(2));
    const id = await lead(owner.auth);
    await request(app).post(`/api/v1/leads/${id}/research`).set(owner.auth);
    await runOnce();   // research completes → lead.researched + lead.qualified events
    await runOnce();   // evaluation → send_reply → lead.pipeline
    await runOnce();   // pipeline drafts and sends
    assert.equal(mailbox.length, 1, "the first email went out exactly once");
    const ds = await decisions(owner.organizationId, id);
    assert.ok(ds.some((d) => d.action === "send_reply" && d.policyDecision === "allowed"));
    assert.ok(ds.every((d) => d.reason && d.state));

    // the same event delivered again: no new decision, no new action
    await emitSalesEvent(owner.organizationId, id, "lead.qualified", "icp_qualified");
    await emitSalesEvent(owner.organizationId, id, "lead.qualified", "icp_qualified");
    await runOnce();
    await runOnce();
    assert.equal((await decisions(owner.organizationId, id)).length, ds.length);
    assert.equal(mailbox.length, 1);
});

test("copilot level: external actions wait for a human; approvals are bound, raced and stale-checked", async () => {
    fakeLlm({ research, outreach });
    const mailbox = fakeMailbox();
    const owner = await workspace("Copilot", policy(1, false));
    const id = await lead(owner.auth);
    await Lead.updateOne({ _id: id }, { status: "qualified", "research.status": "done" }).setOptions({ crossTenant: true });
    const d = (await request(app).post(`/api/v1/opportunities/${id}/evaluate-next-action`).set(owner.auth)).body.data.decision;
    assert.deepEqual([d.action, d.policyDecision, d.status], ["send_reply", "approval_required", "proposed"]);
    assert.equal(mailbox.length, 0);
    const ap = (await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals.find((a: { actionType: string }) => a.actionType === "sales.action");

    // two reviewers click approve at the same moment: one wins, the other is refused
    const [r1, r2] = await Promise.all([0, 1].map(() => request(app).post(`/api/v1/approvals/${ap._id}/approve`).set(owner.auth).send({ payloadHash: ap.payloadHash })));
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    await runOnce();
    assert.equal(mailbox.length, 1, "approved once, executed once");

    // stale approval: the prospect replies after the review was requested
    const id2 = await lead(owner.auth, 2);
    await Lead.updateOne({ _id: id2 }, { status: "qualified", "research.status": "done" }).setOptions({ crossTenant: true });
    await request(app).post(`/api/v1/opportunities/${id2}/evaluate-next-action`).set(owner.auth);
    const ap2 = (await Approval.findOne({ organizationId: owner.organizationId, leadId: id2, actionType: "sales.action", status: "pending" }).lean())!;
    await Lead.updateOne({ _id: id2 }, { opportunityStage: "lost" }).setOptions({ crossTenant: true });
    const stale = await request(app).post(`/api/v1/approvals/${ap2._id}/approve`).set(owner.auth).send({ payloadHash: ap2.payloadHash });
    assert.equal(stale.status, 409);
    assert.equal((await SalesDecision.findById(ap2.targetId).setOptions({ crossTenant: true }).lean())!.status, "skipped");
    assert.equal(mailbox.length, 1);
});

test("the model chooses only among valid actions and can never authorize itself", async () => {
    // several valid actions → the model is asked; it tries an action that is not on the list
    fakeLlm({ sales_strategist: { action: "close_lost", reason: "trust me", evidenceIds: ["made-up"], missingInformation: [], confidence: 0.99, requiresApproval: false } });
    const owner = await workspace("Strategist", policy(2, false));
    const id = await lead(owner.auth);
    await Lead.updateOne({ _id: id }, { status: "qualified", "research.status": "done", opportunityStage: "discovery" }).setOptions({ crossTenant: true });
    await request(app).put(`/api/v1/opportunities/${id}/requirements`).set(owner.auth).send({ requirements: { title: "Site", projectType: "landing_page", problemStatement: "x", targetUsers: [], features: [{ name: "Booking", description: "x", priority: "must", status: "confirmed" }], design: { brandColors: [], visualDirection: "", referenceUrls: [] }, constraints: { budgetMinorUnits: null, currency: "INR", targetDate: null, technologies: [] }, acceptanceCriteria: [], openQuestions: [], sourceMessageIds: [] }, changeSummary: "x" });
    const d = await evaluate(new (await import("mongoose")).default.Types.ObjectId(owner.organizationId), new (await import("mongoose")).default.Types.ObjectId(id), "manual", "t1");
    assert.deepEqual(d.candidates, ["build_prototype", "prepare_proposal"]);
    assert.equal(d.rejectedSuggestion, "close_lost", "an action outside the list is ignored");
    assert.equal(d.action, "build_prototype");
    assert.equal(d.policyDecision, "approval_required", "the model's 'no approval needed' is never used");

    // a valid choice is accepted, but only evidence that was offered is kept
    fakeLlm({ sales_strategist: { action: "prepare_proposal", reason: "Requirements are clear", evidenceIds: ["requirements:v1", "invented"], missingInformation: [], confidence: 0.8, requiresApproval: false } });
    await SalesDecision.deleteMany({}).setOptions({ crossTenant: true });
    await Approval.updateMany({}, { status: "expired" }).setOptions({ crossTenant: true });
    const d2 = await evaluate(new (await import("mongoose")).default.Types.ObjectId(owner.organizationId), new (await import("mongoose")).default.Types.ObjectId(id), "manual", "t2");
    assert.deepEqual([d2.action, d2.decidedBy, d2.evidenceIds], ["prepare_proposal", "model", ["requirements:v1"]]);
});

test("objections and opt-outs: no invented discounts, over-limit escalates, opt-out stops everything", async () => {
    fakeLlm({ research, outreach, conversation: (u: string) => u.includes("20%") || u.includes("5%") ? reply("objection") : u.includes("stop") ? reply("opt_out") : reply("interested", { reply: "Glad to hear it." }), proposal: proposalNarrative });
    fakeMailbox();
    const owner = await workspace("Objections", policy(2));
    const id = await lead(owner.auth);
    await Lead.updateOne({ _id: id }, { status: "qualified", "research.status": "done", outreachStatus: "active", opportunityStage: "proposal" }).setOptions({ crossTenant: true });
    const p = await Proposal.create({ organizationId: owner.organizationId, leadId: id, version: 1, items: [{ name: "Booking website", priceMinor: 80_000_00 }], currency: "INR", subtotalMinor: 80_000_00, totalMinor: 80_000_00, status: "sent", sentAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400_000), body: "x" });
    const convId = (await Conversation.create({ organizationId: owner.organizationId, leadId: id, status: "open", subject: "Booking" }))._id;

    await request(app).post(`/api/v1/conversations/${convId}/inbound`).set(owner.auth).send({ body: "Too expensive. Can you do 20% off?" });
    await runOnce();
    await runOnce();
    let ds = await decisions(owner.organizationId, id);
    const over = ds.find((d) => d.trigger === "conversation.reply_received")!;
    assert.equal(over.action, "escalate");
    assert.match(over.reason, /20% discount exceeds the 10% limit/);
    assert.equal(await Proposal.countDocuments({ organizationId: owner.organizationId, leadId: id }).setOptions({ crossTenant: true }), 1, "no revision for an over-limit request");
    assert.equal((await Lead.findById(id).setOptions({ crossTenant: true }).lean())!.automation?.paused, true, "escalation pauses automation");

    // a human resumes; a within-limit request becomes a revision priced by code, after approval
    await request(app).post(`/api/v1/opportunities/${id}/resume-automation`).set(owner.auth);
    await Approval.updateMany({ organizationId: owner.organizationId, status: "pending" }, { status: "expired" });
    await request(app).post(`/api/v1/conversations/${convId}/inbound`).set(owner.auth).send({ body: "OK, could you manage 5% off instead?" });
    await runOnce();
    await runOnce();
    ds = await decisions(owner.organizationId, id);
    const within = ds.filter((d) => d.trigger === "conversation.reply_received").pop()!;
    assert.deepEqual([within.action, within.policyDecision], ["prepare_proposal", "approval_required"]);
    const ap = (await Approval.findOne({ organizationId: owner.organizationId, targetId: within._id }).lean())!;
    assert.equal((await request(app).post(`/api/v1/approvals/${ap._id}/approve`).set(owner.auth).send({ payloadHash: ap.payloadHash })).status, 200);
    await runOnce();
    const v2 = await Proposal.findOne({ organizationId: owner.organizationId, leadId: id, version: 2 }).setOptions({ crossTenant: true }).lean();
    assert.deepEqual([v2!.discountPercent, v2!.totalMinor], [5, 76_000_00], "discount applied by the pricing engine");

    // opt-out: nothing more is proposed or sent, pending work is cancelled
    await request(app).post(`/api/v1/conversations/${convId}/inbound`).set(owner.auth).send({ body: "Please stop emailing me." });
    await runOnce();
    await runOnce();
    const last = (await decisions(owner.organizationId, id)).pop()!;
    assert.equal(last.action, "wait");
    assert.match(last.reason, /opted out/);
    assert.equal(await Message.countDocuments({ organizationId: owner.organizationId, leadId: id, direction: "outbound", status: "queued" }), 0);
});

test("closing, pausing and stage rules: not-interested closes (bounded), 'sounds great' never wins", async () => {
    fakeLlm({ conversation: (u: string) => u.includes("not interested") ? reply("not_interested", { recommendedAction: "close" }) : reply("interested", { reply: "Great!" }) });
    fakeMailbox();
    const owner = await workspace("Closer", policy(3));
    const id = await lead(owner.auth);
    await Lead.updateOne({ _id: id }, { status: "qualified", "research.status": "done", outreachStatus: "active", opportunityStage: "discovery" }).setOptions({ crossTenant: true });
    const convId = (await Conversation.create({ organizationId: owner.organizationId, leadId: id, status: "open", subject: "Hi" }))._id;

    assert.equal((await request(app).patch(`/api/v1/leads/${id}`).set(owner.auth).send({ opportunityStage: "won" })).status, 409, "a status edit never wins a deal");
    await request(app).post(`/api/v1/conversations/${convId}/inbound`).set(owner.auth).send({ body: "Sounds great!" });
    await runOnce();
    await runOnce();
    assert.notEqual((await Lead.findById(id).setOptions({ crossTenant: true }).lean())!.opportunityStage, "won");

    // pause: evaluations wait, follow-ups stop
    await request(app).post(`/api/v1/opportunities/${id}/pause-automation`).set(owner.auth).send({ reason: "Owner handles this one" });
    const paused = (await request(app).post(`/api/v1/opportunities/${id}/evaluate-next-action`).set(owner.auth)).body.data.decision;
    assert.deepEqual([paused.action, paused.reason], ["wait", "Automation is paused for this opportunity"]);
    await request(app).post(`/api/v1/opportunities/${id}/resume-automation`).set(owner.auth);

    await request(app).post(`/api/v1/conversations/${convId}/inbound`).set(owner.auth).send({ body: "Thanks, but we are not interested." });
    await runOnce();
    await runOnce();
    const l = (await Lead.findById(id).setOptions({ crossTenant: true }).lean())!;
    assert.equal(l.opportunityStage, "lost", "bounded autonomy may close a deal the prospect declined");
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "sales.decision", "metadata.action": "close_lost" }));
    const info = (await request(app).get(`/api/v1/opportunities/${id}/decisions`).set(owner.auth)).body.data;
    assert.equal(info.state, "lost");
    assert.deepEqual(info.candidates.map((c: { action: string }) => c.action), ["wait"]);
});
