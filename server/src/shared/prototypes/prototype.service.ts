// Importing modules
import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { ZodError } from "zod";
import Prototype from "../models/prototype.model.js";
import Lead from "../models/lead.model.js";
import Approval from "../models/approval.model.js";
import Workflow from "../models/workflow.model.js";
import { evaluate } from "../policy/policy.engine.js";
import { findProhibitedClaims, getCurrentPolicy } from "../policy/policy.service.js";
import { audit } from "../audit/audit.service.js";
import { hashPayload } from "../utils/hash.util.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { latestRequirements, openQuestionsOf } from "../requirements/requirements.service.js";
import Requirements from "../models/requirements.model.js";
import { TEMPLATES, isTemplate } from "./templates.js";
import { generatePrototypeContent, PrototypeContent } from "../../agents/prototype.agent.js";
import type { Requirements as Reqs } from "../../agents/requirements.agent.js";
import { loadProfile } from "../../agents/graphs/common.js";
import env from "../config/env.config.js";
import NotFound from "../errors/NotFound.error.js";
import Conflict from "../errors/Conflict.error.js";

type Id = mongoose.Types.ObjectId | string;
type ProtoDoc = InstanceType<typeof Prototype>;

const MAX_ARTIFACT_BYTES = 300_000;
const PERMANENT = new Set(["LLM_NOT_CONFIGURED", "BUDGET_EXCEEDED"]);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const startOfMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

// what this tenant has spent on prototype builds this calendar month (UTC)
export async function monthSpentMinor(organizationId: Id) {
    const [row] = await Prototype.aggregate([
        { $match: { organizationId: new mongoose.Types.ObjectId(String(organizationId)), createdAt: { $gte: startOfMonth() } } },
        { $group: { _id: null, total: { $sum: "$costMinorUnits" } } },
    ]);
    return (row?.total as number | undefined) ?? 0;
}

const approvalPayload = (p: ProtoDoc) => ({
    prototypeId: p._id.toString(), templateId: p.templateId, requirementsVersion: p.requirementsVersion,
    budgetMinorUnits: p.budgetMinorUnits, currency: p.currency,
});

async function startBuild(p: ProtoDoc) {
    return startWorkflow({
        organizationId: p.organizationId, type: "prototype.build", entityType: "prototype", entityId: p._id,
        idempotencyKey: `prototype:${p._id}:build:${p.retries}`, actor: { type: "system", id: "prototype" },
    });
}

/*
    Step 1: is a prototype justified? Qualified lead, clear requirements, an approved
    template and room in the budget. Inside policy it builds right away; exceptional
    cost or autonomy turned off waits for a human; anything unclear is refused with
    the questions to ask the prospect.
*/
export async function requestPrototype(organizationId: Id, opportunityId: Id, opts: { templateId?: string; idempotencyKey: string; userId: string }) {
    const existing = await Prototype.findOne({ organizationId, idempotencyKey: opts.idempotencyKey });
    if (existing) return { prototype: existing, decision: "allow" as const, reasons: [], created: false };

    const lead = await Lead.findOne({ organizationId, _id: opportunityId }).lean();
    if (!lead) throw new NotFound("Lead not found");
    const req = await latestRequirements(organizationId, opportunityId);
    const { config, version } = await getCurrentPolicy(organizationId);
    const r = req?.requirements as Reqs | undefined;
    const templateId = opts.templateId ?? r?.projectType ?? "";
    const b = config.prototypes;
    const estimateMinor = b.costPerAttemptMinor * b.maxAttempts;

    const result = evaluate({
        type: "prototype.build",
        leadQualified: lead.status === "qualified" || (lead.qualification?.score ?? 0) >= config.qualification.minimumScore,
        hasRequirements: Boolean(r),
        openQuestions: r ? openQuestionsOf(r) : [],
        templateApproved: isTemplate(templateId),
        estimateMinor,
        monthSpentMinor: await monthSpentMinor(organizationId),
        prospectBudgetMinor: r?.constraints.budgetMinorUnits ?? null,
    }, config);

    const auditBase = { organizationId, actorType: "user" as const, actorId: opts.userId, action: "prototype.request", targetType: "lead", targetId: String(opportunityId), policyVersion: version };
    if (result.decision === "deny") {
        await audit({ ...auditBase, decision: "deny", outcome: "denied", metadata: { reasons: result.reasons } });
        return { prototype: null, decision: result.decision, reasons: result.reasons, created: false };
    }

    const prototype = await Prototype.create({
        organizationId, opportunityId, requirementsVersion: req!.version, templateId, currency: config.pricing.currency,
        budgetMinorUnits: estimateMinor, maxAttempts: b.maxAttempts, idempotencyKey: opts.idempotencyKey, requestedBy: opts.userId,
    });
    if (result.decision === "needs_approval") {
        const payload = approvalPayload(prototype);
        const approval = await Approval.create({
            organizationId, actionType: "prototype.build", targetType: "prototype", targetId: prototype._id, leadId: lead._id,
            payload, payloadHash: hashPayload(payload), policyVersion: version, reasons: result.reasons,
            requestedBy: `user:${opts.userId}`, expiresAt: new Date(Date.now() + 7 * 86400_000),
        });
        prototype.approvalId = approval._id;
        await prototype.save();
    } else {
        await startBuild(prototype);
    }
    await audit({ ...auditBase, targetType: "prototype", targetId: prototype._id.toString(), decision: result.decision, outcome: result.decision === "allow" ? "success" : "pending", metadata: { reasons: result.reasons, templateId, estimateMinor } });
    return { prototype, decision: result.decision, reasons: result.reasons, created: true };
}

// called by decideApproval once a human has approved or rejected the exact build request
export async function decidePrototypeApproval(organizationId: Id, prototypeId: Id, payloadHash: string, approved: boolean) {
    const p = await Prototype.findOne({ organizationId, _id: prototypeId, status: "queued" });
    if (!p) throw new Conflict("Prototype is no longer awaiting approval");
    if (!approved) {
        p.status = "cancelled";
        p.failureCode = "REJECTED";
        await p.save();
        return;
    }
    if (hashPayload(approvalPayload(p)) !== payloadHash) throw new Conflict("Prototype request changed since review");
    await startBuild(p);
}

/* ------------------------------ QA ------------------------------- */

const contentText = (c: PrototypeContent) => [
    c.brandName, c.tagline, c.headline, c.subheadline, c.primaryCta,
    ...c.sections.flatMap((s) => [s.heading, s.body, ...s.items.flatMap((i) => [i.title, i.text])]),
    ...c.metrics.flatMap((m) => [m.label, m.value]), ...c.table.columns, ...c.table.rows.flat(),
].join("\n");

// synthetic data only: no links, addresses or phone numbers in a demo
const REAL_DATA = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[a-z]{2,}|\+\d[\d\s-]{8,}\d/i;
// the rendered page must stay inert: no scripts, handlers, embeds, forms or remote resources
const ACTIVE_MARKUP = /<\s*(script|iframe|object|embed|form|link|img|svg|base|meta\s+http-equiv)\b|\son[a-z]+\s*=|javascript:|@import|url\s*\(|(?:href|src|action)\s*=\s*"(?!#)/i;

export function runQa(html: string, content: PrototypeContent, requirements: Reqs, prohibitedClaims: string[] = []) {
    const findings: string[] = [];
    const buildPassed = html.startsWith("<!doctype html>") && Buffer.byteLength(html) <= MAX_ARTIFACT_BYTES;
    if (!buildPassed) findings.push("Build: page is malformed or larger than the size limit");

    const text = contentText(content).toLowerCase();
    const missing = requirements.features.filter((f) => f.priority === "must" && !text.includes(f.name.toLowerCase()));
    for (const f of missing) findings.push(`Test: must-have feature "${f.name}" does not appear in the demo`);
    if (!content.sections.some((s) => s.items.length)) findings.push("Test: the demo has no feature items");
    const testsPassed = missing.length === 0 && content.sections.some((s) => s.items.length);

    const security: string[] = [];
    if (ACTIVE_MARKUP.test(html)) security.push("Security: page contains active markup or a remote resource");
    if (REAL_DATA.test(contentText(content))) security.push("Security: content contains a URL, email address or phone number; use fictional data only");
    for (const claim of findProhibitedClaims(contentText(content), prohibitedClaims)) security.push(`Security: prohibited claim "${claim}"`);
    findings.push(...security);

    return { buildPassed, testsPassed, securityPassed: security.length === 0, findings };
}

// a summary safe to show the model again: schema paths and messages only, never raw output
function sanitize(error: unknown) {
    if (error instanceof ZodError) return error.issues.slice(0, 10).map((i) => `Build: ${i.path.join(".") || "output"}: ${i.message}`);
    return ["Build: the generation step failed; produce valid content"];
}

/*
    Steps 2-4: fill the approved template, render, run QA; on failure feed the findings
    back for a bounded number of repairs. Every attempt is charged to the budget first.
*/
export async function buildPrototype(organizationId: Id, prototypeId: Id, workflowId: string, correlationId: string) {
    const scope = { organizationId, _id: prototypeId };
    let p = await Prototype.findOne(scope);
    if (!p || !["queued", "building", "testing"].includes(p.status)) return { outcome: "skipped" };
    const reqDoc = await Requirements.findOne({ organizationId, opportunityId: p.opportunityId, version: p.requirementsVersion }).lean();
    if (!reqDoc) throw new NotFound("Requirements version not found");
    const requirements = reqDoc.requirements as Reqs;
    const template = TEMPLATES[p.templateId as keyof typeof TEMPLATES];
    const profile = await loadProfile(String(organizationId));
    const { config } = await getCurrentPolicy(organizationId);
    const perAttempt = config.prototypes.costPerAttemptMinor;

    let findings: string[] = [];
    let qa: ReturnType<typeof runQa> | null = null;
    while (p.attempts < p.maxAttempts) {
        if (p.costMinorUnits + perAttempt > p.budgetMinorUnits) break;
        // charge first and only if still active: a cancel between attempts wins
        const charged = await Prototype.findOneAndUpdate(
            { ...scope, status: { $in: ["queued", "building", "testing"] } },
            { status: "building", $inc: { attempts: 1, costMinorUnits: perAttempt } },
            { new: true },
        );
        if (!charged) return { outcome: "cancelled" };
        p = charged;

        let content: PrototypeContent;
        try {
            content = await generatePrototypeContent({ organizationId, workflowId, correlationId }, requirements, template.brief, profile, findings);
        } catch (error) {
            const code = (error as { code?: string }).code ?? "";
            if (PERMANENT.has(code)) {
                await Prototype.updateOne(scope, { status: "failed", failureCode: code });
                throw error;
            }
            findings = sanitize(error);
            qa = { buildPassed: false, testsPassed: false, securityPassed: false, findings };
            continue;
        }

        await Prototype.updateOne(scope, { status: "testing" });
        const html = template.render(content);
        qa = runQa(html, content, requirements, profile.prohibitedClaims);
        if (qa.buildPassed && qa.testsPassed && qa.securityPassed) {
            const done = await Prototype.updateOne(
                { ...scope, status: "testing" },
                { status: "needs_review", artifactHtml: html, artifactChecksum: sha256(html), artifactBytes: Buffer.byteLength(html), qaReport: qa, completedAt: new Date() },
            );
            if (!done.modifiedCount) return { outcome: "cancelled" };
            await audit({ organizationId, actorType: "agent", actorId: "prototype_builder", action: "prototype.built", targetType: "prototype", targetId: String(prototypeId), outcome: "success", correlationId, metadata: { attempts: p.attempts, costMinor: p.costMinorUnits } });
            return { outcome: "built" };
        }
        findings = qa.findings;
    }

    const code = p.attempts >= p.maxAttempts ? "REPAIR_BUDGET_EXHAUSTED" : "BUDGET_EXHAUSTED";
    await Prototype.updateOne({ ...scope, status: { $in: ["queued", "building", "testing"] } }, { status: "failed", failureCode: code, qaReport: qa ?? undefined, completedAt: new Date() });
    await audit({ organizationId, actorType: "agent", actorId: "prototype_builder", action: "prototype.failed", targetType: "prototype", targetId: String(prototypeId), outcome: "failure", correlationId, metadata: { code, findings: qa?.findings ?? [] } });
    return { outcome: "failed", code };
}

/* -------------------------- lifecycle ---------------------------- */

const audited = (organizationId: Id, userId: string, action: string, id: Id, metadata: Record<string, unknown> = {}) =>
    audit({ organizationId, actorType: "user", actorId: userId, action, targetType: "prototype", targetId: String(id), outcome: "success", metadata });

/*
    Step 5: publish. Only a QA-passed build, only by prototype id (never a path or URL),
    and only if the stored artifact still matches the checksum QA saw.
*/
export async function publishPrototype(organizationId: Id, prototypeId: Id, userId: string) {
    const p = await Prototype.findOne({ organizationId, _id: prototypeId }).select("+artifactHtml");
    if (!p) throw new NotFound("Prototype not found");
    if (p.status !== "needs_review") throw new Conflict(`Prototype is ${p.status}; only a built, reviewed demo can be published`);
    const qa = p.qaReport;
    if (!qa?.buildPassed || !qa.testsPassed || !qa.securityPassed) throw new Conflict("Prototype has not passed QA");
    if (!p.artifactHtml || sha256(p.artifactHtml) !== p.artifactChecksum) throw new Conflict("Artifact failed its integrity check");

    const { config } = await getCurrentPolicy(organizationId);
    const token = randomBytes(32).toString("base64url");
    const updated = await Prototype.findOneAndUpdate(
        { organizationId, _id: prototypeId, status: "needs_review" },
        {
            status: "ready", previewToken: token,
            previewUrl: `${(env.PREVIEW_BASE_URL || env.FRONTEND_URL).replace(/\/$/, "")}/api/preview/${token}`,
            previewExpiresAt: new Date(Date.now() + config.prototypes.previewDays * 86400_000),
        },
        { new: true },
    );
    if (!updated) throw new Conflict("Prototype changed while publishing");
    await audited(organizationId, userId, "prototype.publish", prototypeId, { expiresAt: updated.previewExpiresAt });
    return updated;
}

// revocation and expiry both destroy the capability and the stored page
const TEARDOWN = { $unset: { previewToken: 1, artifactHtml: 1 } };

export async function expirePrototype(organizationId: Id, prototypeId: Id, userId: string) {
    const p = await Prototype.findOneAndUpdate({ organizationId, _id: prototypeId, status: "ready" }, { status: "expired", ...TEARDOWN }, { new: true });
    if (!p) throw new Conflict("Only a live preview can be revoked");
    await audited(organizationId, userId, "prototype.expire", prototypeId);
    return p;
}

export async function cancelPrototype(organizationId: Id, prototypeId: Id, userId: string) {
    const p = await Prototype.findOneAndUpdate(
        { organizationId, _id: prototypeId, status: { $in: ["queued", "building", "testing", "needs_review"] } },
        { status: "cancelled", failureCode: "CANCELLED", ...TEARDOWN }, { new: true },
    );
    if (!p) throw new Conflict("Prototype can no longer be cancelled");
    await Workflow.updateMany({ organizationId, entityId: p._id, status: "queued" }, { status: "cancelled" });
    await Approval.updateMany({ organizationId, targetId: p._id, status: "pending" }, { status: "expired" });
    await audited(organizationId, userId, "prototype.cancel", prototypeId);
    return p;
}

export async function retryPrototype(organizationId: Id, prototypeId: Id, userId: string) {
    const p = await Prototype.findOne({ organizationId, _id: prototypeId });
    if (!p) throw new NotFound("Prototype not found");
    if (p.status !== "failed" || p.failureCode === "REJECTED") throw new Conflict("Only a failed build can be retried");
    const { config } = await getCurrentPolicy(organizationId);
    const estimate = config.prototypes.costPerAttemptMinor * config.prototypes.maxAttempts;
    if (await monthSpentMinor(organizationId) + estimate > config.prototypes.monthlyBudgetMinor) throw new Conflict("Monthly prototype budget exhausted");
    if (p.costMinorUnits + estimate > config.prototypes.maxPerPrototypeMinor) throw new Conflict("Retry would exceed the per-prototype limit; request a new build");

    const updated = await Prototype.findOneAndUpdate(
        { organizationId, _id: prototypeId, status: "failed" },
        { status: "queued", attempts: 0, maxAttempts: config.prototypes.maxAttempts, budgetMinorUnits: p.costMinorUnits + estimate, $inc: { retries: 1 }, $unset: { failureCode: 1 } },
        { new: true },
    );
    if (!updated) throw new Conflict("Prototype changed; reload");
    await startBuild(updated);
    await audited(organizationId, userId, "prototype.retry", prototypeId, { retries: updated.retries });
    return updated;
}

// housekeeping: expired previews lose their token and stored page
export async function expireStalePreviews(now = new Date()) {
    await Prototype.updateMany({ status: "ready", previewExpiresAt: { $lt: now } }, { status: "expired", ...TEARDOWN }).setOptions({ crossTenant: true });
}

// public preview lookup: the token is the only credential, so it must be live and unexpired
export async function findPreview(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const p = await Prototype.findOne({ previewToken: token, status: "ready" }).select("+artifactHtml +previewToken").setOptions({ crossTenant: true });
    if (!p || !p.previewExpiresAt || p.previewExpiresAt < new Date() || !p.artifactHtml) return null;
    return p.artifactHtml;
}
