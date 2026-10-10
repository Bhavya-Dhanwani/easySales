import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import mongoose from "mongoose";
import pino from "pino";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY, PolicyConfig } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { setSmtpVerifier } from "../modules/private/integrations/integrations.router.js";
import { reserve, settle, spendSnapshot, SpendLimitError } from "../shared/billing/budget.service.js";
import { runOpsChecks } from "../shared/ops/ops.service.js";
import { REDACT_PATHS } from "../shared/config/logger.config.js";
import env from "../shared/config/env.config.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import Workflow from "../shared/models/workflow.model.js";
import Prototype from "../shared/models/prototype.model.js";
import UsageRecord from "../shared/models/usageRecord.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";
import { SpendCounter } from "../shared/models/budget.model.js";
import Organization from "../shared/models/organization.model.js";

before(startDb);
after(stopDb);
beforeEach(() => { resetAlertThrottle(); setSmtpVerifier(async () => undefined); });

const CRITERIA = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const FIX = {
    research: { companySummary: "Acme Dental runs three clinics; bookings are phone-only.", industry: "Healthcare", employeeCountEstimate: 30, findings: [], criteria: CRITERIA.map((id) => ({ criterionId: id, result: "match", explanation: "From the record", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] },
    outreach: { subject: "Online booking for Acme Dental", body: "Hi Priya, bookings at Acme Dental look phone-only. We build booking flows for clinics. Worth a short call?", personalizationClaims: [{ claim: "Bookings are phone-only", evidenceUrl: "lead-record" }], proposedCallToAction: "Call", confidence: 0.9, needsReview: false },
    conversation: { intent: "interested", confidence: 0.92, summary: "Wants online booking.", extractedFacts: [{ field: "need", value: "online booking", evidence: "booking" }], recommendedAction: "reply", returnDate: "", reply: "Great, would Tuesday work for a short call?" },
    requirements: (u: string) => ({
        title: "Clinic booking", projectType: "landing_page", problemStatement: "Phone-only booking.", targetUsers: ["Patients"],
        features: [{ name: "Online booking", description: "Pick a slot", priority: "must", status: "confirmed" }],
        design: { brandColors: [], visualDirection: "calm", referenceUrls: [] },
        constraints: { budgetMinorUnits: null, currency: "INR", targetDate: null, technologies: [] },
        acceptanceCriteria: ["Book in a minute"], openQuestions: [], sourceMessageIds: [...u.matchAll(/message ([a-f0-9]{24})/g)].map((m) => m[1]),
    }),
    prototype_builder: {
        brandName: "Acme Dental", tagline: "Demo", headline: "Book in a minute", subheadline: "No phone queue.", primaryCta: "Book",
        palette: { primary: "#123456", accent: "#abcdef" }, sections: [{ heading: "Booking", body: "Fast.", items: [{ title: "Online booking", text: "Pick a slot." }] }],
        metrics: [], table: { columns: [], rows: [] },
    },
    proposal: { title: "Online booking", understanding: "Phone-only booking.", approach: ["Flow", "Launch"], nextSteps: ["Kick-off"], deliverables: ["Booking site"], exclusions: [], assumptions: [], milestones: [{ name: "Build", description: "Site" }] },
};

const policy = (over: (p: PolicyConfig) => PolicyConfig = (p) => p): PolicyConfig => over({
    ...DEFAULT_POLICY,
    outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 50, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } },
    proposals: { autoSend: true },
});

async function workspace(name: string, p = policy()) {
    const owner = await createAccount(name);
    await request(app).put("/api/v1/business-profile").set(owner.auth).send({
        businessName: "Pixel Forge", businessType: "Web agency", description: "Booking systems for clinics.", website: "", brandVoice: "warm",
        services: [{ name: "Booking website", description: "", basePriceMinor: 80_000_00 }],
        idealCustomerProfile: { industries: ["Healthcare"], companySizes: [], regions: [], requiredSignals: [], disqualifiers: [] },
        approvedClaims: [], prohibitedClaims: [], caseStudies: [],
    });
    await request(app).put("/api/v1/policies").set(owner.auth).send(p);
    return owner;
}

const lead = async (auth: Record<string, string>, email = "priya@acmedental.test") =>
    (await request(app).post("/api/v1/leads").set(auth).send({ companyName: "Acme Dental", contactName: "Priya", contactEmail: email, consentBasis: "legitimate_interest", industry: "Healthcare", country: "India" })).body.data.lead._id as string;

test("end to end: import → research → outreach → reply (duplicate webhook) → requirements → demo → proposal → acceptance → handoff", async () => {
    fakeLlm(FIX);
    const mailbox = fakeMailbox();
    const owner = await workspace("E2E");
    const conn = (await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromName: "Pixel", fromEmail: "hi@pixel.test", host: "smtp.pixel.test", port: 587, user: "hi@pixel.test", password: "pw" })).body.data;

    // intake: normalized and deduplicated
    const imp = await request(app).post("/api/v1/leads/import").set(owner.auth).set("Idempotency-Key", "e2e").send({ rows: [
        { companyName: "Acme Dental", contactName: "Priya", contactEmail: "Priya@AcmeDental.test", industry: "Healthcare", consentBasis: "legitimate_interest", country: "India" },
        { companyName: "Acme Dental again", contactEmail: "priya@acmedental.test" },
    ] });
    assert.deepEqual([imp.body.data.job.createdRows, imp.body.data.job.duplicateRows], [1, 1]);
    const leadId = String((await Lead.findOne({ organizationId: owner.organizationId }).lean())!._id);

    // research → qualification → outreach, traced back to the request that started it
    const run = await request(app).post(`/api/v1/leads/${leadId}/run`).set(owner.auth).set("X-Request-Id", "e2e-request-0001");
    assert.equal(run.headers["x-request-id"], "e2e-request-0001");
    assert.equal((await Workflow.findById(run.body.data.workflowId).setOptions({ crossTenant: true }))!.correlationId, "e2e-request-0001");
    await runOnce();
    assert.equal(mailbox.length, 1);
    const sent = await Message.findOne({ organizationId: owner.organizationId, kind: "outreach" }).lean();

    // the provider delivers the same reply twice
    const body = JSON.stringify({ events: [{ type: "inbound", id: "in-1", messageId: "<r1@acme>", from: "priya@acmedental.test", subject: "Re: booking", text: "Yes, interested in online booking!", inReplyTo: sent!.providerMessageId }] });
    const sig = createHmac("sha256", conn.webhookSecret).update(body).digest("hex");
    for (let i = 0; i < 2; i++) await request(app).post(`/api/webhooks/email/${conn.integration._id}`).set("Content-Type", "application/json").set("X-EasySales-Signature", sig).send(body);
    await runOnce();
    assert.equal(await Message.countDocuments({ organizationId: owner.organizationId, direction: "inbound" }), 1, "no duplicate inbound");

    // requirements → demo → publish
    await request(app).post(`/api/v1/opportunities/${leadId}/requirements/extract`).set(owner.auth);
    await runOnce();
    const proto = await request(app).post(`/api/v1/opportunities/${leadId}/prototypes`).set(owner.auth).set("Idempotency-Key", "e2e-proto").send({});
    assert.equal(proto.status, 202);
    await runOnce();
    const pub = await request(app).post(`/api/v1/prototypes/${proto.body.data.prototype._id}/publish`).set(owner.auth);
    assert.equal((await request(app).get(new URL(pub.body.data.prototype.previewUrl).pathname)).status, 200);

    // proposal (inside policy, sent automatically) → acceptance → handoff
    const prop = await request(app).post(`/api/v1/opportunities/${leadId}/proposals`).set(owner.auth).send({ services: ["Booking website"], prototypeId: proto.body.data.prototype._id });
    await runOnce();
    const pid = prop.body.data.proposal._id;
    assert.equal((await request(app).post(`/api/v1/proposals/${pid}/send`).set(owner.auth)).body.data.decision, "allow");
    await runOnce();
    assert.equal((await request(app).patch(`/api/v1/proposals/${pid}`).set(owner.auth).send({ status: "accepted" })).status, 400, "acceptance is never a plain status edit");
    assert.equal((await request(app).patch(`/api/v1/leads/${leadId}`).set(owner.auth).send({ opportunityStage: "won" })).status, 409);
    assert.equal((await request(app).post(`/api/v1/opportunities/${leadId}/handoff`).set(owner.auth).send({})).status, 409, "no handoff before acceptance");
    await request(app).post(`/api/v1/proposals/${pid}/record-acceptance`).set(owner.auth).send({ acceptedBy: "Priya", evidence: "Replied go ahead" });
    const h1 = await request(app).post(`/api/v1/opportunities/${leadId}/handoff`).set(owner.auth).send({ notes: "Kick-off Monday" });
    const h2 = await request(app).post(`/api/v1/opportunities/${leadId}/handoff`).set(owner.auth).send({});
    assert.equal(h1.status, 200);
    assert.equal(h1.body.data.package.proposal.totalMinor, 80_000_00);
    assert.equal(h1.body.data.package.requirements.title, "Clinic booking");
    assert.equal(h2.body.data.handoff.at, h1.body.data.handoff.at, "handoff is idempotent");
    assert.equal((await Lead.findById(leadId).setOptions({ crossTenant: true }))!.opportunityStage, "won");
    assert.equal(await AuditEvent.countDocuments({ organizationId: owner.organizationId, action: "deal.handoff" }), 1);

    // every unit of work is metered; nothing is left held
    const usage = (await request(app).get("/api/v1/organization/usage").set(owner.auth)).body.data;
    assert.equal(usage.funnel.contacted, 1);
    assert.equal(usage.funnel.meaningfulReplies, 1);
    assert.equal(usage.funnel.prototypesBuilt, 1);
    assert.equal(usage.funnel.prototypeViews, 1);
    assert.equal(usage.funnel.proposalsSent, 1);
    assert.equal(usage.funnel.dealsWon, 1);
    assert.ok(usage.usage.llm.quantity >= 5 && usage.usage.email.quantity >= 2 && usage.usage.prototype.costMinor === DEFAULT_POLICY.prototypes.costPerAttemptMinor);
    assert.ok(usage.costPerWonDealMinor > 0);
    assert.equal(usage.spend.total.reservedMinor, 0, "all reservations settled");
    assert.equal(usage.spend.total.committedMinor, usage.costMinor, "counter matches the ledger");
});

test("budget reservations are atomic: parallel requests never exceed the limit", async () => {
    const owner = await workspace("Race", policy((p) => ({ ...p, budgets: { ...p.budgets, monthlySpendMinor: 1000 } })));
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(owner.organizationId, "llm", 300)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof SpendLimitError));
    const held = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ _id: mongoose.Types.ObjectId }>).value;
    await settle(owner.organizationId, held._id, 120);
    await settle(owner.organizationId, held._id, 999);
    const snap = await spendSnapshot(owner.organizationId);
    assert.deepEqual([snap.total.committedMinor, snap.total.reservedMinor], [120, 600], "settling twice charges once");
});

test("spend limit: an exhausted budget stops the agent before any model call", async () => {
    const calls = fakeLlm(FIX);
    fakeMailbox();
    const owner = await workspace("Broke", policy((p) => ({ ...p, budgets: { ...p.budgets, monthlySpendMinor: 0 } })));
    const id = await lead(owner.auth);
    const run = await request(app).post(`/api/v1/leads/${id}/run`).set(owner.auth);
    await runOnce();
    const wf = await Workflow.findById(run.body.data.workflowId).setOptions({ crossTenant: true }).lean();
    assert.equal(wf!.status, "failed");
    assert.equal(wf!.failureCode, "BUDGET_EXCEEDED");
    assert.equal(calls.length, 0);
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "alert.budget_exhausted" }));
});

test("feature flags: operator-only; pilot tenants can run without real email or autonomy", async () => {
    fakeLlm(FIX);
    const mailbox = fakeMailbox();
    const owner = await workspace("Pilot");
    const other = await createAccount("NotAdmin");
    env.ADMIN_EMAILS = owner.email;
    try {
        assert.equal((await request(app).get("/api/admin/feature-flags").set(other.auth)).status, 403);
        assert.equal((await request(app).get("/api/admin/metrics/summary").set(other.auth)).status, 403);
        const set = (key: string, enabled: boolean) => request(app).post("/api/admin/feature-flags").set(owner.auth).send({ key, enabled, organizationId: owner.organizationId });
        assert.equal((await set("live_email", false)).status, 200);

        const a = await lead(owner.auth, "a@pilot.test");
        await request(app).post(`/api/v1/leads/${a}/run`).set(owner.auth);
        await runOnce();
        const m = await Message.findOne({ organizationId: owner.organizationId, leadId: a, kind: "outreach" }).lean();
        assert.equal(m!.status, "sent");
        assert.match(m!.providerMessageId!, /@easysales\.test>$/);
        assert.equal(mailbox.length, 0, "nothing reached a real inbox");

        await set("auto_send", false);
        const b = await lead(owner.auth, "b@pilot.test");
        await request(app).post(`/api/v1/leads/${b}/run`).set(owner.auth);
        await runOnce();
        const mb = await Message.findOne({ organizationId: owner.organizationId, leadId: b, kind: "outreach" }).lean();
        assert.equal(mb!.status, "pending_approval", "policy allows, the pilot flag still asks a human");

        await set("prototypes", false);
        const denied = await request(app).post(`/api/v1/opportunities/${b}/prototypes`).set(owner.auth).set("Idempotency-Key", "f1").send({});
        assert.ok(denied.body.data.reasons.some((r: string) => r.includes("not enabled")));

        const metrics = (await request(app).get("/api/admin/metrics/summary").set(owner.auth)).body.data;
        assert.ok(metrics.queue.byStatus && metrics.api.last5m.requests > 0 && metrics.usage24h.llm.quantity > 0);
    } finally {
        env.ADMIN_EMAILS = "";
    }
});

test("workers revalidate tenant ownership; concurrency limits defer instead of failing", async () => {
    const calls = fakeLlm(FIX);
    const a = await workspace("TenantA");
    const b = await workspace("TenantB");
    const victim = await lead(b.auth, "v@b.test");
    // a forged job: tenant A's workflow pointing at tenant B's lead
    await Workflow.create({ organizationId: a.organizationId, type: "lead.research", entityType: "lead", entityId: victim, idempotencyKey: "forged", correlationId: "forged", maxAttempts: 1 });
    await runOnce();
    assert.equal(calls.length, 0, "no model call on another tenant's data");
    assert.equal((await Lead.findById(victim).setOptions({ crossTenant: true }))!.status, "new");

    const c = await workspace("Busy", policy((p) => ({ ...p, budgets: { ...p.budgets, maxConcurrentResearch: 1 } })));
    const [l1, l2] = [await lead(c.auth, "1@c.test"), await lead(c.auth, "2@c.test")];
    await Workflow.create({ organizationId: c.organizationId, type: "lead.research", entityType: "lead", entityId: l1, idempotencyKey: "running", correlationId: "x", status: "running", lockedUntil: new Date(Date.now() + 600_000) });
    const r2 = await request(app).post(`/api/v1/leads/${l2}/research`).set(c.auth);
    await runOnce();
    const wf = await Workflow.findById(r2.body.data.jobId).setOptions({ crossTenant: true }).lean();
    assert.equal(wf!.status, "queued");
    assert.equal(wf!.attempts, 0, "deferral does not burn an attempt");
});

test("ops: health endpoints, abnormal spend alert, secrets redacted from logs", async () => {
    const live = await request(app).get("/api/health/live");
    const ready = await request(app).get("/api/health/ready");
    assert.equal(live.status, 200);
    assert.equal(ready.status, 200);
    assert.ok(!JSON.stringify(ready.body).match(/mongodb|secret|key/i), "nothing internal disclosed");

    const owner = await workspace("Spender", policy((p) => ({ ...p, budgets: { ...p.budgets, monthlySpendMinor: 1000_00 } })));
    await UsageRecord.create({ organizationId: owner.organizationId, kind: "llm", costMinor: 400_00 });
    await runOpsChecks();
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "alert.abnormal_spend" }));

    let out = "";
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, new Writable({ write(c, _e, cb) { out += c; cb(); } }));
    log.info({ password: "hunter2", smtp: { pass: "smtp-pass" }, req: { headers: { authorization: "Bearer tok-123" } }, integration: { webhookSecret: "whsec" } }, "x");
    for (const s of ["hunter2", "smtp-pass", "tok-123", "whsec"]) assert.ok(!out.includes(s), s);
});

test("tenant purge removes every tenant collection, export never contains secrets", async () => {
    fakeLlm(FIX);
    const owner = await workspace("Leaving");
    await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromName: "X", fromEmail: "x@leaving.test", host: "smtp.leaving.test", port: 587, user: "x", password: "super-secret-pw" });
    await reserve(owner.organizationId, "llm", 10);
    const exp = await request(app).get("/api/v1/organization/export").set(owner.auth);
    const dump = JSON.stringify(exp.body);
    assert.ok(!dump.includes("passwordEnc") && !dump.includes("webhookSecretEnc"), "secrets are never exported");
    assert.ok(exp.body.spendcounters && exp.body.emailintegrations, "new collections are part of the export");

    const org = await Organization.findById(owner.organizationId).lean();
    assert.equal((await request(app).delete("/api/v1/organization").set(owner.auth).send({ confirm: org!.name })).status, 200);
    for (const model of [SpendCounter, Prototype, UsageRecord, Message]) {
        assert.equal(await model.countDocuments({ organizationId: owner.organizationId }).setOptions({ crossTenant: true }), 0, model.modelName);
    }
});
