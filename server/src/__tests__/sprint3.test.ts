import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import { app, createAccount, fakeLlm, fakeMailbox, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { setSmtpVerifier, verifySmtp } from "../modules/private/integrations/integrations.router.js";
import Message from "../shared/models/message.model.js";
import Conversation from "../shared/models/conversation.model.js";
import Lead from "../shared/models/lead.model.js";
import Suppression from "../shared/models/suppression.model.js";
import EmailIntegration from "../shared/models/emailIntegration.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";

const realVerifier = verifySmtp;
before(startDb);
after(stopDb);
beforeEach(() => { resetAlertThrottle(); setSmtpVerifier(async () => undefined); });

const ALL = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const research = { companySummary: "Clinic chain.", industry: "Healthcare", employeeCountEstimate: null, findings: [], criteria: ALL.map((id) => ({ criterionId: id, result: "match", explanation: "x", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] };
const draft = (claimUrl = "lead-record") => ({ subject: "Booking for your clinic", body: "Hi, a short note about online booking for your clinics. Worth a quick chat?", personalizationClaims: [{ claim: "Runs clinics", evidenceUrl: claimUrl }], proposedCallToAction: "Chat", confidence: 0.9, needsReview: false });
const reply = (over: Record<string, unknown> = {}) => ({ intent: "interested", confidence: 0.9, summary: "Interested.", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "Thanks! Would Tuesday work for a quick call?", ...over });

const AUTO = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 50, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };

async function workspace(name: string, leads = 1, policy = AUTO) {
    const owner = await createAccount(name);
    await request(app).put("/api/v1/policies").set(owner.auth).send(policy);
    const ids: string[] = [];
    for (let i = 0; i < leads; i++) {
        const lead = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: `${name} Client ${i}`, contactEmail: `c${i}@${name.toLowerCase()}.test`, consentBasis: "legitimate_interest", industry: "Healthcare" })).body.data.lead;
        await Lead.updateOne({ organizationId: owner.organizationId, _id: lead._id }, { status: "qualified", "qualification.score": 90 - i, "research.status": "done", "research.summary": "Clinic chain." });
        ids.push(lead._id);
    }
    return { owner, ids };
}

async function connect(auth: Record<string, string>) {
    const r = await request(app).post("/api/v1/integrations/email/connect").set(auth).send({ fromName: "Studio", fromEmail: "hello@studio.test", host: "smtp.studio.test", port: 587, user: "hello@studio.test", password: "pw-123" });
    return r.body.data as { integration: { _id: string }; webhookSecret: string };
}

function sign(secret: string, body: unknown) {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac("sha256", secret).update(raw).digest("hex") };
}

const event = (integrationId: string, secret: string, events: unknown[]) => {
    const { raw, sig } = sign(secret, { events });
    return request(app).post(`/api/webhooks/email/${integrationId}`).set("Content-Type", "application/json").set("X-EasySales-Signature", sig).send(raw);
};

test("email integration: verified, encrypted, private hosts refused, owner-only", async () => {
    const { owner } = await workspace("Integr", 0);
    setSmtpVerifier(realVerifier);
    const internal = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromName: "X", fromEmail: "x@x.test", host: "localhost", port: 587, user: "u", password: "p" });
    assert.equal(internal.status, 400);
    assert.match(internal.body.message, /public address|resolved/);
    const badPort = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromName: "X", fromEmail: "x@x.test", host: "smtp.x.test", port: 22, user: "u", password: "p" });
    assert.equal(badPort.status, 400);

    setSmtpVerifier(async () => undefined);
    const { integration, webhookSecret } = await connect(owner.auth);
    assert.ok(webhookSecret.length > 20);
    const stored = await EmailIntegration.findOne({ organizationId: owner.organizationId }).lean();
    assert.notEqual(stored?.smtp?.passwordEnc, "pw-123");
    assert.ok(!stored?.smtp?.passwordEnc.includes("pw-123"), "password encrypted at rest");
    const status = (await request(app).get("/api/v1/integrations/email").set(owner.auth)).body.data.integration;
    assert.equal(status.status, "connected");
    assert.ok(!JSON.stringify(status).includes("passwordEnc"));

    const rep = await createAccount("Rep");
    await request(app).post("/api/v1/organization/members").set(owner.auth).send({ email: rep.email, role: "sales_rep" });
    const asRep = { ...rep.auth, "X-Organization-Id": owner.organizationId };
    assert.equal((await request(app).post("/api/v1/integrations/email/connect").set(asRep).send({})).status, 403);

    assert.equal((await request(app).delete("/api/v1/integrations/email").set(owner.auth)).status, 200);
    assert.equal(await EmailIntegration.countDocuments({ organizationId: owner.organizationId }), 0);
    assert.equal((await request(app).post(`/api/webhooks/email/${integration._id}`).send({ events: [] })).status, 401, "a disconnected account's webhook is dead");
});

test("campaign: audience, daily limit, approval mode, pause cancels pending", async () => {
    fakeLlm({ research, outreach: draft() });
    fakeMailbox();
    const { owner, ids } = await workspace("Camp", 3);
    const created = await request(app).post("/api/v1/campaigns").set(owner.auth).send({ name: "Clinics Q4", audience: { statuses: ["qualified"], minScore: 80, industries: ["healthcare"] }, dailyLimit: 2, followUpDelaysDays: [3] });
    assert.equal(created.status, 201);
    const id = created.body.data.campaign._id;
    const detail = (await request(app).get(`/api/v1/campaigns/${id}`).set(owner.auth)).body.data;
    assert.equal(detail.audience.eligible, 3);

    assert.equal((await request(app).post(`/api/v1/campaigns/${id}/start`).set(owner.auth)).status, 200);
    await runOnce({ force: true });
    await runOnce({ force: true });
    assert.equal(await Lead.countDocuments({ organizationId: owner.organizationId, campaignId: id }), 2, "daily limit respected");
    // campaign autoSend is off, so even with the policy in auto mode every message waits for a human
    const pending = await Message.find({ organizationId: owner.organizationId, campaignId: id }).lean();
    assert.equal(pending.length, 2);
    assert.ok(pending.every((m) => m.status === "pending_approval"));

    await request(app).post(`/api/v1/campaigns/${id}/pause`).set(owner.auth);
    const after = await Message.find({ organizationId: owner.organizationId, campaignId: id }).lean();
    assert.ok(after.every((m) => m.status === "rejected" && m.error === "Campaign paused"));
    assert.equal((await request(app).get("/api/v1/approvals").set(owner.auth)).body.data.approvals.length, 0);
    assert.ok(ids.length === 3);

    const stats = (await request(app).get(`/api/v1/campaigns/${id}?days=7`).set(owner.auth)).body.data.analytics;
    assert.equal(stats.enrolled, 2);
    assert.equal(stats.blockedByPolicy, 2);
    assert.equal(stats.rates.replyRate.of, "threads contacted");
});

test("follow-ups: scheduled in business days, threaded, and stopped by a reply", async () => {
    fakeLlm({ research, outreach: draft(), follow_up: draft(), conversation: reply() });
    const mailbox = fakeMailbox();
    const { owner } = await workspace("Follow", 1);
    const c = (await request(app).post("/api/v1/campaigns").set(owner.auth).send({ name: "Seq", audience: { statuses: ["qualified"], minScore: 0 }, autoSend: true, followUpDelaysDays: [3, 4] })).body.data.campaign;
    await request(app).post(`/api/v1/campaigns/${c._id}/start`).set(owner.auth);
    await runOnce({ force: true });
    await runOnce({ force: true });
    assert.equal(mailbox.length, 1, "auto campaign + auto policy sends on its own");
    const conv = await Conversation.findOne({ organizationId: owner.organizationId }).lean();
    assert.equal(conv?.status, "waiting");
    assert.ok(conv?.nextActionAt && conv.nextActionAt.getTime() > Date.now() + 2 * 86400_000, "next step is days away");

    // time passes (both the schedule and the policy's interval clock)
    await Conversation.updateOne({ organizationId: owner.organizationId, _id: conv!._id }, { nextActionAt: new Date(Date.now() - 1000), lastOutboundAt: new Date(Date.now() - 4 * 86400_000) });
    await runOnce({ force: true });
    await runOnce({ force: true });
    assert.equal(mailbox.length, 2, "follow-up sent");
    const first = await Message.findOne({ organizationId: owner.organizationId, kind: "outreach" }).lean();
    assert.equal(mailbox[1].inReplyTo, first?.providerMessageId, "follow-up threads under the first email");

    // a reply stops the sequence before anything else is sent
    await request(app).post(`/api/v1/conversations/${conv!._id}/inbound`).set(owner.auth).send({ body: "Sounds good, tell me more" });
    let fresh = await Conversation.findOne({ organizationId: owner.organizationId, _id: conv!._id }).lean();
    assert.equal(fresh?.nextActionAt, undefined);
    await runOnce({ force: true }); // the reply workflow answers the prospect
    // even if something re-arms the schedule, the stop condition (lead replied) cancels it
    await Conversation.updateOne({ organizationId: owner.organizationId, _id: conv!._id }, { status: "waiting", nextActionAt: new Date(Date.now() - 1000) });
    await runOnce({ force: true });
    fresh = await Conversation.findOne({ organizationId: owner.organizationId, _id: conv!._id }).lean();
    assert.equal(fresh?.nextActionAt, undefined);
    assert.equal(await Message.countDocuments({ organizationId: owner.organizationId, kind: "follow_up" }), 1, "no second follow-up after a reply");
    const cancelled = await AuditEvent.findOne({ organizationId: owner.organizationId, action: "followup.cancelled" }).lean();
    assert.equal((cancelled?.metadata as { reason?: string })?.reason, "Lead replied");
});

test("provider events: delivered, out-of-order safety, hard bounce and complaint stop contact", async () => {
    fakeLlm({ research, outreach: draft() });
    fakeMailbox();
    const { owner, ids } = await workspace("Events", 2);
    const { integration, webhookSecret } = await connect(owner.auth);
    for (const id of ids) await request(app).post(`/api/v1/leads/${id}/run`).set(owner.auth);
    await runOnce();
    const [a, b] = await Message.find({ organizationId: owner.organizationId, kind: "outreach" }).sort({ createdAt: 1 }).lean();

    await event(integration._id, webhookSecret, [
        { type: "bounced", id: "e1", providerMessageId: a.providerMessageId, bounceType: "hard" },
        { type: "delivered", id: "e2", providerMessageId: a.providerMessageId },
        { type: "delivered", id: "e3", providerMessageId: b.providerMessageId },
        { type: "complained", id: "e4", providerMessageId: b.providerMessageId },
    ]);
    await runOnce();
    const ma = await Message.findOne({ organizationId: owner.organizationId, _id: a._id }).lean();
    assert.equal(ma?.status, "bounced", "a late 'delivered' never overwrites a bounce");
    assert.ok(await Suppression.exists({ organizationId: owner.organizationId, value: a.to, reason: "bounce" }));
    assert.ok(await Suppression.exists({ organizationId: owner.organizationId, value: b.to, reason: "complaint" }));
    assert.ok(await AuditEvent.exists({ organizationId: owner.organizationId, action: "alert.complaint" }));
    const conv = await Conversation.findOne({ organizationId: owner.organizationId, _id: b.conversationId }).lean();
    assert.equal(conv?.status, "suppressed");
});

test("conversation intents: auto-replies are never answered, unclear goes to review, complaints suppress", async () => {
    let calls = 0;
    fakeLlm({ research, outreach: draft(), conversation: (u: string) => { calls++; return u.includes("hmm") ? reply({ intent: "unclear", confidence: 0.3, recommendedAction: "escalate", reply: "" }) : reply({ intent: "complaint", recommendedAction: "suppress", reply: "" }); } });
    fakeMailbox();
    const { owner, ids } = await workspace("Intent", 3);
    for (const id of ids) await request(app).post(`/api/v1/leads/${id}/run`).set(owner.auth);
    await runOnce();
    const convs = await Conversation.find({ organizationId: owner.organizationId }).sort({ createdAt: 1 }).lean();

    await request(app).post(`/api/v1/conversations/${convs[0]._id}/inbound`).set(owner.auth).send({ subject: "Automatic reply: Re: Booking", body: "I am away until Monday." });
    await request(app).post(`/api/v1/conversations/${convs[1]._id}/inbound`).set(owner.auth).send({ body: "hmm, who is this?" });
    await request(app).post(`/api/v1/conversations/${convs[2]._id}/inbound`).set(owner.auth).send({ body: "Why are you emailing me? This is spam." });
    await runOnce();

    assert.equal(calls, 2, "the auto-reply never reached the model");
    const [ooo, unclear, complaint] = await Promise.all(convs.map((c) => Conversation.findOne({ organizationId: owner.organizationId, _id: c._id }).lean()));
    assert.equal(ooo?.status, "waiting");
    assert.ok(ooo?.nextActionAt);
    assert.equal(await Message.countDocuments({ organizationId: owner.organizationId, kind: "reply" }), 0, "nothing was auto-answered");
    assert.equal(unclear?.status, "needs_review");
    assert.equal(complaint?.status, "suppressed");
    const queue = (await request(app).get("/api/v1/review-queue").set(owner.auth)).body.data;
    assert.equal(queue.threads.length, 1);
    assert.equal(String(queue.threads[0]._id), String(convs[1]._id));
});

test("drafts: unverified personalisation goes to review; uncertain sends are reconciled, never resent blindly", async () => {
    fakeLlm({ research, outreach: draft("https://made-up.example/about") });
    fakeMailbox();
    const { owner, ids } = await workspace("Drafts", 1);
    const d = (await request(app).post(`/api/v1/leads/${ids[0]}/outreach-drafts`).set(owner.auth)).body.data.draft;
    assert.equal(d.status, "draft");
    assert.equal(d.claims[0].verified, false);
    const sent = await request(app).post(`/api/v1/outbound-actions/${d._id}/send`).set(owner.auth).send({});
    assert.equal(sent.body.data.status, "pending_approval");
    assert.ok(sent.body.data.reasons.some((r: string) => r.includes("not backed by research")));

    await Message.updateOne({ organizationId: owner.organizationId, _id: d._id }, { status: "uncertain" });
    const rec = await request(app).post(`/api/v1/outbound-actions/${d._id}/reconcile`).set(owner.auth).send({ outcome: "not_sent" });
    assert.equal(rec.body.data.action.status, "queued");
    assert.equal((await request(app).post(`/api/v1/outbound-actions/${d._id}/reconcile`).set(owner.auth).send({ outcome: "was_sent" })).status, 409);
});

test("hourly sending limit is enforced", async () => {
    fakeLlm({ research, outreach: draft() });
    fakeMailbox();
    const { owner, ids } = await workspace("Hourly", 2, { ...AUTO, outreach: { ...AUTO.outreach, maxPerHour: 1 } });
    for (const id of ids) {
        await request(app).post(`/api/v1/leads/${id}/run`).set(owner.auth);
        await runOnce();
    }
    const msgs = await Message.find({ organizationId: owner.organizationId, kind: "outreach" }).sort({ createdAt: 1 }).lean();
    assert.equal(msgs[0].status, "sent");
    assert.equal(msgs[1].status, "rejected");
    assert.match(msgs[1].error ?? "", /Hourly sending limit/);
});

test("cross-tenant: campaigns, outbound actions, threads and webhooks stay inside their tenant", async () => {
    fakeLlm({ research, outreach: draft() });
    fakeMailbox();
    const a = await workspace("TenA", 1);
    const b = await workspace("TenB", 0);
    await request(app).post(`/api/v1/leads/${a.ids[0]}/run`).set(a.owner.auth);
    await runOnce();
    const msgA = await Message.findOne({ organizationId: a.owner.organizationId, kind: "outreach" }).lean();
    const campA = (await request(app).post("/api/v1/campaigns").set(a.owner.auth).send({ name: "A only", audience: { statuses: ["qualified"] } })).body.data.campaign;

    for (const [method, path] of [
        ["get", `/api/v1/campaigns/${campA._id}`], ["post", `/api/v1/campaigns/${campA._id}/start`], ["post", `/api/v1/campaigns/${campA._id}/pause`],
        ["get", `/api/v1/outbound-actions/${msgA?._id}`], ["post", `/api/v1/outbound-actions/${msgA?._id}/reconcile`],
        ["post", `/api/v1/conversations/${msgA?.conversationId}/close`], ["post", `/api/v1/conversations/${msgA?.conversationId}/assign`],
        ["get", `/api/v1/conversations/${msgA?.conversationId}/activity`], ["post", `/api/v1/recipients/${a.ids[0]}/suppress`],
        ["post", `/api/v1/leads/${a.ids[0]}/outreach-drafts`],
    ] as const) {
        const r = await (request(app)[method](path).set(b.owner.auth).send(method === "post" ? (path.endsWith("reconcile") ? { outcome: "not_sent" } : {}) : undefined));
        assert.equal(r.status, 404, `${method} ${path}`);
    }
    // B's signed webhook cannot touch A's message, even with A's provider id
    const { integration, webhookSecret } = await connect(b.owner.auth);
    await event(integration._id, webhookSecret, [{ type: "bounced", id: "x1", providerMessageId: msgA?.providerMessageId, bounceType: "hard" }]);
    await runOnce();
    assert.equal((await Message.findOne({ organizationId: a.owner.organizationId, _id: msgA?._id }).lean())?.status, "sent");
    assert.equal(await Suppression.countDocuments({ organizationId: a.owner.organizationId }), 0);
});
