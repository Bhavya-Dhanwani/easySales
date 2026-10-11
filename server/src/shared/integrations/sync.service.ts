// Importing modules
import mongoose from "mongoose";
import { ExternalRecord, IntegrationConnection, IntegrationEvent } from "../models/integration.model.js";
import Lead, { leadDedupeKey } from "../models/lead.model.js";
import Proposal from "../models/proposal.model.js";
import Workflow from "../models/workflow.model.js";
import { startWorkflow } from "../workflows/workflow.service.js";
import { recordStage } from "../analytics/analytics.service.js";
import { audit } from "../audit/audit.service.js";
import logger from "../config/logger.config.js";
import { hubspot } from "./providers.js";
import { NormalizedCompany, NormalizedContact } from "./core.js";
import { withProvider } from "./connection.service.js";

type Id = mongoose.Types.ObjectId | string;
type Conn = InstanceType<typeof IntegrationConnection>;

/*
    Who owns which field. Pulls apply only CRM-owned fields; pushes write only
    platform-owned fields (CRM-owned values are sent once, when we create the record).
    Neither side overwrites the other, so "last write wins" never happens.
*/
export const FIELD_OWNERSHIP = [
    { field: "Contact name, title, phone", owner: "crm" },
    { field: "Contact email (identity)", owner: "crm" },
    { field: "Company name, domain, industry, size, country", owner: "crm" },
    { field: "External record ids", owner: "crm" },
    { field: "AI research, evidence, fit score", owner: "platform" },
    { field: "Consent basis and do-not-contact", owner: "platform" },
    { field: "Pipeline stage", owner: "configurable (settings.stageOwner)" },
    { field: "Deal amount (from the latest sent proposal)", owner: "platform" },
    { field: "Proposal versions and approvals", owner: "platform" },
    { field: "Email delivery status", owner: "email provider" },
    { field: "Calendar event status", owner: "calendar provider" },
] as const;

const map = (organizationId: Id, conn: Conn, entityType: "contact" | "company" | "deal") => ({ organizationId, connectionId: conn._id, entityType });

/* ------------------------------- pull ------------------------------- */

// a company is stored once as a mapping snapshot; its CRM-owned fields fan out to the leads that work there
async function applyCompany(organizationId: Id, conn: Conn, c: NormalizedCompany) {
    const existing = await ExternalRecord.findOne({ ...map(organizationId, conn, "company"), externalRecordId: c.externalId }).lean();
    if (existing?.lastExternalUpdatedAt && existing.lastExternalUpdatedAt >= c.updatedAt) return "skipped";
    const snapshot = { name: c.name, domain: c.domain, industry: c.industry, employees: c.employees, country: c.country };
    await ExternalRecord.updateOne(
        { ...map(organizationId, conn, "company"), externalRecordId: c.externalId },
        { $set: { provider: conn.provider, snapshot, lastExternalUpdatedAt: c.updatedAt, lastSyncedAt: new Date(), lastSyncStatus: "success" } },
        { upsert: true },
    );
    await Lead.updateMany({ organizationId, crmCompanyId: c.externalId }, { $set: companyFields(snapshot) });
    return existing ? "updated" : "created";
}

const companyFields = (s: { name?: string; domain?: string; industry?: string; employees?: number; country?: string }) => Object.fromEntries(Object.entries({
    "company.name": s.name, "company.domain": s.domain, "company.industry": s.industry, "company.employeeCount": s.employees, "company.country": s.country,
}).filter(([, v]) => v !== undefined && v !== ""));

async function companySnapshot(organizationId: Id, conn: Conn, token: string, externalId?: string) {
    if (!externalId) return null;
    let m = await ExternalRecord.findOne({ ...map(organizationId, conn, "company"), externalRecordId: externalId }).lean();
    if (!m) {
        const c = await hubspot.getCompany(token, externalId);
        if (c) await applyCompany(organizationId, conn, c);
        m = await ExternalRecord.findOne({ ...map(organizationId, conn, "company"), externalRecordId: externalId }).lean();
    }
    return (m?.snapshot ?? null) as { name?: string; domain?: string; industry?: string; employees?: number; country?: string } | null;
}

/*
    One CRM contact → at most one lead. Order of matching: existing mapping, then the same
    email (dedupe key) already in the workspace, else a new lead. Out-of-order updates
    (older than the last one applied) are ignored.
*/
export async function applyContact(organizationId: Id, conn: Conn, token: string, c: NormalizedContact) {
    const mapping = await ExternalRecord.findOne({ ...map(organizationId, conn, "contact"), externalRecordId: c.externalId }).lean();
    if (mapping?.lastExternalUpdatedAt && mapping.lastExternalUpdatedAt >= c.updatedAt) return "skipped";
    if (!c.email && !mapping) return "skipped";
    const company = await companySnapshot(organizationId, conn, token, c.companyExternalId);
    const contactSet = Object.fromEntries(Object.entries({
        "contact.name": [c.firstName, c.lastName].filter(Boolean).join(" ") || undefined, "contact.title": c.title, "contact.phone": c.phone,
    }).filter(([, v]) => v !== undefined));
    const crmFields = { ...contactSet, ...(company ? companyFields(company) : {}), ...(c.companyExternalId ? { crmCompanyId: c.companyExternalId } : {}) };

    let lead = mapping?.internalRecordId ? await Lead.findOne({ organizationId, _id: mapping.internalRecordId }) : null;
    let outcome: "created" | "linked" | "updated";
    if (lead) {
        lead.set(crmFields);
        // the CRM owns identity: a changed email follows, unless another lead already has it
        if (c.email && c.email !== lead.contact?.email && !await Lead.exists({ organizationId, dedupeKey: `email:${c.email}` })) {
            lead.set({ "contact.email": c.email, dedupeKey: `email:${c.email}` });
        }
        await lead.save();
        outcome = "updated";
    } else {
        lead = await Lead.findOne({ organizationId, dedupeKey: `email:${c.email}` });
        if (lead) {
            lead.set(crmFields);
            await lead.save();
            outcome = "linked";
        } else {
            const doc = {
                company: { name: company?.name || c.companyName || "Unknown company", domain: company?.domain, industry: company?.industry, employeeCount: company?.employees, country: company?.country },
                contact: { name: [c.firstName, c.lastName].filter(Boolean).join(" ") || undefined, title: c.title, email: c.email, phone: c.phone },
            };
            try {
                // consent is never assumed from a CRM import: outreach stays blocked until a basis is recorded
                lead = await Lead.create({ organizationId, ...doc, dedupeKey: leadDedupeKey(doc), crmCompanyId: c.companyExternalId, consent: { basis: "none", source: `${conn.provider} import` }, source: { provider: "provider", externalId: `${conn.provider}:${c.externalId}` } });
                outcome = "created";
                await recordStage(organizationId, lead._id, "discovered", { source: conn.provider });
            } catch (error) {
                // another sync created it a moment ago: link to it
                if ((error as { code?: number }).code !== 11000) throw error;
                lead = (await Lead.findOne({ organizationId, dedupeKey: leadDedupeKey(doc) }))!;
                outcome = "linked";
            }
        }
    }
    await ExternalRecord.updateOne(
        { ...map(organizationId, conn, "contact"), externalRecordId: c.externalId },
        { $set: { provider: conn.provider, internalRecordId: lead!._id, lastExternalUpdatedAt: c.updatedAt, lastSyncedAt: new Date(), lastSyncStatus: "success", lastError: null } },
        { upsert: true },
    );
    return outcome;
}

/*
    Initial and incremental import. Pages are applied in "last modified" order and the
    checkpoint is saved after every page, so an interrupted sync resumes where it stopped;
    re-applying a page is harmless (mappings are unique, stale updates are skipped).
*/
export async function pullSync(organizationId: Id) {
    const counts = { created: 0, linked: 0, updated: 0, skipped: 0 };
    await withProvider(organizationId, "hubspot", async (token, conn) => {
        for (const kind of ["companies", "contacts"] as const) {
            let since = conn.cursors?.get(kind) ?? 0;
            let after: string | undefined;
            do {
                const page = kind === "companies" ? await hubspot.searchCompanies(token, since, after) : await hubspot.searchContacts(token, since, after);
                for (const item of page.items) {
                    const r = kind === "companies" ? await applyCompany(organizationId, conn, item as NormalizedCompany) : await applyContact(organizationId, conn, token, item as NormalizedContact);
                    if (kind === "contacts") counts[r as keyof typeof counts] += 1;
                    since = Math.max(since, item.updatedAt.getTime());
                }
                after = page.next;
                await IntegrationConnection.updateOne({ organizationId, _id: conn._id }, { [`cursors.${kind}`]: since });
            } while (after);
        }
        await IntegrationConnection.updateOne({ organizationId, _id: conn._id }, { lastSyncAt: new Date(), lastError: null, status: "connected" });
    });
    await audit({ organizationId, actorType: "system", actorId: "integrations:hubspot", action: "integration.sync", targetType: "integration", outcome: "success", metadata: counts });
    return counts;
}

/* ------------------------------- push ------------------------------- */

const PUSH_STAGES = new Set(["icp_qualified", "positive_reply", "qualified_opportunity", "proposal_sent", "won", "lost"]);

// called on every recorded funnel stage: a connected CRM gets the change through a durable job
export async function queueCrmPush(organizationId: Id, leadId: Id, stage: string) {
    if (!PUSH_STAGES.has(stage)) return;
    if (!await IntegrationConnection.exists({ organizationId, provider: "hubspot", status: "connected" })) return;
    await startWorkflow({
        organizationId: new mongoose.Types.ObjectId(String(organizationId)), type: "integration.push", entityType: "lead", entityId: new mongoose.Types.ObjectId(String(leadId)),
        idempotencyKey: `crm-push:${leadId}:${stage}`, actor: { type: "system", id: "integrations" },
    });
}

/*
    Lead → company, contact and deal in the CRM. Before any create we look the record up
    (domain, email, deal name), so a retry after an ambiguous response adopts what the
    first attempt created instead of making a duplicate.
*/
export async function pushLead(organizationId: Id, leadId: Id) {
    const lead = await Lead.findOne({ organizationId, _id: leadId });
    if (!lead || lead.isTest) return { outcome: "skipped" };
    return withProvider(organizationId, "hubspot", async (token, conn) => {
        const done = async (entityType: "contact" | "company" | "deal", externalRecordId: string, internal: boolean) => {
            await ExternalRecord.updateOne(
                { ...map(organizationId, conn, entityType), externalRecordId },
                { $set: { provider: "hubspot", ...(internal ? { internalRecordId: lead._id } : { snapshot: { name: lead.company.name, domain: lead.company.domain } }), lastSyncedAt: new Date(), lastSyncStatus: "success", lastError: null } },
                { upsert: true },
            );
        };

        let companyId = lead.crmCompanyId ?? (lead.company.domain ? await hubspot.findCompanyByDomain(token, lead.company.domain) : null);
        if (!companyId) companyId = await hubspot.upsertCompany(token, null, { name: lead.company.name, domain: lead.company.domain ?? undefined, industry: lead.company.industry ?? undefined, employees: lead.company.employeeCount ?? undefined, country: lead.company.country ?? undefined });
        if (lead.crmCompanyId !== companyId) await Lead.updateOne({ organizationId, _id: lead._id }, { crmCompanyId: companyId });
        await done("company", companyId, false);

        let contactId: string | null = null;
        if (lead.contact?.email) {
            const m = await ExternalRecord.findOne({ ...map(organizationId, conn, "contact"), internalRecordId: lead._id }).lean();
            contactId = m?.externalRecordId ?? await hubspot.findContactByEmail(token, lead.contact.email);
            if (!contactId) {
                const [firstName, ...rest] = (lead.contact.name ?? "").split(" ");
                contactId = await hubspot.upsertContact(token, null, { email: lead.contact.email, firstName: firstName || undefined, lastName: rest.join(" ") || undefined, title: lead.contact.title ?? undefined, phone: lead.contact.phone ?? undefined, companyExternalId: companyId });
            }
            await done("contact", contactId, true);
        }

        const stage = hubspot.stageOut(lead.opportunityStage);
        if (stage) {
            const proposal = await Proposal.findOne({ organizationId, leadId: lead._id, status: { $in: ["sent", "accepted"] } }).sort({ version: -1 }).lean();
            const m = await ExternalRecord.findOne({ ...map(organizationId, conn, "deal"), internalRecordId: lead._id }).lean();
            const name = `${lead.company.name} · easySales ${String(lead._id).slice(-6)}`;
            const existingId = m?.externalRecordId ?? await hubspot.findDealByName(token, name);
            const ownStage = conn.settings?.stageOwner !== "crm";
            // when the CRM owns the stage we set it only on create; later we only update the amount
            const deal = { name, stage: ownStage || !existingId ? stage : "", amountMinor: proposal?.totalMinor, contactExternalId: contactId ?? undefined, companyExternalId: companyId };
            const dealId = await hubspot.upsertDeal(token, existingId, deal, Boolean(existingId));
            await done("deal", dealId, true);
        }
        return { outcome: "pushed", companyId, contactId };
    });
}

/* ----------------------------- webhooks ----------------------------- */

/*
    Stored provider events → applied. The tenant is the connection's, resolved when the event
    was stored; the payload only names objects, which are re-read from the provider.
*/
export async function processIntegrationEvents(limit = 50) {
    for (let i = 0; i < limit; i++) {
        const evt = await IntegrationEvent.findOneAndUpdate(
            { status: "pending" }, { status: "processing", lockedUntil: new Date(Date.now() + 120_000), $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true },
        ).setOptions({ crossTenant: true });
        if (!evt) return;
        const organizationId = evt.organizationId;
        try {
            const result = await withProvider(organizationId, "hubspot", async (token, conn) => {
                if (String(conn._id) !== String(evt.connectionId)) return "ignored";
                const [object, change] = evt.type.split(".");
                if (change === "deletion") {
                    await ExternalRecord.updateOne({ ...map(organizationId, conn, object as "contact" | "company" | "deal"), externalRecordId: evt.objectId }, { lastSyncStatus: "deleted_externally", lastSyncedAt: new Date() });
                    return "processed";
                }
                if (object === "contact") {
                    const c = await hubspot.getContact(token, evt.objectId!);
                    if (c) await applyContact(organizationId, conn, token, c);
                } else if (object === "company") {
                    const c = await hubspot.getCompany(token, evt.objectId!);
                    if (c) await applyCompany(organizationId, conn, c);
                } else if (object === "deal" && conn.settings?.stageOwner === "crm") {
                    const p = evt.payload as { propertyName?: string; propertyValue?: string };
                    const m = await ExternalRecord.findOne({ ...map(organizationId, conn, "deal"), externalRecordId: evt.objectId }).lean();
                    const stage = p.propertyName === "dealstage" && p.propertyValue ? hubspot.stageIn(p.propertyValue) : null;
                    if (m?.internalRecordId && stage) {
                        await Lead.updateOne({ organizationId, _id: m.internalRecordId }, { opportunityStage: stage });
                        if (stage === "won" || stage === "lost") await recordStage(organizationId, m.internalRecordId, stage, { via: "crm" });
                    }
                } else return "ignored";
                return "processed";
            });
            await IntegrationEvent.updateOne({ organizationId, _id: evt._id }, { status: result, lockedUntil: null, error: null });
        } catch (error) {
            const giveUp = evt.attempts >= 5 || (error as { code?: string }).code === "RECONNECT_REQUIRED";
            await IntegrationEvent.updateOne({ organizationId, _id: evt._id }, { status: giveUp ? "failed" : "pending", lockedUntil: null, error: (error as Error).message.slice(0, 300) });
            logger.warn({ eventId: evt.eventId, error: (error as Error).message }, "Integration event failed");
        }
    }
}

// sync status for the dashboard: checkpoints, mapped records, running/pending jobs
export async function syncStatus(organizationId: mongoose.Types.ObjectId, provider: string) {
    const conn = await IntegrationConnection.findOne({ organizationId, provider }).lean();
    if (!conn) return null;
    const [mapped, running, pendingPushes, pendingEvents] = await Promise.all([
        ExternalRecord.aggregate([{ $match: { organizationId, connectionId: conn._id } }, { $group: { _id: { t: "$entityType", s: "$lastSyncStatus" }, n: { $sum: 1 } } }]),
        Workflow.findOne({ organizationId, type: "integration.sync", status: { $in: ["queued", "running"] } }, { status: 1, createdAt: 1 }).lean(),
        Workflow.countDocuments({ organizationId, type: "integration.push", status: { $in: ["queued", "running"] } }),
        IntegrationEvent.countDocuments({ organizationId, connectionId: conn._id, status: { $in: ["pending", "processing"] } }),
    ]);
    return {
        status: conn.status, lastSyncAt: conn.lastSyncAt ?? null, checkpoints: Object.fromEntries(Object.entries(conn.cursors ?? {}).map(([k, v]) => [k, new Date(v as number)])),
        mapped: mapped.map((m) => ({ entityType: m._id.t, status: m._id.s, count: m.n })), syncRunning: Boolean(running), pendingPushes, pendingEvents,
        fieldOwnership: FIELD_OWNERSHIP, stageOwner: conn.settings?.stageOwner ?? "platform", lastError: conn.lastError ?? null,
    };
}

// actionable errors: failed jobs, records that failed to sync, events that could not be applied
export async function syncErrors(organizationId: mongoose.Types.ObjectId, provider: string) {
    const conn = await IntegrationConnection.findOne({ organizationId, provider }).lean();
    if (!conn) return { errors: [] };
    const [jobs, records, events] = await Promise.all([
        Workflow.find({ organizationId, type: { $in: ["integration.sync", "integration.push"] }, status: "failed" }, { type: 1, failureCode: 1, lastError: 1, updatedAt: 1, entityId: 1 }).sort({ updatedAt: -1 }).limit(50).lean(),
        ExternalRecord.find({ organizationId, connectionId: conn._id, lastSyncStatus: { $in: ["failed", "deleted_externally"] } }).sort({ updatedAt: -1 }).limit(50).lean(),
        IntegrationEvent.find({ organizationId, connectionId: conn._id, status: "failed" }, { type: 1, objectId: 1, error: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(50).lean(),
    ]);
    const fix = (code?: string | null) => code === "RECONNECT_REQUIRED" ? "Reconnect the integration" : code === "RATE_LIMITED" ? "Wait; it retries automatically" : "Check the record in the CRM, then retry the sync";
    return {
        errors: [
            ...jobs.map((j) => ({ kind: j.type, id: String(j._id), at: j.updatedAt, message: j.lastError, action: fix(j.failureCode) })),
            ...records.map((r) => ({ kind: `${r.entityType} record`, id: r.externalRecordId, at: r.updatedAt, message: r.lastSyncStatus === "deleted_externally" ? "Deleted in the CRM; kept here (history is never deleted by a sync)" : r.lastError, action: r.lastSyncStatus === "deleted_externally" ? "Nothing to do, or delete the lead here" : "Retry the sync" })),
            ...events.map((e) => ({ kind: `webhook ${e.type}`, id: e.objectId, at: e.updatedAt, message: e.error, action: "Retry the sync to re-read the record" })),
        ],
    };
}
