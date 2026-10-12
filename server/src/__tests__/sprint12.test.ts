import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, createAccount, fakeInbox, fakeLlm, startDb, stopDb } from "./helpers.js";
import { runOnce } from "../jobs/worker.js";
import { DEFAULT_POLICY } from "../shared/policy/policy.schema.js";
import { resetAlertThrottle } from "../shared/alerts/alert.service.js";
import { setSmtpVerifier } from "../modules/private/integrations/integrations.router.js";
import { setEmailProvider } from "../providers/email.provider.js";
import { setBrevoSender, type BrevoEmail } from "../providers/brevo.js";
import { detectMailServers, setMxResolver } from "../shared/conversations/mailServers.js";
import { conversationFromAddress, replyAddressFor } from "../shared/conversations/replyAddress.js";
import sendMail from "../shared/utils/sendMail.util.js";
import env from "../shared/config/env.config.js";
import Lead from "../shared/models/lead.model.js";
import Message from "../shared/models/message.model.js";
import ProviderEvent from "../shared/models/providerEvent.model.js";
import PlatformInbox from "../shared/models/platformInbox.model.js";
import EmailIntegration from "../shared/models/emailIntegration.model.js";

const PLATFORM = { BREVO_API_KEY: "xkeysib-test", PLATFORM_FROM_EMAIL: "hello@easysales.test", PLATFORM_FROM_NAME: "easySales", PLATFORM_REPLY_EMAIL: "replies@easysales.test", PLATFORM_REPLY_PASSWORD: "app-pass" };
const OFF = { BREVO_API_KEY: "", PLATFORM_FROM_EMAIL: "", PLATFORM_REPLY_EMAIL: "", PLATFORM_REPLY_PASSWORD: "" };

let outbox: BrevoEmail[] = [];
before(startDb);
after(async () => { Object.assign(env, OFF); setMxResolver(null); await stopDb(); });
beforeEach(() => {
    resetAlertThrottle(); fakeInbox(); setEmailProvider(null);
    outbox = [];
    setBrevoSender(async (email) => { outbox.push(email); return { messageId: `<brevo-${outbox.length}@smtp-relay.test>` }; });
});

test("mail servers are detected from the address: known providers, company domains by MX, then smtp./imap.", async () => {
    setMxResolver(async (domain) => ({
        "clinic.in": [{ exchange: "aspmx.l.google.com.", priority: 1 }],
        "studio.in": [{ exchange: "mx.zoho.in", priority: 10 }],
        "shop.in": [{ exchange: "acme-in.mail.protection.outlook.com", priority: 0 }],
    } as Record<string, { exchange: string; priority: number }[]>)[domain] ?? []);
    assert.equal((await detectMailServers("me@gmail.com")).smtpHost, "smtp.gmail.com");
    assert.deepEqual(await detectMailServers("dr@clinic.in"), { provider: "Gmail / Google Workspace", smtpHost: "smtp.gmail.com", smtpPort: 587, secure: false, imapHost: "imap.gmail.com" });
    assert.equal((await detectMailServers("me@studio.in")).smtpHost, "smtp.zoho.in");
    assert.equal((await detectMailServers("me@shop.in")).imapHost, "outlook.office365.com");
    assert.deepEqual(await detectMailServers("me@unknown.example"), { provider: "unknown.example", smtpHost: "smtp.unknown.example", smtpPort: 587, secure: false, imapHost: "imap.unknown.example" });
});

test("connecting a mailbox needs only the email and its app password", async () => {
    let used: { host: string; port: number; secure: boolean; user: string } | undefined;
    setSmtpVerifier(async (smtp) => { used = smtp; });
    const owner = await createAccount("Simple");
    const r = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromEmail: "owner@gmail.com", password: "abcd efgh ijkl mnop" });
    assert.equal(r.status, 200);
    assert.deepEqual(used, { host: "smtp.gmail.com", port: 587, secure: false, user: "owner@gmail.com" });
    const stored = await EmailIntegration.findOne({ organizationId: owner.organizationId }).lean();
    assert.equal(stored?.imap?.host, "imap.gmail.com");
    assert.ok(stored?.fromName, "sender name filled from the business");

    // a wrong password explains app passwords
    setSmtpVerifier(async () => { throw new Error("535-5.7.8 Username and Password not accepted"); });
    const bad = await request(app).post("/api/v1/integrations/email/connect").set(owner.auth).send({ fromEmail: "owner@gmail.com", password: "normal-password" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /app password/);
});

test("reply addresses are signed: forged or foreign addresses route nowhere", () => {
    Object.assign(env, PLATFORM);
    const id = "6aca696f24ac249b0bc1932c";
    const address = replyAddressFor(id);
    assert.match(address, /^replies\+r-6aca696f24ac249b0bc1932c\.[0-9a-f]{16}@easysales\.test$/);
    assert.equal(conversationFromAddress(address), id);
    assert.equal(conversationFromAddress(address.toUpperCase()), id, "case-insensitive (mail systems may change case)");
    assert.equal(conversationFromAddress(address.replace(/\.[0-9a-f]{16}@/, ".0000000000000000@")), null, "forged signature");
    assert.equal(conversationFromAddress(address.replace("6aca696f24ac249b0bc1932c", "6aca696f24ac249b0bc1932d")), null, "someone else's conversation");
    assert.equal(conversationFromAddress(address.replace("@easysales.test", "@evil.test")), null, "another domain");
    Object.assign(env, OFF);
});

const ALL = ["industry", "company_size", "service_need", "geography", "budget", "contact_relevance"];
const research = { companySummary: "Clinic.", industry: "Healthcare", employeeCountEstimate: null, findings: [], criteria: ALL.map((c) => ({ criterionId: c, result: "match", explanation: "x", evidenceUrls: ["lead-record"] })), potentialNeeds: [], disqualifiers: [], conflicts: [] };
const draft = { subject: "Online booking for your clinic", body: "Hi, a short note about online booking for your clinic. Worth a quick chat?", personalizationClaims: [{ claim: "Runs a clinic", evidenceUrl: "lead-record" }], proposedCallToAction: "Chat", confidence: 0.9, needsReview: false };
const AUTO = { ...DEFAULT_POLICY, outreach: { ...DEFAULT_POLICY.outreach, autoSend: true, maxPerHour: 50, quietHours: { ...DEFAULT_POLICY.outreach.quietHours, enabled: false } } };
const mail = (from: string, to: string, subject: string, body: string) =>
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@mail.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\n${body}`;

test("skipping the mailbox: mail goes from the platform address (Brevo), replies come back through the signed reply inbox", async () => {
    Object.assign(env, PLATFORM);
    fakeLlm({ research, outreach: draft, follow_up: draft, conversation: { intent: "interested", confidence: 0.9, summary: "Interested.", extractedFacts: [], recommendedAction: "reply", returnDate: "", reply: "Great, does Tuesday work?" } });
    const inbox = fakeInbox({ uidValidity: 3, messages: [] });
    const owner = await createAccount("Skipper");
    assert.match(outbox[0]?.subject ?? "", /is your easySales code$/, "the sign-up email itself went through Brevo");
    outbox = [];
    await request(app).put("/api/v1/policies").set(owner.auth).send(AUTO);
    const lead = (await request(app).post("/api/v1/leads").set(owner.auth).send({ companyName: "Bright Clinic", contactEmail: "dr@brightclinic.test", consentBasis: "legitimate_interest" })).body.data.lead;
    await Lead.updateOne({ organizationId: owner.organizationId, _id: lead._id }, { status: "qualified", "qualification.score": 90, "research.status": "done", "research.summary": "Clinic." });

    const info = (await request(app).get("/api/v1/integrations/email").set(owner.auth)).body.data;
    assert.equal(info.integration, null, "no own mailbox");
    assert.match(info.platform.name, / via easySales$/);

    const camp = (await request(app).post("/api/v1/campaigns").set(owner.auth).send({ name: "Seq", audience: { statuses: ["qualified"], minScore: 0 }, autoSend: true })).body.data.campaign;
    await request(app).post(`/api/v1/campaigns/${camp._id}/start`).set(owner.auth);
    await runOnce({ force: true });
    await runOnce({ force: true });
    assert.equal(outbox.length, 1, "sent through Brevo");
    const sent = outbox[0];
    assert.deepEqual(sent.to, [{ email: "dr@brightclinic.test" }]);
    assert.equal(sent.sender.email, "hello@easysales.test");
    assert.match(sent.sender.name, / via easySales$/);
    const outbound = await Message.findOne({ organizationId: owner.organizationId, direction: "outbound" }).lean();
    assert.equal(outbound?.providerMessageId, "<brevo-1@smtp-relay.test>", "Brevo's Message-ID is kept for threading");
    assert.equal(sent.replyTo?.email, replyAddressFor(String(outbound!.conversationId)));
    assert.match(sent.headers?.["List-Unsubscribe"] ?? "", /^<mailto:replies\+r-/);

    // the reply inbox: a forged address and unrelated mail are never downloaded; the real reply is routed
    const forged = sent.replyTo!.email.replace(/\.[0-9a-f]{16}@/, ".0000000000000000@");
    inbox.state.messages.push(
        { uid: 1, from: "spam@else.test", to: "replies@easysales.test", raw: mail("spam@else.test", "replies@easysales.test", "Hi", "buy now") },
        { uid: 2, from: "dr@brightclinic.test", to: forged, raw: mail("dr@brightclinic.test", forged, "Re: x", "forged") },
        { uid: 3, from: "dr@brightclinic.test", to: sent.replyTo!.email, raw: mail("Dr <dr@brightclinic.test>", sent.replyTo!.email, "Re: Online booking for your clinic", "Yes please, tell me more.") },
    );
    await PlatformInbox.updateOne({ key: "replies" }, { $set: { uidValidity: "3", lastUid: 0, lastPolledAt: new Date(0) } }, { upsert: true });
    await runOnce({ force: true }); // poll
    await runOnce({ force: true }); // process and answer
    assert.deepEqual(inbox.downloaded, [3], "only the signed reply was downloaded");
    const events = await ProviderEvent.find({}).setOptions({ crossTenant: true }).lean();
    assert.deepEqual(events.map((e) => String(e.organizationId)), [String(owner.organizationId)], "routed to the right workspace");
    const reply = await Message.findOne({ organizationId: owner.organizationId, direction: "inbound" }).lean();
    assert.equal(String(reply?.conversationId), String(outbound!.conversationId));
    assert.match(reply?.body ?? "", /tell me more/);
    Object.assign(env, OFF);
});

test("without Brevo, the SMTP account in .env is the platform address; replies read from that same mailbox", async () => {
    const { default: transporter } = await import("../shared/config/mail.config.js");
    const sent: Record<string, unknown>[] = [];
    const original = transporter.sendMail.bind(transporter);
    (transporter as unknown as { sendMail: (m: Record<string, unknown>) => Promise<unknown> }).sendMail = async (m) => { sent.push(m); return { messageId: String(m.messageId) }; };
    Object.assign(env, OFF, { SMTP_USER: "owner.mail@gmail.com", SMTP_PASS: "app-pass" });
    try {
        const owner = await createAccount("SmtpPlatform");
        const info = (await request(app).get("/api/v1/integrations/email").set(owner.auth)).body.data;
        assert.equal(info.platform.from, "owner.mail@gmail.com");
        assert.equal(info.platform.readsReplies, true, "replies come back to the same Gmail");
        const { getEmailProvider } = await import("../providers/email.provider.js");
        const provider = await getEmailProvider(owner.organizationId);
        const conversationId = "6aca696f24ac249b0bc1932c";
        const r = await provider.send({ to: "dr@clinic.test", subject: "Hi", text: "Hello", messageKey: "m1", replyKey: conversationId });
        assert.equal(provider.name, "platform");
        assert.match(String(sent[0].from), /^".* via easySales" <owner\.mail@gmail\.com>$/);
        assert.match(String(sent[0].replyTo), /<owner\.mail\+r-6aca696f24ac249b0bc1932c\.[0-9a-f]{16}@gmail\.com>$/);
        assert.equal(conversationFromAddress(String(sent[0].replyTo).match(/<(.*)>/)![1]), conversationId);
        assert.equal(r.providerMessageId, "<m1@gmail.com>");
    } finally {
        (transporter as unknown as { sendMail: typeof original }).sendMail = original;
        Object.assign(env, OFF, { SMTP_USER: "", SMTP_PASS: "" });
    }
});

test("account emails (sign-up codes) go through Brevo when it is configured", async () => {
    Object.assign(env, PLATFORM);
    sendMail("new@user.test", "Verify your email", "<p>Your code is 123456</p>", "Your code is 123456");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(outbox.map((m) => [m.to[0].email, m.subject, m.sender.email]), [["new@user.test", "Verify your email", "hello@easysales.test"]]);
    Object.assign(env, OFF);
});
