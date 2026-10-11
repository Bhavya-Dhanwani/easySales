// Importing modules
import { evaluate, scanInactivity } from "../shared/sales/sales.service.js";
import { processIntegrationEvents, pullSync, pushLead } from "../shared/integrations/sync.service.js";
import { reconcileMeetings } from "../shared/integrations/calendar.service.js";
import { healthCheckIntegrations } from "../modules/private/integrations/integrations.router.js";
import { entitlementsFor, quotaLeft, QUOTA_HOLD, rollOverSubscriptions } from "../shared/billing/subscription.service.js";
import { recordStage } from "../shared/analytics/analytics.service.js";
import os from "node:os";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { Command } from "@langchain/langgraph";
import Workflow from "../shared/models/workflow.model.js";
import Message from "../shared/models/message.model.js";
import Conversation from "../shared/models/conversation.model.js";
import Lead from "../shared/models/lead.model.js";
import Proposal from "../shared/models/proposal.model.js";
import { getCurrentPolicy, isSuppressed, startOfUtcDay } from "../shared/policy/policy.service.js";
import UsageRecord from "../shared/models/usageRecord.model.js";
import { commit, recordUsage, releaseExpiredReservations } from "../shared/billing/budget.service.js";
import { runOpsChecks } from "../shared/ops/ops.service.js";
import env from "../shared/config/env.config.js";
import { isQuietHours } from "../shared/policy/policy.engine.js";
import { audit } from "../shared/audit/audit.service.js";
import { startWorkflow } from "../shared/workflows/workflow.service.js";
import { expireProposals, generateProposalBody } from "../shared/proposals/proposal.service.js";
import { buildPrototype, expireStalePreviews, failPrototype } from "../shared/prototypes/prototype.service.js";
import { runRequirementsExtraction } from "../shared/requirements/requirements.service.js";
import { proposeOutbound } from "../shared/outbound/outbound.service.js";
import { getEmailProvider, type EmailProvider } from "../providers/email.provider.js";
import { followUpStopReason, recordOutboundSent } from "../shared/conversations/followups.service.js";
import { pollInboxes } from "../shared/conversations/imap.service.js";
import { runLeadFinder } from "../shared/discovery/leadFinder.service.js";
import { processPendingEvents } from "../shared/conversations/events.service.js";
import { enrollCampaigns } from "../shared/campaigns/campaign.service.js";
import ProviderEvent from "../shared/models/providerEvent.model.js";
import { buildLeadPipeline } from "../agents/graphs/leadPipeline.graph.js";
import { buildConversationReply } from "../agents/graphs/conversationReply.graph.js";
import { draftOutreach } from "../agents/outreach.agent.js";
import { runResearch } from "../shared/research/research.service.js";
import { alert } from "../shared/alerts/alert.service.js";
import Organization from "../shared/models/organization.model.js";
import AuditEvent from "../shared/models/auditEvent.model.js";
import { loadProfile } from "../agents/graphs/common.js";
import logger from "../shared/config/logger.config.js";

const WORKER_ID = `${os.hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
const WORKFLOW_LEASE_MS = 5 * 60_000;
const SEND_LEASE_MS = 2 * 60_000;
const QUIET_HOURS_RETRY_MS = 15 * 60_000;

// errors that mean "do not retry, a human has to fix configuration"
const PERMANENT_CODES = new Set(["LLM_NOT_CONFIGURED", "BUDGET_EXCEEDED", "RECONNECT_REQUIRED"]);

type WorkflowDoc = InstanceType<typeof Workflow>;

/* ----------------------------- workflows ----------------------------- */

// WORKER_TYPES lets a process take only some job types, so e.g. demo builds scale on their own
const TYPES = env.WORKER_TYPES.split(",").map((t) => t.trim()).filter(Boolean);

async function leaseWorkflow() {
    return Workflow.findOneAndUpdate(
        { status: "queued", nextRunAt: { $lte: new Date() }, ...(TYPES.length ? { type: { $in: TYPES } } : {}) },
        { $set: { status: "running", lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + WORKFLOW_LEASE_MS), lastStartedAt: new Date() }, $inc: { attempts: 1 } },
        // higher-priority (better-fit) work first, then oldest due
        { sort: { priority: -1, nextRunAt: 1 }, new: true },
    ).setOptions({ crossTenant: true });
}

// runs (or resumes) a LangGraph workflow from its durable checkpoint
async function runGraph(wf: WorkflowDoc) {
    const graph = wf.type === "lead.pipeline" ? await buildLeadPipeline() : await buildConversationReply();
    const config = { configurable: { thread_id: wf._id.toString() } };
    const before = await graph.getState(config);

    let input: unknown;
    if (wf.resume) input = new Command({ resume: wf.resume });       // human decision arrived
    else if (before.next?.length) input = null;                       // crashed mid-run: continue from checkpoint
    else {
        const base = { organizationId: wf.organizationId.toString(), workflowId: wf._id.toString(), correlationId: wf.correlationId };
        input = wf.type === "lead.pipeline"
            ? { ...base, leadId: wf.entityId.toString(), campaignId: wf.input?.campaignId ? String(wf.input.campaignId) : undefined }
            : { ...base, conversationId: wf.entityId.toString(), inboundMessageId: String(wf.input?.inboundMessageId), autoSubmitted: Boolean(wf.input?.autoSubmitted) };
    }

    await graph.invoke(input as never, config);
    const after = await graph.getState(config);
    const interrupted = after.tasks.some((t) => (t.interrupts?.length ?? 0) > 0);
    return { interrupted, values: after.values as Record<string, unknown> };
}

// follow-up: a short second touch after silence, through the same policy gate
async function runFollowUp(wf: WorkflowDoc) {
    const organizationId = wf.organizationId.toString();
    const conversation = await Conversation.findOne({ organizationId, _id: wf.entityId });
    if (!conversation) return { outcome: "skipped" };
    // conditions may have changed since scheduling: re-check from fresh records
    const stop = await followUpStopReason(organizationId, conversation);
    if (stop) return { outcome: "follow_up_cancelled", reason: stop };
    const lead = await Lead.findOne({ organizationId, _id: conversation.leadId });
    if (!lead) return { outcome: "skipped" };
    const previous = await Message.findOne({ organizationId, conversationId: conversation._id, direction: "outbound", providerMessageId: { $type: "string" } }).sort({ sentAt: -1 }).lean();

    const n = Number(wf.input?.followUpNumber ?? conversation.followUpsSent + 1);
    const email = await draftOutreach(
        { organizationId, workflowId: wf._id.toString(), correlationId: wf.correlationId },
        lead, lead.research ?? {}, await loadProfile(organizationId),
        { followUpNumber: n, previousSubject: conversation.subject ?? undefined },
    );
    const result = await proposeOutbound({
        organizationId: wf.organizationId, lead, conversationId: conversation._id, kind: "follow_up",
        subject: conversation.subject ? `Re: ${conversation.subject.replace(/^re:\s*/i, "")}` : email.subject,
        body: email.body, idempotencyKey: `followup:${conversation._id}:${n}`,
        correlationId: wf.correlationId, actor: { type: "agent", id: "follow_up" },
        campaignId: conversation.campaignId ?? undefined, claims: email.claims,
        inReplyTo: previous?.providerMessageId ?? undefined, references: previous?.providerMessageId ? [previous.providerMessageId] : undefined,
    });
    return { outcome: `follow_up_${result.status}`, messageId: result.messageId.toString() };
}

const RESEARCH = ["lead.research", "lead.pipeline"];

/*
    Per-tenant concurrency and daily limits, checked after leasing (the leased job counts
    itself). Over the limit the job goes back to the queue untouched instead of failing.
*/
async function deferIfOverLimit(wf: WorkflowDoc) {
    const group = RESEARCH.includes(wf.type) ? RESEARCH : wf.type === "prototype.build" ? ["prototype.build"] : null;
    if (!group) return false;
    const { config } = await getCurrentPolicy(wf.organizationId);
    const running = await Workflow.countDocuments({ organizationId: wf.organizationId, type: { $in: group }, status: "running" });
    const limit = group === RESEARCH ? config.budgets.maxConcurrentResearch : config.budgets.maxConcurrentBuilds;
    let until: Date | null = running > limit ? new Date(Date.now() + 15_000) : null;
    if (!until && group === RESEARCH && wf.attempts === 1) {
        const today = await UsageRecord.countDocuments({ organizationId: wf.organizationId, kind: "llm", agent: "research", createdAt: { $gte: startOfUtcDay() } });
        if (today >= config.budgets.maxResearchPerDay) {
            until = new Date(startOfUtcDay().getTime() + 86400_000);
            await alert(wf.organizationId, "budget_exhausted", `Daily research limit (${config.budgets.maxResearchPerDay}) reached; queued research resumes tomorrow.`);
        }
    }
    // plan quota: research waits for the next period (or an upgrade) instead of failing
    if (!until && group === RESEARCH && wf.attempts === 1) {
        const q = await quotaLeft(wf.organizationId, "research");
        if (q.left <= 0) {
            const { subscription } = await entitlementsFor(wf.organizationId);
            until = subscription.currentPeriodEnd > new Date() ? subscription.currentPeriodEnd : new Date(Date.now() + 3600_000);
            await alert(wf.organizationId, "budget_exhausted", q.suspended ? "Subscription inactive: research is paused until it is renewed." : `Plan limit of ${q.limit} research jobs reached; research resumes next period or after an upgrade.`);
        }
    }
    if (!until && wf.type === "prototype.build") {
        const { suspended } = await entitlementsFor(wf.organizationId);
        if (suspended) until = new Date(Date.now() + 3600_000);
    }
    if (!until) return false;
    await Workflow.updateOne({ organizationId: wf.organizationId, _id: wf._id, status: "running" }, { status: "queued", lockedUntil: null, nextRunAt: until, $inc: { attempts: -1 } });
    return true;
}

async function executeWorkflow(wf: WorkflowDoc) {
    if (await deferIfOverLimit(wf)) return;
    logger.info({ organizationId: String(wf.organizationId), workflowId: String(wf._id), correlationId: wf.correlationId, type: wf.type, attempt: wf.attempts }, "workflow.start");
    const scope = { organizationId: wf.organizationId, _id: wf._id };
    try {
        if (wf.type === "lead.pipeline" || wf.type === "conversation.reply") {
            const { interrupted, values } = await runGraph(wf);
            await Workflow.updateOne(scope, interrupted
                ? { status: "waiting_approval", resume: null, lockedUntil: null, currentStep: "awaiting_approval" }
                : { status: "completed", resume: null, lockedUntil: null, currentStep: "done", result: { outcome: values.outcome ?? null } });
        } else if (wf.type === "lead.research") {
            await Workflow.updateOne(scope, { currentStep: "research" });
            const r = await runResearch({ organizationId: wf.organizationId, leadId: wf.entityId, workflowId: wf._id.toString(), correlationId: wf.correlationId, requestedAt: wf.createdAt, force: Boolean(wf.input?.force) });
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: r.stale ? "stale_result_discarded" : r.cached ? "rescored_from_fresh_research" : r.status } });
        } else if (wf.type === "proposal.generate") {
            await generateProposalBody(wf.organizationId.toString(), wf.entityId.toString(), wf._id.toString(), wf.correlationId);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: "proposal_drafted" } });
        } else if (wf.type === "requirements.extract") {
            await Workflow.updateOne(scope, { currentStep: "extract" });
            const r = await runRequirementsExtraction(wf.organizationId, wf.entityId, wf._id.toString(), wf.correlationId);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: "requirements_extracted", ...r } });
        } else if (wf.type === "sales.evaluate") {
            const d = await evaluate(wf.organizationId, wf.entityId, String(wf.input?.trigger ?? "manual"), String(wf.input?.eventKey ?? wf._id));
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: d.action, decision: String(d._id), policy: d.policyDecision } });
        } else if (wf.type === "integration.sync") {
            await Workflow.updateOne(scope, { currentStep: "sync" });
            const r = await pullSync(wf.organizationId);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: "synced", ...r } });
        } else if (wf.type === "integration.push") {
            await Workflow.updateOne(scope, { currentStep: "push" });
            const r = await pushLead(wf.organizationId, wf.entityId);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: r });
        } else if (wf.type === "prototype.build") {
            await Workflow.updateOne(scope, { currentStep: "build" });
            const r = await buildPrototype(wf.organizationId, wf.entityId, wf._id.toString(), wf.correlationId);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: r });
        } else if (wf.type === "conversation.followup") {
            const result = await runFollowUp(wf);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result });
        }
    } catch (error) {
        const err = error as Error & { code?: string };
        const permanent = PERMANENT_CODES.has(err.code ?? "");
        const giveUp = permanent || wf.attempts >= wf.maxAttempts;
        await Workflow.updateOne(scope, {
            status: giveUp ? "failed" : "queued",
            lockedUntil: null,
            failureCode: err.code ?? "ERROR",
            lastError: err.message?.slice(0, 1000),
            // exponential backoff: 30s, 60s, 120s...
            // exponential backoff with jitter so retries of many jobs do not arrive together
            nextRunAt: new Date(Date.now() + (err.code === "RATE_LIMITED" ? ((error as { retryAfterSec?: number }).retryAfterSec ?? 30) * 1000 : 30_000 * 2 ** (wf.attempts - 1) * (0.5 + Math.random()))),
        });
        if (giveUp) {
            if (wf.type === "prototype.build") await failPrototype(wf.organizationId, wf.entityId, err.code ?? "ERROR");
            // research that can no longer succeed is visible on the lead, never silently stuck
            if (wf.type === "lead.research" || wf.type === "lead.pipeline") {
                await Lead.updateOne(
                    { organizationId: wf.organizationId, _id: wf.entityId, status: { $in: ["research_queued", "researching", "new"] } },
                    { status: "research_failed", "research.status": "failed" },
                );
            }
            if (err.code !== "BUDGET_EXCEEDED") await alert(wf.organizationId, "workflow_failed", `${wf.type} failed: ${err.message}`, { workflowId: wf._id.toString(), code: err.code });
            await audit({
                organizationId: wf.organizationId, actorType: "system", actorId: "worker", action: "workflow.failed",
                targetType: wf.entityType, targetId: wf.entityId.toString(), outcome: "failure", correlationId: wf.correlationId,
                metadata: { type: wf.type, error: err.message, code: err.code },
            });
        }
        logger.warn({ workflowId: wf._id.toString(), error: err.message, giveUp }, "Workflow run failed");
    }
}

/* ------------------------------ outbox ------------------------------- */

async function leaseMessage() {
    return Message.findOneAndUpdate(
        { status: "queued", direction: "outbound", notBefore: { $lte: new Date() } },
        { $set: { status: "sending", lockedUntil: new Date(Date.now() + SEND_LEASE_MS) }, $inc: { attempts: 1 } },
        { sort: { notBefore: 1 }, new: true },
    ).setOptions({ crossTenant: true });
}

// consecutive not-accepted sends per tenant, to detect a provider outage
// ponytail: in-process; a shared store when several workers send for the same tenant
const sendFailures = new Map<string, number>();

// connection-phase failures: the provider never accepted the message, so a retry is safe
const RETRYABLE = new Set(["ECONNECTION", "ECONNREFUSED", "EDNS", "ENOTFOUND", "EAI_AGAIN"]);

async function dispatchMessage(msg: InstanceType<typeof Message>) {
    const scope = { organizationId: msg.organizationId, _id: msg._id };
    const organizationId = msg.organizationId;

    // policy is re-checked at the moment of sending, not only when the message was drafted
    if (!msg.to || await isSuppressed(organizationId, msg.to)) {
        await Message.updateOne(scope, { status: "rejected", error: "Recipient is suppressed", lockedUntil: null });
        return;
    }
    if (msg.kind === "follow_up") {
        const conv = await Conversation.findOne({ organizationId, _id: msg.conversationId }).lean();
        const stop = conv ? await followUpStopReason(organizationId, conv) : "Conversation deleted";
        if (stop) {
            await Message.updateOne(scope, { status: "rejected", error: `Follow-up cancelled: ${stop}`, lockedUntil: null });
            return;
        }
    }
    if (msg.kind === "outreach" || msg.kind === "follow_up") {
        const { config } = await getCurrentPolicy(organizationId);
        if (isQuietHours(new Date(), config.outreach.quietHours)) {
            await Message.updateOne(scope, { status: "queued", notBefore: new Date(Date.now() + QUIET_HOURS_RETRY_MS), lockedUntil: null, $inc: { attempts: -1 } });
            return;
        }
    }

    // plan quota for email: hold the message (never drop it) until the next period or an upgrade
    const emailQuota = await quotaLeft(organizationId, "email");
    if (emailQuota.left <= 0) {
        const { subscription } = await entitlementsFor(organizationId);
        await Message.updateOne(scope, { status: "queued", error: QUOTA_HOLD, lockedUntil: null, $inc: { attempts: -1 }, notBefore: subscription.currentPeriodEnd > new Date() ? subscription.currentPeriodEnd : new Date(Date.now() + 3600_000) });
        await alert(organizationId, "send_cap_reached", emailQuota.suspended ? "Subscription inactive: emails are held until it is renewed." : `Plan limit of ${emailQuota.limit} emails reached; queued emails are held until the next period or an upgrade.`);
        return;
    }

    let provider: EmailProvider;
    try {
        provider = await getEmailProvider(organizationId);
    } catch (error) {
        // nothing was handed to a provider, so this is a definite (not uncertain) failure
        await Message.updateOne(scope, { status: "failed", error: (error as Error).message, lockedUntil: null });
        await alert(organizationId, "workflow_failed", (error as Error).message);
        return;
    }
    try {
        const { providerMessageId } = await provider.send({
            to: msg.to, subject: msg.subject ?? "", text: msg.body, messageKey: msg._id.toString(),
            inReplyTo: msg.inReplyTo ?? undefined, references: msg.references?.length ? msg.references : undefined,
        });
        const now = new Date();
        await Message.updateOne(scope, { status: "sent", sentAt: now, providerMessageId, lockedUntil: null, error: null });
        await recordOutboundSent(organizationId, msg, now);
        sendFailures.delete(String(organizationId));
        await recordUsage(organizationId, { kind: "email", costMinor: env.EMAIL_COST_MINOR, provider: provider.name, refId: msg._id.toString(), leadId: msg.leadId });
        await commit(organizationId, "email", env.EMAIL_COST_MINOR);
        await Lead.updateOne({ organizationId, _id: msg.leadId, outreachStatus: { $in: ["not_started", "eligible"] } }, { outreachStatus: "active" });
        await recordStage(organizationId, msg.leadId, "contacted", { kind: msg.kind });
        if (msg.proposalId) await recordStage(organizationId, msg.leadId, "proposal_sent", { proposalId: String(msg.proposalId) });
        if (msg.proposalId) await Proposal.updateOne({ organizationId, _id: msg.proposalId, status: "approved" }, { status: "sent", sentAt: new Date() });
        await audit({
            organizationId, actorType: "system", actorId: `email:${provider.name}`, action: "message.sent",
            targetType: "message", targetId: msg._id.toString(), outcome: "success", metadata: { to: msg.to, kind: msg.kind, providerMessageId },
        });
    } catch (error) {
        const err = error as Error & { code?: string; responseCode?: number };
        // a 4xx SMTP reply or a connection failure means "not accepted"; anything else is ambiguous
        const notAccepted = RETRYABLE.has(err.code ?? "") || (err.responseCode !== undefined && err.responseCode < 500);
        const rejected = err.responseCode !== undefined && err.responseCode >= 500;
        let status: "queued" | "failed" | "uncertain";
        if (rejected) status = "failed";
        else if (notAccepted) status = msg.attempts >= 3 ? "failed" : "queued";
        else status = "uncertain";
        await Message.updateOne(scope, {
            status, error: err.message?.slice(0, 500), lockedUntil: null,
            notBefore: new Date(Date.now() + 60_000 * msg.attempts),
        });
        if (notAccepted && (sendFailures.set(String(organizationId), (sendFailures.get(String(organizationId)) ?? 0) + 1).get(String(organizationId)) ?? 0) >= 3) {
            await alert(organizationId, "provider_outage", `Email provider refused or could not be reached for several sends in a row: ${err.message}`);
        }
        if (status === "uncertain") await alert(organizationId, "uncertain_send", "A message may or may not have been delivered; check the provider before resending.", { messageId: msg._id.toString() });
        await audit({
            organizationId, actorType: "system", actorId: `email:${provider.name}`, action: "message.send_failed",
            targetType: "message", targetId: msg._id.toString(), outcome: status === "uncertain" ? "uncertain" : "failure",
            metadata: { error: err.message, code: err.code, status },
        });
    }
}

/* --------------------------- housekeeping ---------------------------- */

async function recoverStaleLeases() {
    const now = new Date();
    // a workflow whose worker died is resumed from its last checkpoint
    await Workflow.updateMany({ status: "running", lockedUntil: { $lt: now } }, { status: "queued", lockedUntil: null }).setOptions({ crossTenant: true });
    await ProviderEvent.updateMany({ status: "processing", lockedUntil: { $lt: now } }, { status: "pending", lockedUntil: null }).setOptions({ crossTenant: true });
    // a message stuck in "sending" may or may not have gone out: never resend blindly
    await Message.updateMany(
        { status: "sending", lockedUntil: { $lt: now } },
        { status: "uncertain", error: "Worker stopped during send; verify with the provider before retrying", lockedUntil: null },
    ).setOptions({ crossTenant: true });
}

// follow-ups are due when a waiting thread's nextActionAt passes; stop conditions are re-checked first
async function scheduleFollowUps() {
    const due = await Conversation.find({ status: "waiting", nextActionAt: { $lte: new Date() } })
        .limit(50).setOptions({ crossTenant: true }).lean();
    for (const c of due) {
        const stop = await followUpStopReason(c.organizationId, c);
        if (stop) {
            await Conversation.updateOne({ organizationId: c.organizationId, _id: c._id }, { $unset: { nextActionAt: 1 } });
            await audit({ organizationId: c.organizationId, actorType: "system", actorId: "scheduler", action: "followup.cancelled", targetType: "conversation", targetId: String(c._id), outcome: "success", metadata: { reason: stop } });
            continue;
        }
        const n = c.followUpsSent + 1;
        // the workflow owns the next step; clearing nextActionAt stops re-scheduling
        await Conversation.updateOne({ organizationId: c.organizationId, _id: c._id }, { $unset: { nextActionAt: 1 } });
        await startWorkflow({
            organizationId: c.organizationId, type: "conversation.followup", entityType: "conversation", entityId: c._id,
            input: { followUpNumber: n }, idempotencyKey: `followup:${c._id}:${n}`, actor: { type: "system", id: "scheduler" },
        });
    }
}

// daily retention: message bodies and audit events older than each tenant's policy are deleted
export async function enforceRetention(now = new Date()) {
    const orgs = await Organization.find({ status: "active" }, { _id: 1 }).lean();
    for (const org of orgs) {
        const { config } = await getCurrentPolicy(org._id);
        const msgCutoff = new Date(now.getTime() - config.retention.messageDays * 86400_000);
        const auditCutoff = new Date(now.getTime() - config.retention.auditDays * 86400_000);
        await Message.deleteMany({ organizationId: org._id, createdAt: { $lt: msgCutoff }, status: { $nin: ["queued", "sending", "pending_approval"] } });
        // audit events are append-only for application code; retention is the one sanctioned delete
        await AuditEvent.collection.deleteMany({ organizationId: org._id, createdAt: { $lt: auditCutoff } });
    }
}

/* ------------------------------- loop -------------------------------- */

let lastFollowUpScan = 0;
let lastRetentionRun = 0;

// one pass over all queues; exported so tests can drive the worker deterministically
export async function runOnce({ maxWorkflows = 5, maxMessages = 20, force = false } = {}) {
    await recoverStaleLeases();
    for (let i = 0; i < maxWorkflows; i++) {
        const wf = await leaseWorkflow();
        if (!wf) break;
        const started = Date.now();
        await executeWorkflow(wf);
        await Workflow.updateOne({ organizationId: wf.organizationId, _id: wf._id, status: { $ne: "running" } }, { durationMs: Date.now() - started });
    }
    for (let i = 0; i < maxMessages; i++) {
        const msg = await leaseMessage();
        if (!msg) break;
        await dispatchMessage(msg);
    }
    await task("provider_events", processPendingEvents);
    await task("integration_events", () => processIntegrationEvents());
    await task("expire_previews", () => expireStalePreviews());
    await task("expire_proposals", () => expireProposals());
    await task("release_reservations", () => releaseExpiredReservations());
    await task("subscription_rollover", () => rollOverSubscriptions());
    if (force || Date.now() - lastFollowUpScan > 60_000) {
        lastFollowUpScan = Date.now();
        // backpressure: with a deep queue, new follow-ups and enrolments wait; replies and sends do not
        const due = await Workflow.countDocuments({ status: "queued", nextRunAt: { $lte: new Date() } }).setOptions({ crossTenant: true });
        if (due > env.QUEUE_BACKPRESSURE) logger.warn({ due }, "Queue over backpressure limit; deferring follow-ups and campaign enrolment");
        else {
            await task("follow_ups", scheduleFollowUps);
            await task("campaign_enrolment", enrollCampaigns);
        }
        await task("ops_checks", () => runOpsChecks());
        await task("integration_health", () => healthCheckIntegrations());
        await task("calendar_reconcile", () => reconcileMeetings());
        await task("inbox_poll", () => pollInboxes());
        await task("lead_finder", () => runLeadFinder());
        await task("inactivity_scan", () => scanInactivity());
    }
    if (Date.now() - lastRetentionRun > 24 * 3600_000) {
        lastRetentionRun = Date.now();
        await task("retention", () => enforceRetention());
    }
}

// a scheduled task that throws is alerted and does not stop the rest of the tick
async function task(name: string, fn: () => Promise<unknown>) {
    try {
        await fn();
    } catch (error) {
        logger.error({ task: name, error: (error as Error).message }, "Scheduled task failed");
        await alert(null, "scheduled_task_failed", `${name}: ${(error as Error).message}`);
    }
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastTickAt = 0;

// ponytail: Mongo-leased polling queue (no Redis to operate); move hot paths to BullMQ if throughput demands it
export function startWorker(intervalMs = 2000) {
    if (timer) return;
    logger.info({ worker: WORKER_ID }, "Agent worker started");
    timer = setInterval(async () => {
        if (busy || mongoose.connection.readyState !== 1) return;
        busy = true;
        lastTickAt = Date.now();
        try {
            await runOnce();
        } catch (error) {
            logger.error(error, "Worker tick failed");
        } finally {
            busy = false;
        }
    }, intervalMs);
}

// stops taking new work and resolves once the in-flight tick has finished (leases cover a hard kill)
export async function stopWorker(maxWaitMs = 25_000) {
    if (timer) clearInterval(timer);
    timer = null;
    const until = Date.now() + maxWaitMs;
    while (busy && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

// liveness of the in-process worker for /health/ready
export const workerHeartbeat = () => ({ running: Boolean(timer), lastTickAt });
