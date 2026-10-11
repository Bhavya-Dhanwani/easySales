import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { setSmtpVerifier } from "../modules/private/integrations/integrations.router.js";
import { healthCheckIntegrations } from "../modules/private/integrations/integrations.router.js";
import { entitlementsFor, rollOverSubscriptions, QUOTA_HOLD } from "../shared/billing/subscription.service.js";
import env from "../shared/config/env.config.js";
import Plan from "../shared/models/plan.model.js";
import { Subscription } from "../shared/models/subscription.model.js";
import Message from "../shared/models/message.model.js";
import FunnelEvent from "../shared/models/funnelEvent.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";
import EmailIntegration from "../shared/models/emailIntegration.model.js";

before(startDb);
after(stopDb);
beforeEach(() => { resetAlertThrottle(); setSmtpVerifier(async () => undefined); });

const CRITERIA = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const FIX = {
    research: { companySummary: "Clinic.", industry: "Healthcare", employeeCountEstimate: 30, findings: [], criteria: CRITERIA.map((id) => ({ criterionId: id, result: "match", explanation: "x", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] },
    outreach: { subject: "Booking", body: "Hi, would online booking help your clinic? Happy to share how others do it.", personalizationClaims: [], proposedCallToAction: "Reply", confidence: 0.9, needsReview: false },
};
const AUTO = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 100, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };

const connect = (auth: Record<string, string>) => request(app).post("/api/v1/integrations/email/connect").set(auth).send({ fromName: "Studio", fromEmail: "hi@studio.test", host: "smtp.studio.test", port: 587, user: "hi@studio.test", password: "pw-secret-123" });
const lead = async (auth: Record<string, string>, i: number) =>
    (await request(app).post("/api/v1/leads").set(auth).send({ companyName: `Clinic ${i}`, contactEmail: `c${i}@clinic${i}.test`, consentBasis: "legitimate_interest", industry: "Healthcare" })).body.data.lead._id as string;

function sign(body: unknown) {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac("sha256", env.BILLING_WEBHOOK_SECRET).update(raw).digest("hex") };
}
const billing = (body: unknown, sig?: string) => {
    const s = sign(body);
    return request(app).post("/api/webhooks/billing").set("Content-Type", "application/json").set("X-EasySales-Signature", sig ?? s.sig).send(s.raw);
};

test("self-service onboarding: resumable, rehearsed safely, nothing real is contacted before activation", async () => {
    fakeLlm(FIX);
    const mailbox = fakeMailbox();
    const owner = await createAccount("Newco", { activated: false });
    let st = (await request(app).get("/api/v1/onboarding/status").set(owner.auth)).body.data;
    assert.equal(st.currentStep, "organization");
    assert.equal(st.subscription.status, "trialing");

    // a real prospect cannot be contacted yet, even with auto-send on
    await request(app).put("/api/v1/policies").set(owner.auth).send(AUTO);
    const early = await lead(owner.auth, 1);
    await request(app).post(`/api/v1/leads/${early}/run`).set(owner.auth);
    await runOnce();
    const blocked = await Message.findOne({ organizationId: owner.organizationId, leadId: early }).lean();
    assert.equal(blocked!.status, "rejected");
    assert.match(blocked!.error!, /not activated/);
    assert.equal(mailbox.length, 0);

    assert.equal((await request(app).post("/api/v1/onboarding/activate").set(owner.auth)).status, 409, "cannot skip setup");
    await request(app).put("/api/v1/onboarding/organization").set(owner.auth).send({ name: "Newco Studio", industry: "Web agency", timezone: "Asia/Kolkata" });
    await request(app).put("/api/v1/onboarding/business-profile").set(owner.auth).send({
        businessName: "Newco Studio", description: "Booking websites for clinics.", services: [{ name: "Booking website", basePriceMinor: 50_000_00 }],
        brandVoice: "warm", approvedClaims: ["Built 10 booking sites"], prohibitedClaims: [],
    });
    // interrupted here: coming back resumes at the next unfinished step
    st = (await request(app).get("/api/v1/onboarding/status").set(owner.auth)).body.data;
    assert.equal(st.currentStep, "icp");
    assert.deepEqual(st.steps.filter((s: { done: boolean }) => s.done).map((s: { step: string }) => s.step), ["organization", "business", "voice"]);

    await request(app).put("/api/v1/onboarding/icp").set(owner.auth).send({ idealCustomerProfile: { industries: ["Healthcare"], companySizes: [], regions: ["India"], requiredSignals: [], disqualifiers: [] } });
    assert.equal((await request(app).post("/api/v1/onboarding/test-run").set(owner.auth)).status, 409, "test run needs email and limits first");
    await connect(owner.auth);
    await request(app).put("/api/v1/onboarding/limits").set(owner.auth).send({ monthlySpendMinor: 2000_00, maxNewContactsPerDay: 10, maxPerHour: 5, autoSend: true });
    const v = (await request(app).post("/api/v1/onboarding/validate").set(owner.auth)).body.data;
    assert.deepEqual(v.issues.map((i: { step: string }) => i.step), ["test_run"]);

    // the rehearsal goes only to the user themself and never counts as a prospect
    const run = await request(app).post("/api/v1/onboarding/test-run").set(owner.auth);
    assert.equal(run.status, 202);
    await runOnce();
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].to, owner.email);
    assert.equal(await FunnelEvent.countDocuments({ organizationId: owner.organizationId, leadId: run.body.data.leadId }).setOptions({ crossTenant: true }), 0);

    const act = await request(app).post("/api/v1/onboarding/activate").set(owner.auth);
    assert.equal(act.status, 200);
    assert.ok(act.body.data.activatedAt);
    assert.equal(act.body.data.currentStep, null);
    const real = await lead(owner.auth, 2);
    await request(app).post(`/api/v1/leads/${real}/run`).set(owner.auth);
    await runOnce();
    assert.equal(mailbox.length, 2, "after activation real outreach follows policy");
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "organization.activate" }));

    // another workspace's onboarding is its own
    const other = await createAccount("Elsewhere", { activated: false });
    assert.equal((await request(app).get("/api/v1/onboarding/status").set(other.auth)).body.data.currentStep, "organization");
});

test("plans and entitlements: versioned, enforced by API and workers, independent of spending limits", async () => {
    fakeLlm(FIX);
    const mailbox = fakeMailbox();
    const operator = await createAccount("PlanOps");
    const owner = await createAccount("Tiny");
    await request(app).put("/api/v1/policies").set(owner.auth).send(AUTO);
    env.ADMIN_EMAILS = operator.email;
    env.BILLING_WEBHOOK_SECRET = "test-billing-secret-0123456789";
    try {
        const tiny = await request(app).post("/api/admin/plans").set(operator.auth).send({ key: "tiny", name: "Tiny", priceMinorUnits: 0, entitlements: { maxMembers: 1, researchJobsPerMonth: 1, emailSendsPerMonth: 1, prototypeBuildsPerMonth: 0, analyticsLevel: "basic", apiAccess: false } });
        assert.equal(tiny.body.data.plan.version, 1);
        await assert.rejects(Plan.updateOne({ key: "tiny" }, { priceMinorUnits: 1 }), /immutable/);
        assert.equal((await request(app).post(`/api/admin/organizations/${owner.organizationId}/subscription`).set(operator.auth).send({ planKey: "tiny", status: "active", periodDays: 30, note: "pilot" })).status, 200);
        // changing the plan later does not change what this subscription was granted
        await request(app).post("/api/admin/plans").set(operator.auth).send({ key: "tiny", name: "Tiny", priceMinorUnits: 0, entitlements: { maxMembers: 9, researchJobsPerMonth: 9, emailSendsPerMonth: 9, prototypeBuildsPerMonth: 9, analyticsLevel: "advanced", apiAccess: true } });
        assert.equal((await entitlementsFor(owner.organizationId)).entitlements.maxMembers, 1);

        assert.equal((await request(app).post("/api/v1/organization/members").set(owner.auth).send({ email: "x@tiny.test", role: "sales_rep" })).status, 402);
        assert.equal((await request(app).get("/api/v1/analytics/costs").set(owner.auth)).status, 402, "advanced analytics are a plan feature");

        const [a, b] = [await lead(owner.auth, 1), await lead(owner.auth, 2)];
        await request(app).post(`/api/v1/leads/${a}/run`).set(owner.auth);
        await runOnce();
        assert.equal(mailbox.length, 1);
        assert.equal((await request(app).post(`/api/v1/leads/${b}/research`).set(owner.auth)).status, 402, "API refuses research over quota");

        // the worker enforces too: an email over quota is held, not sent and not dropped
        await request(app).post(`/api/v1/leads/${b}/run`).set(owner.auth);
        await Subscription.updateOne({ organizationId: owner.organizationId }, { entitlements: { maxMembers: 1, researchJobsPerMonth: 5, emailSendsPerMonth: 1, prototypeBuildsPerMonth: 0, analyticsLevel: "basic", apiAccess: false } }).setOptions({ crossTenant: true });
        await runOnce();
        const held = await Message.findOne({ organizationId: owner.organizationId, leadId: b, kind: "outreach" }).lean();
        assert.equal(held!.status, "queued");
        assert.equal(held!.error, QUOTA_HOLD);
        assert.equal(mailbox.length, 1);
        const denied = await request(app).post(`/api/v1/opportunities/${a}/prototypes`).set(owner.auth).set("Idempotency-Key", "q1").send({});
        assert.ok(denied.body.data.reasons.some((r: string) => r.includes("Plan limit")));

        // a paid upgrade (via the signed webhook) releases held work
        await billing({ id: "evt-up", type: "subscription.activated", organizationId: owner.organizationId, planKey: "growth", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400_000) });
        await runOnce();
        assert.equal(mailbox.length, 2);

        // spending limits are a separate brake: plenty of quota, no money left → stopped for budget, not quota
        await request(app).put("/api/v1/policies").set(owner.auth).send({ ...AUTO, budgets: { ...DEFAULT_POLICY.budgets, monthlySpendMinor: 0 } });
        const c = await lead(owner.auth, 3);
        await request(app).post(`/api/v1/leads/${c}/research`).set(owner.auth);
        await runOnce();
        const wf = (await request(app).get(`/api/v1/research-jobs`).set(owner.auth)).body.data.jobs.find((j: { entityId: string }) => j.entityId === c);
        assert.equal(wf.failureCode, "BUDGET_EXCEEDED");
    } finally {
        env.ADMIN_EMAILS = "";
        env.BILLING_WEBHOOK_SECRET = "";
    }
});

test("subscription state cannot be forged; billing webhooks are signed and idempotent; unpaid periods lapse", async () => {
    const owner = await createAccount("Billing");
    env.BILLING_WEBHOOK_SECRET = "test-billing-secret-0123456789";
    try {
        // during the trial the plan can be chosen freely (nothing is paid yet)
        assert.equal((await request(app).post("/api/v1/organization/subscription").set(owner.auth).send({ planKey: "starter" })).body.data.outcome, "changed");
        assert.equal((await request(app).post("/api/v1/organization/subscription").set(owner.auth).send({ planKey: "scale", status: "active" })).status, 400, "clients cannot set status");

        const bad = await billing({ id: "e0", type: "subscription.activated", organizationId: owner.organizationId, periodStart: new Date(), periodEnd: new Date() }, "0".repeat(64));
        assert.equal(bad.status, 401);
        const start = new Date();
        const ev = { id: "e1", type: "subscription.activated", organizationId: owner.organizationId, periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86400_000), customerId: "cus_1" };
        assert.equal((await billing(ev)).body.data.duplicate, false);
        assert.equal((await billing(ev)).body.data.duplicate, true);
        let sub = (await request(app).get("/api/v1/organization/subscription").set(owner.auth)).body.data.subscription;
        assert.deepEqual([sub.status, sub.planKey], ["active", "starter"]);

        // an active subscription's upgrade waits for payment
        const up = (await request(app).post("/api/v1/organization/subscription").set(owner.auth).send({ planKey: "scale" })).body.data;
        assert.equal(up.outcome, "payment_required");
        assert.equal(up.subscription.planKey, "starter");
        await billing({ id: "e2", type: "subscription.renewed", organizationId: owner.organizationId, periodStart: start, periodEnd: new Date(start.getTime() + 30 * 86400_000) });
        sub = (await request(app).get("/api/v1/organization/subscription").set(owner.auth)).body.data.subscription;
        assert.equal(sub.planKey, "scale", "payment confirmed the pending upgrade");

        await billing({ id: "e3", type: "payment.failed", organizationId: owner.organizationId });
        assert.equal((await entitlementsFor(owner.organizationId)).suspended, false, "past_due keeps working during grace");
        await Subscription.updateOne({ organizationId: owner.organizationId }, { status: "active", currentPeriodEnd: new Date(Date.now() - 10 * 86400_000) }).setOptions({ crossTenant: true });
        await rollOverSubscriptions();
        const after = await entitlementsFor(owner.organizationId);
        assert.equal(after.subscription.status, "past_due");
        assert.equal(after.suspended, true, "an unpaid period past grace suspends spending");
        assert.equal(after.entitlements.emailSendsPerMonth, 0);

        await request(app).post("/api/v1/organization/subscription/cancel").set(owner.auth);
        assert.equal((await Subscription.findOne({ organizationId: owner.organizationId }).setOptions({ crossTenant: true }))!.cancelAtPeriodEnd, true);
        assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "subscription.change", actorId: "billing:webhook" }));
    } finally {
        env.BILLING_WEBHOOK_SECRET = "";
    }
});

test("support tools are permission-controlled and audited; credentials never leave; integration health is checked", async () => {
    const owner = await createAccount("Supported");
    const support = await createAccount("Helpdesk");
    const admin = await createAccount("Opsadmin");
    await connect(owner.auth);
    env.SUPPORT_EMAILS = support.email;
    env.ADMIN_EMAILS = admin.email;
    try {
        assert.equal((await request(app).get("/api/admin/organizations").set(owner.auth)).status, 403, "tenant owners are not staff");
        const orgs = (await request(app).get("/api/admin/organizations").set(support.auth)).body.data.organizations;
        assert.ok(orgs.some((o: { id: string; email: string }) => o.id === owner.organizationId && o.email === "connected"));
        const health = await request(app).get(`/api/admin/organizations/${owner.organizationId}/health`).set(support.auth);
        assert.equal(health.status, 200);
        assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "support.view_health" }), "support access is visible to the tenant");
        assert.equal((await request(app).post(`/api/admin/organizations/${owner.organizationId}/subscription`).set(support.auth).send({ planKey: "scale", note: "freebie" })).status, 403, "support is read-only");
        assert.equal((await request(app).post("/api/admin/feature-flags").set(support.auth).send({ key: "auto_send", enabled: false })).status, 403);
        assert.equal((await request(app).post(`/api/admin/organizations/${owner.organizationId}/subscription`).set(admin.auth).send({ periodDays: 30, note: "pilot extension" })).status, 200);

        const list = await request(app).get("/api/v1/integrations").set(owner.auth);
        const dump = JSON.stringify(list.body) + JSON.stringify(health.body);
        assert.ok(!dump.includes("passwordEnc") && !dump.includes("pw-secret-123") && !dump.includes("webhookSecret"));
        assert.equal(list.body.data.integrations[0].status, "connected");

        // the password was revoked at the provider: the scheduled health check notices before a send fails
        setSmtpVerifier(async () => { throw new Error("535 Authentication failed"); });
        await EmailIntegration.updateOne({ organizationId: owner.organizationId }, { lastVerifiedAt: new Date(0) }).setOptions({ crossTenant: true });
        await healthCheckIntegrations();
        const after = (await request(app).get("/api/v1/integrations").set(owner.auth)).body.data.integrations[0];
        assert.equal(after.status, "degraded");
        assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "alert.provider_outage" }));
        assert.equal((await request(app).get("/api/v1/onboarding/status").set(owner.auth)).body.data.steps.find((s: { step: string }) => s.step === "email").done, false);
    } finally {
        env.SUPPORT_EMAILS = "";
        env.ADMIN_EMAILS = "";
    }
});
