import "./testEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isQuietHours, PolicyAction } from "../shared/policy/policy.engine.js";
import { DEFAULT_POLICY, PolicyConfig, PolicyConfigSchema } from "../shared/policy/policy.schema.js";

const policy: PolicyConfig = {
    ...DEFAULT_POLICY,
    outreach: { ...DEFAULT_POLICY.outreach, autoSend: true },
    proposals: { autoSend: true },
};

const outreach = (over: Partial<Extract<PolicyAction, { type: "outreach.send" }>> = {}): PolicyAction => ({
    type: "outreach.send", channel: "email", isFollowUp: false, followUpsSent: 0, lastOutboundAt: null,
    leadQualified: true, hasConsentBasis: true, recipientSuppressed: false, newContactsToday: 0,
    containsProhibitedClaim: false, ...over,
});

test("default policy is valid and conservative", () => {
    assert.doesNotThrow(() => PolicyConfigSchema.parse(DEFAULT_POLICY));
    assert.equal(evaluate(outreach(), DEFAULT_POLICY).decision, "needs_approval");
});

test("outreach inside policy is allowed", () => {
    assert.deepEqual(evaluate(outreach(), policy), { decision: "allow", reasons: [] });
});

test("hard limits deny, regardless of autoSend", () => {
    assert.equal(evaluate(outreach({ recipientSuppressed: true }), policy).decision, "deny");
    assert.equal(evaluate(outreach({ leadQualified: false }), policy).decision, "deny");
    assert.equal(evaluate(outreach({ hasConsentBasis: false }), policy).decision, "deny");
    assert.equal(evaluate(outreach({ newContactsToday: 20 }), policy).decision, "deny");
    assert.equal(evaluate(outreach(), { ...policy, outreach: { ...policy.outreach, enabled: false } }).decision, "deny");
});

test("follow-ups respect count and interval", () => {
    const now = new Date("2026-10-10T10:00:00Z");
    const recent = new Date(now.getTime() - 3600_000);
    const old = new Date(now.getTime() - 100 * 3600_000);
    assert.equal(evaluate(outreach({ isFollowUp: true, followUpsSent: 2, lastOutboundAt: old }), policy, now).decision, "deny");
    assert.equal(evaluate(outreach({ isFollowUp: true, followUpsSent: 0, lastOutboundAt: recent }), policy, now).decision, "deny");
    assert.equal(evaluate(outreach({ isFollowUp: true, followUpsSent: 1, lastOutboundAt: old }), policy, now).decision, "allow");
    // the new-contact cap does not apply to follow-ups
    assert.equal(evaluate(outreach({ isFollowUp: true, lastOutboundAt: old, newContactsToday: 999 }), policy, now).decision, "allow");
});

test("prohibited claims escalate to a human", () => {
    assert.equal(evaluate(outreach({ containsProhibitedClaim: true }), policy).decision, "needs_approval");
});

test("proposal pricing limits require approval", () => {
    const base = { type: "proposal.send" as const, currency: "INR", discountPercent: 5, totalMinor: 50_000_00 };
    assert.equal(evaluate(base, policy).decision, "allow");
    assert.equal(evaluate({ ...base, discountPercent: 15 }, policy).decision, "needs_approval");
    assert.equal(evaluate({ ...base, totalMinor: 100 }, policy).decision, "needs_approval");
    assert.equal(evaluate({ ...base, currency: "USD" }, policy).decision, "needs_approval");
});

test("AI budget is a hard stop", () => {
    assert.equal(evaluate({ type: "llm.call", callsToday: 499 }, policy).decision, "allow");
    assert.equal(evaluate({ type: "llm.call", callsToday: 500 }, policy).decision, "deny");
});

test("quiet hours wrap past midnight in the policy timezone", () => {
    const quiet = { enabled: true, start: "19:00", end: "09:00", timezone: "Asia/Kolkata" };
    assert.equal(isQuietHours(new Date("2026-10-10T15:00:00Z"), quiet), true);  // 20:30 IST
    assert.equal(isQuietHours(new Date("2026-10-10T02:00:00Z"), quiet), true);  // 07:30 IST
    assert.equal(isQuietHours(new Date("2026-10-10T06:00:00Z"), quiet), false); // 11:30 IST
    assert.equal(isQuietHours(new Date("2026-10-10T15:00:00Z"), { ...quiet, enabled: false }), false);
});
