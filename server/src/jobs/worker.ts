// Importing modules
import os from "node:os";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { Command } from "@langchain/langgraph";
import Workflow from "../shared/models/workflow.model.js";
import Message from "../shared/models/message.model.js";
import Conversation from "../shared/models/conversation.model.js";
import Lead from "../shared/models/lead.model.js";
import Proposal from "../shared/models/proposal.model.js";
import { getCurrentPolicy, isSuppressed } from "../shared/policy/policy.service.js";
import { isQuietHours } from "../shared/policy/policy.engine.js";
import { audit } from "../shared/audit/audit.service.js";
import { startWorkflow } from "../shared/workflows/workflow.service.js";
import { generateProposalBody } from "../shared/proposals/proposal.service.js";
import { proposeOutbound } from "../shared/outbound/outbound.service.js";
import { getEmailProvider } from "../providers/email.provider.js";
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
const PERMANENT_CODES = new Set(["LLM_NOT_CONFIGURED", "BUDGET_EXCEEDED"]);

type WorkflowDoc = InstanceType<typeof Workflow>;

/* ----------------------------- workflows ----------------------------- */

async function leaseWorkflow() {
    return Workflow.findOneAndUpdate(
        { status: "queued", nextRunAt: { $lte: new Date() } },
        { $set: { status: "running", lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + WORKFLOW_LEASE_MS) }, $inc: { attempts: 1 } },
        { sort: { nextRunAt: 1 }, new: true },
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
            ? { ...base, leadId: wf.entityId.toString() }
            : { ...base, conversationId: wf.entityId.toString(), inboundMessageId: String(wf.input?.inboundMessageId) };
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
    if (!conversation || conversation.status !== "waiting") return { outcome: "skipped" };
    const lead = await Lead.findOne({ organizationId, _id: conversation.leadId });
    if (!lead) return { outcome: "skipped" };

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
    });
    return { outcome: `follow_up_${result.status}`, messageId: result.messageId.toString() };
}

async function executeWorkflow(wf: WorkflowDoc) {
    const scope = { organizationId: wf.organizationId, _id: wf._id };
    try {
        if (wf.type === "lead.pipeline" || wf.type === "conversation.reply") {
            const { interrupted, values } = await runGraph(wf);
            await Workflow.updateOne(scope, interrupted
                ? { status: "waiting_approval", resume: null, lockedUntil: null, currentStep: "awaiting_approval" }
                : { status: "completed", resume: null, lockedUntil: null, currentStep: "done", result: { outcome: values.outcome ?? null } });
        } else if (wf.type === "lead.research") {
            const r = await runResearch({ organizationId: wf.organizationId, leadId: wf.entityId, workflowId: wf._id.toString(), correlationId: wf.correlationId, requestedAt: wf.createdAt });
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: r.stale ? "stale_result_discarded" : r.status } });
        } else if (wf.type === "proposal.generate") {
            await generateProposalBody(wf.organizationId.toString(), wf.entityId.toString(), wf._id.toString(), wf.correlationId);
            await Workflow.updateOne(scope, { status: "completed", lockedUntil: null, currentStep: "done", result: { outcome: "proposal_drafted" } });
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
            nextRunAt: new Date(Date.now() + 30_000 * 2 ** (wf.attempts - 1)),
        });
        if (giveUp) {
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
    if (msg.kind === "outreach" || msg.kind === "follow_up") {
        const { config } = await getCurrentPolicy(organizationId);
        if (isQuietHours(new Date(), config.outreach.quietHours)) {
            await Message.updateOne(scope, { status: "queued", notBefore: new Date(Date.now() + QUIET_HOURS_RETRY_MS), lockedUntil: null, $inc: { attempts: -1 } });
            return;
        }
    }

    const provider = getEmailProvider();
    try {
        const { providerMessageId } = await provider.send({ to: msg.to, subject: msg.subject ?? "", text: msg.body, messageKey: msg._id.toString() });
        const now = new Date();
        await Message.updateOne(scope, { status: "sent", sentAt: now, providerMessageId, lockedUntil: null, error: null });
        await Conversation.updateOne(
            { organizationId, _id: msg.conversationId },
            { lastOutboundAt: now, lastMessageAt: now, status: "waiting", ...(msg.kind === "follow_up" ? { $inc: { followUpsSent: 1 } } : {}) },
        );
        await Lead.updateOne({ organizationId, _id: msg.leadId, outreachStatus: { $in: ["not_started", "eligible"] } }, { outreachStatus: "active" });
        if (msg.proposalId) await Proposal.updateOne({ organizationId, _id: msg.proposalId }, { status: "sent" });
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
    // a message stuck in "sending" may or may not have gone out: never resend blindly
    await Message.updateMany(
        { status: "sending", lockedUntil: { $lt: now } },
        { status: "uncertain", error: "Worker stopped during send; verify with the provider before retrying", lockedUntil: null },
    ).setOptions({ crossTenant: true });
}

// starts follow-up workflows for silent threads, within each tenant's follow-up policy
async function scheduleFollowUps() {
    const candidates = await Conversation.find({ status: "waiting", lastOutboundAt: { $lte: new Date(Date.now() - 3600_000) } })
        .limit(50).setOptions({ crossTenant: true }).lean();
    for (const c of candidates) {
        const { config } = await getCurrentPolicy(c.organizationId);
        const o = config.outreach;
        if (!o.enabled || c.followUpsSent >= o.maxFollowUps) continue;
        if (!c.lastOutboundAt || Date.now() - c.lastOutboundAt.getTime() < o.minimumFollowUpIntervalHours * 3600_000) continue;
        const n = c.followUpsSent + 1;
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
export async function runOnce({ maxWorkflows = 5, maxMessages = 20 } = {}) {
    await recoverStaleLeases();
    for (let i = 0; i < maxWorkflows; i++) {
        const wf = await leaseWorkflow();
        if (!wf) break;
        await executeWorkflow(wf);
    }
    for (let i = 0; i < maxMessages; i++) {
        const msg = await leaseMessage();
        if (!msg) break;
        await dispatchMessage(msg);
    }
    if (Date.now() - lastFollowUpScan > 60_000) {
        lastFollowUpScan = Date.now();
        await scheduleFollowUps();
    }
    if (Date.now() - lastRetentionRun > 24 * 3600_000) {
        lastRetentionRun = Date.now();
        await enforceRetention();
    }
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

// ponytail: Mongo-leased polling queue (no Redis to operate); move hot paths to BullMQ if throughput demands it
export function startWorker(intervalMs = 2000) {
    if (timer) return;
    logger.info({ worker: WORKER_ID }, "Agent worker started");
    timer = setInterval(async () => {
        if (busy || mongoose.connection.readyState !== 1) return;
        busy = true;
        try {
            await runOnce();
        } catch (error) {
            logger.error(error, "Worker tick failed");
        } finally {
            busy = false;
        }
    }, intervalMs);
}

export function stopWorker() {
    if (timer) clearInterval(timer);
    timer = null;
}
