import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY, PolicyConfig } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { recordStage } from "../shared/analytics/analytics.service.js";
import { variantIndex } from "../shared/experiments/experiment.service.js";
import { runEvaluation } from "../evals/evaluate.js";
import { REPLY_INTENT } from "../evals/dataset.js";
import env from "../shared/config/env.config.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import Workflow from "../shared/models/workflow.model.js";
import FunnelEvent from "../shared/models/funnelEvent.model.js";
import UsageRecord from "../shared/models/usageRecord.model.js";

before(startDb);
after(stopDb);
beforeEach(() => resetAlertThrottle());

const CRITERIA = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const research = (result: "match" | "partial" = "match") => ({ companySummary: "Clinic chain.", industry: "Healthcare", employeeCountEstimate: 30, findings: [], criteria: CRITERIA.map((id) => ({ criterionId: id, result, explanation: "From the record", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] });
const outreach = { subject: "Booking", body: "Hi, would online booking help your clinic? Happy to share how others do it.", personalizationClaims: [], proposedCallToAction: "Reply", confidence: 0.9, needsReview: false };
const interested = { intent: "interested", confidence: 0.95, summary: "Interested.", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "Great, Tuesday?" };
const proposal = { title: "Booking", understanding: "x", approach: ["a", "b"], nextSteps: ["c"], deliverables: ["Site"], exclusions: [], assumptions: [], milestones: [{ name: "Build", description: "d" }] };

const policy = (over: (p: PolicyConfig) => PolicyConfig = (p) => p) => over({
    ...DEFAULT_POLICY, proposals: { autoSend: true },
    outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 100, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } },
});

async function workspace(name: string, p = policy()) {
    const owner = await createAccount(name);
    await request(app).put("/api/v1/business-profile").set(owner.auth).send({
        businessName: "Studio", businessType: "Agency", description: "Booking sites.", website: "", brandVoice: "warm",
        services: [{ name: "Booking website", description: "", basePriceMinor: 80_000_00 }],
        idealCustomerProfile: { industries: ["Healthcare"], companySizes: [], regions: [], requiredSignals: [], disqualifiers: [] },
        approvedClaims: [], prohibitedClaims: [], caseStudies: [],
    });
    await request(app).put("/api/v1/policies").set(owner.auth).send(p);
    return owner;
}
const addLead = async (auth: Record<string, string>, i: number, industry = "Healthcare") =>
    (await request(app).post("/api/v1/leads").set(auth).send({ companyName: `Clinic ${i}`, contactEmail: `c${i}@clinic${i}.test`, consentBasis: "legitimate_interest", industry })).body.data.lead._id as string;

test("funnel: stages are recorded once from real workflow events; rates follow the definitions", async () => {
    fakeLlm({ research: (u: string) => research(u.includes("Clinic 2") ? "partial" : "match"), outreach, conversation: interested, proposal });
    fakeMailbox();
    const owner = await workspace("Funnel");
    const [a, b] = [await addLead(owner.auth, 1), await addLead(owner.auth, 2)];
    for (const id of [a, b]) await request(app).post(`/api/v1/leads/${id}/run`).set(owner.auth);
    await runOnce();

    const lead = (await request(app).get(`/api/v1/leads/${a}`).set(owner.auth)).body.data;
    assert.equal(lead.lead.qualification.priority, "high");
    assert.ok(lead.lead.qualification.criteria[0].observedAt, "each signal records when it was observed");
    await request(app).post(`/api/v1/conversations/${lead.conversation._id}/inbound`).set(owner.auth).send({ body: "Yes, interested!" });
    await runOnce();
    const p = await request(app).post(`/api/v1/opportunities/${a}/proposals`).set(owner.auth).send({ services: ["Booking website"] });
    await runOnce();
    // no captured requirements → the scope needs a human; the reviewer approves the exact content
    const sent = await request(app).post(`/api/v1/proposals/${p.body.data.proposal._id}/send`).set(owner.auth);
    assert.equal(sent.body.data.decision, "needs_approval");
    const ap = (await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals.find((x: { targetId: string }) => x.targetId === p.body.data.proposal._id);
    await request(app).post(`/api/v1/approvals/${ap._id}/approve`).set(owner.auth).send({ payloadHash: ap.payloadHash });
    await runOnce();
    await request(app).post(`/api/v1/proposals/${p.body.data.proposal._id}/record-acceptance`).set(owner.auth).send({ acceptedBy: "P", evidence: "email" });
    await request(app).post(`/api/v1/opportunities/${a}/handoff`).set(owner.auth).send({});

    // the same stage reported twice is still one event
    await recordStage(owner.organizationId, a, "contacted");
    const f = (await request(app).get("/api/v1/analytics/funnel").set(owner.auth)).body.data;
    const c = f.totals.counts;
    assert.deepEqual([c.discovered, c.researched, c.icp_qualified, c.contacted, c.positive_reply, c.qualified_opportunity, c.proposal_sent, c.won], [2, 2, 1, 1, 1, 1, 1, 1]);
    assert.equal(f.totals.rates.icpQualificationRate, 50);
    assert.equal(f.totals.rates.positiveReplyRate, 100);
    assert.equal(f.totals.rates.winRate, 100);
    assert.equal(f.deliveryReported, false, "no delivery events → delivery rate is not invented");
    assert.equal(f.cohorts[0].incomplete, true, "a cohort younger than 30 days is flagged incomplete");
    const seg = (await request(app).get("/api/v1/analytics/funnel?groupBy=week&bySegment=true").set(owner.auth)).body.data;
    assert.equal(seg.cohorts[0].segment, "healthcare");

    // costs are attributed to the opportunity and to the funnel stage they bought
    const costs = (await request(app).get("/api/v1/analytics/costs").set(owner.auth)).body.data;
    const top = costs.topOpportunities.find((o: { leadId: string }) => o.leadId === a);
    assert.ok(top.costMinor > 0 && top.stagesReached.includes("won"));
    assert.ok(costs.byStage.some((s: { stage: string }) => s.stage === "research") && costs.byStage.some((s: { stage: string }) => s.stage === "outreach"));
    assert.ok(costs.costPerQualifiedOpportunityMinor > 0);
    assert.equal(await UsageRecord.countDocuments({ organizationId: owner.organizationId, leadId: null }).setOptions({ crossTenant: true }), 0, "every cost has an opportunity");

    const quality = (await request(app).get("/api/v1/analytics/lead-quality").set(owner.auth)).body.data;
    assert.equal(quality.bands.find((x: { priority: string }) => x.priority === "high").won, 1);

    const other = await createAccount("FunnelSpy");
    assert.equal((await request(app).get("/api/v1/analytics/funnel").set(other.auth)).body.data.totals.counts.discovered, undefined, "tenant scoped");
});

test("priority queue and research cache: better-fit work first, fresh research is not paid for twice", async () => {
    const calls = fakeLlm({ research: research() });
    const owner = await workspace("Priority");
    const [low, high] = [await addLead(owner.auth, 1), await addLead(owner.auth, 2)];
    await Lead.updateOne({ _id: high }, { "qualification.priority": "high" }).setOptions({ crossTenant: true });
    const r1 = await request(app).post(`/api/v1/leads/${low}/research`).set(owner.auth);
    const r2 = await request(app).post(`/api/v1/leads/${high}/research`).set(owner.auth);
    assert.equal((await Workflow.findById(r2.body.data.jobId).setOptions({ crossTenant: true }))!.priority, 2);
    await runOnce({ maxWorkflows: 1 });
    assert.equal((await Workflow.findById(r2.body.data.jobId).setOptions({ crossTenant: true }))!.status, "completed", "high priority ran first");
    assert.equal((await Workflow.findById(r1.body.data.jobId).setOptions({ crossTenant: true }))!.status, "queued");
    await runOnce();

    const before = calls.length;
    const again = await request(app).post(`/api/v1/leads/${high}/research`).set(owner.auth);
    await runOnce();
    assert.equal(calls.length, before, "no model call for fresh research");
    assert.equal((await Workflow.findById(again.body.data.jobId).setOptions({ crossTenant: true }))!.result?.outcome, "rescored_from_fresh_research");
    await request(app).post(`/api/v1/leads/${high}/research?force=true`).set(owner.auth);
    await runOnce();
    assert.equal(calls.length, before + 1, "an explicit refresh still researches");
});

test("experiments: consistent assignment, one experiment per lead, policies still apply, results with a stopping rule", async () => {
    const calls = fakeLlm({ research: research(), outreach });
    fakeMailbox();
    // approval mode: an experiment must never bypass it
    const owner = await workspace("Experiments", policy((p) => ({ ...p, outreach: { ...p.outreach, autoSend: false } })));
    const bad = await request(app).post("/api/v1/experiments").set(owner.auth).send({ name: "x", hypothesis: "only one variant here", variable: "subject_line", variants: [{ label: "A", instruction: "Subject: Hi" }] });
    assert.equal(bad.status, 400, "needs a control and at least one variant");

    const exp = (await request(app).post("/api/v1/experiments").set(owner.auth).send({
        name: "Subject test", hypothesis: "A question in the subject gets more positive replies", variable: "subject_line",
        audience: { industries: ["Healthcare"] }, minSamplePerVariant: 10,
        variants: [{ label: "Control", instruction: "Subject line: Online booking for {company}" }, { label: "Question", instruction: "Subject line: Still taking bookings by phone?" }],
    })).body.data.experiment;
    const second = (await request(app).post("/api/v1/experiments").set(owner.auth).send({
        name: "CTA test", hypothesis: "A softer call to action converts better", variable: "call_to_action",
        variants: [{ label: "Control", instruction: "Ask for a call" }, { label: "Soft", instruction: "Offer to send examples" }],
    })).body.data.experiment;
    for (const e of [exp, second]) assert.equal((await request(app).post(`/api/v1/experiments/${e._id}/start`).set(owner.auth)).status, 200);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await addLead(owner.auth, i));
    for (const id of ids) await request(app).post(`/api/v1/leads/${id}/run`).set(owner.auth);
    await runOnce({ maxWorkflows: 10 });

    for (const id of ids) {
        const lead = await Lead.findById(id).setOptions({ crossTenant: true }).lean();
        assert.equal(String(lead!.experiment!.id), String(exp._id), "the oldest matching experiment wins; one per lead");
        assert.equal(lead!.experiment!.variantId, ["A", "B"][variantIndex(String(exp._id), id, 2)], "deterministic assignment");
        const m = await Message.findOne({ organizationId: owner.organizationId, leadId: id, kind: "outreach" }).lean();
        assert.equal(m!.status, "pending_approval", "approval requirement unchanged by the experiment");
        assert.equal(m!.variantId, lead!.experiment!.variantId);
    }
    const drafted = calls.filter((c) => c.agent === "outreach");
    assert.ok(drafted.every((c) => c.system.includes("Approved experiment variant for the subject line")));

    const res = (await request(app).get(`/api/v1/experiments/${exp._id}/results`).set(owner.auth)).body.data;
    assert.equal(res.variants.reduce((a: number, v: { assigned: number }) => a + v.assigned, 0), 4);
    assert.equal(res.stoppingRuleMet, false);
    assert.match(res.note, /Not enough data/);

    await request(app).post(`/api/v1/experiments/${exp._id}/complete`).set(owner.auth);
    assert.equal((await request(app).post(`/api/v1/experiments/${exp._id}/start`).set(owner.auth)).status, 409, "a completed experiment never restarts");
    const other = await createAccount("ExpSpy");
    assert.equal((await request(app).get(`/api/v1/experiments/${exp._id}/results`).set(other.auth)).status, 404);
});

test("evaluation: deterministic checks pass; model regressions are caught and versioned", async () => {
    const det = await runEvaluation({ record: false });
    assert.equal(det.passed, true);
    assert.ok(det.summary.reduce((a, t) => a + t.total, 0) >= 17, "every deterministic example ran");

    const reqFix = (u: string) => ({
        title: u.includes("dashboard") ? "Sales dashboard" : "Booking site", projectType: u.includes("dashboard") ? "dashboard" : "business_website", problemStatement: "x", targetUsers: [],
        features: u.includes("dashboard") ? [{ name: "Orders and revenue charts", description: "daily orders, revenue by region", priority: "must", status: "confirmed" }] : [{ name: "Online booking", description: "book online", priority: "must", status: "confirmed" }],
        design: { brandColors: [], visualDirection: "", referenceUrls: [] }, constraints: { budgetMinorUnits: u.includes("dashboard") ? null : 150_000_00, currency: "INR", targetDate: null, technologies: [] },
        acceptanceCriteria: [], openQuestions: [], sourceMessageIds: [],
    });
    const intentFor = (u: string) => REPLY_INTENT.find((e) => u.includes(e.text))!.accept[0];
    fakeLlm({ conversation: (u: string) => ({ ...interested, intent: intentFor(u), reply: "" }), requirements: reqFix });
    const good = await runEvaluation({ live: true });
    assert.equal(good.passed, true, JSON.stringify(good.failures));

    // a "model update" that answers pricing questions as interest is caught
    fakeLlm({ conversation: (u: string) => ({ ...interested, intent: u.includes("cost") ? "interested" : intentFor(u), reply: "" }), requirements: reqFix });
    const bad = await runEvaluation({ live: true });
    assert.equal(bad.passed, false);
    assert.deepEqual(bad.failures.map((f) => [f.exampleId, f.failureCategory, f.detail]), [["intent-pricing", "wrong_intent", "interested"]]);
    assert.match(bad.failures[0].promptVersion, /^[a-f0-9]{10}$/);

    const owner = await createAccount("Operator");
    env.ADMIN_EMAILS = owner.email;
    try {
        const results = (await request(app).get("/api/admin/evaluations/results").set(owner.auth)).body.data.runs;
        assert.ok(results.some((r: { _id: { taskType: string }; passed: number; total: number }) => r._id.taskType === "reply_intent" && r.passed < r.total));
        const cap = (await request(app).get("/api/admin/analytics/worker-capacity").set(owner.auth)).body.data;
        assert.ok(cap.types.find((t: { type: string }) => t.type === "lead.research") && cap.database.pingMs >= 0 && cap.recommendations.length);
    } finally {
        env.ADMIN_EMAILS = "";
    }
    assert.ok(await FunnelEvent.countDocuments().setOptions({ crossTenant: true }) >= 0);
});
