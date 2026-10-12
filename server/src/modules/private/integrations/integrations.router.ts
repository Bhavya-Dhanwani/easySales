// Importing modules
import { IntegrationConnection, OAUTH_PROVIDERS, OAuthProvider } from "../../../shared/models/integration.model.js";
import Workflow from "../../../shared/models/workflow.model.js";
import { connectionView, disconnect, startConnect, testConnection } from "../../../shared/integrations/connection.service.js";
import { FIELD_OWNERSHIP, syncErrors, syncStatus } from "../../../shared/integrations/sync.service.js";
import { startWorkflow } from "../../../shared/workflows/workflow.service.js";
import { alert } from "../../../shared/alerts/alert.service.js";
import express, { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import EmailIntegration from "../../../shared/models/emailIntegration.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { encryptSecret, decryptSecret } from "../../../shared/utils/crypto.util.js";
import { assertPublicHost } from "../../../shared/utils/safeFetch.util.js";
import { imapHostFor, verifyImap } from "../../../shared/conversations/imap.service.js";
import { detectMailServers } from "../../../shared/conversations/mailServers.js";
import { brevoEnabled } from "../../../providers/brevo.js";
import BusinessProfile from "../../../shared/models/businessProfile.model.js";
import Organization from "../../../shared/models/organization.model.js";
import { createTransport } from "../../../providers/email.provider.js";
import env from "../../../shared/config/env.config.js";
import Ok from "../../../shared/responses/Ok.response.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import NotFound from "../../../shared/errors/NotFound.error.js";

const router = express.Router();

const SMTP_PORTS = [25, 465, 587, 2525];

// only the email and its app password are required; servers are detected unless given (advanced)
const ConnectSchema = z.object({
    fromName: z.string().trim().min(1).max(120).optional(),
    fromEmail: z.string().trim().toLowerCase().email(),
    replyTo: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
    host: z.union([z.literal(""), z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "Invalid host")]).optional(),
    port: z.coerce.number().int().refine((p) => SMTP_PORTS.includes(p), `Port must be one of ${SMTP_PORTS.join(", ")}`).optional(),
    secure: z.boolean().optional(),
    user: z.union([z.literal(""), z.string().trim().min(1).max(200)]).optional(),
    password: z.string().min(1).max(500),
    // read replies from the inbox over IMAP with the same login (default host derived from the SMTP host)
    readInbox: z.boolean().default(true),
    imapHost: z.union([z.literal(""), z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "Invalid host")]).optional(),
    imapPort: z.coerce.number().int().refine((p) => p === 993 || p === 143, "IMAP port must be 993 or 143").default(993),
}).strict();

// verifies credentials by logging in (no message is sent); replaceable in tests
export let verifySmtp = async (smtp: { host: string; port: number; secure: boolean; user: string }, password: string) => {
    await assertPublicHost(smtp.host, "SMTP");
    await createTransport(smtp, password).verify();
};
export const setSmtpVerifier = (fn: typeof verifySmtp) => { verifySmtp = fn; };

const businessName = async (organizationId: unknown) =>
    (await BusinessProfile.findOne({ organizationId }, { businessName: 1 }).lean())?.businessName
    || (await Organization.findOne({ _id: organizationId }, { name: 1 }).lean())?.name || "Sales";

const webhookUrl = (id: unknown) => `${env.FRONTEND_URL.replace(/\/$/, "")}/api/webhooks/email/${id}`;

// never return credentials
const view = (i: InstanceType<typeof EmailIntegration> | null) => i && {
    _id: i._id, provider: i.provider, status: i.status, fromName: i.fromName, fromEmail: i.fromEmail, replyTo: i.replyTo,
    smtp: { host: i.smtp?.host, port: i.smtp?.port, secure: i.smtp?.secure, user: i.smtp?.user },
    imap: { enabled: Boolean(i.imap?.enabled), host: i.imap?.host, port: i.imap?.port, lastPolledAt: i.imap?.lastPolledAt, lastError: i.imap?.lastError },
    lastVerifiedAt: i.lastVerifiedAt, lastError: i.lastError, webhookUrl: webhookUrl(i._id), updatedAt: i.updatedAt,
};

/*
    @route GET /api/v1/integrations
    @desc Every integration with its health. Email is live; CRM and calendar adapters plug into the same
          /integrations/:provider/connect | test | DELETE shape (Sprint 8).
*/
router.get("/", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const email = await EmailIntegration.findOne({ organizationId: ctx.organizationId });
    const conns = await IntegrationConnection.find({ organizationId: ctx.organizationId }).lean();
    const oauth = (provider: string, kind: string) => {
        const c = conns.find((x) => x.provider === provider);
        return c ? { kind, ...connectionView(c), details: connectionView(c) } : { kind, provider, status: "disconnected", scopes: [], lastHealthCheckAt: null, details: null };
    };
    return Ok(res, "Integrations", {
        integrations: [
            { kind: "email", provider: "email", status: email ? (email.status === "connected" ? "connected" : email.status === "error" ? "degraded" : "disconnected") : "disconnected", scopes: ["send", "receive_webhook"], lastHealthCheckAt: email?.lastVerifiedAt ?? null, details: view(email) },
            oauth("hubspot", "crm"),
            oauth("google_calendar", "calendar"),
        ],
        fieldOwnership: FIELD_OWNERSHIP,
    });
});

// periodic health check (worker): a revoked password or dead host shows up before a send fails
export async function healthCheckIntegrations(olderThanMs = 6 * 3600_000) {
    const due = await EmailIntegration.find({ status: { $ne: "disconnected" }, $or: [{ lastVerifiedAt: null }, { lastVerifiedAt: { $lt: new Date(Date.now() - olderThanMs) } }] })
        .limit(50).setOptions({ crossTenant: true });
    for (const i of due) {
        const was = i.status;
        try {
            await verifySmtp({ host: i.smtp!.host, port: i.smtp!.port, secure: Boolean(i.smtp!.secure), user: i.smtp!.user }, decryptSecret(i.smtp!.passwordEnc));
            Object.assign(i, { status: "connected", lastVerifiedAt: new Date(), lastError: undefined });
        } catch (error) {
            Object.assign(i, { status: "error", lastVerifiedAt: new Date(), lastError: (error as Error).message.slice(0, 300) });
            if (was !== "error") await alert(i.organizationId, "provider_outage", `Email account ${i.fromEmail} failed its health check: ${i.lastError}`);
        }
        await i.save();
    }
}

/*
    @route GET /api/v1/integrations/email
*/
router.get("/email", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Email integration", {
        integration: view(await EmailIntegration.findOne({ organizationId: ctx.organizationId })),
        // without an own mailbox, mail goes from the platform address ("<Business> via easySales")
        platform: brevoEnabled() ? { from: env.PLATFORM_FROM_EMAIL, name: `${await businessName(ctx.organizationId)} via ${env.PLATFORM_FROM_NAME}`, readsReplies: Boolean(env.PLATFORM_REPLY_EMAIL && env.PLATFORM_REPLY_PASSWORD) } : null,
    });
});

/*
    @route POST /api/v1/integrations/email/connect
    @desc Verify SMTP credentials and store them encrypted. Returns the webhook secret once.
*/
router.post("/email/connect", authorize("org.manage"), validate(ConnectSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const b = req.body as z.infer<typeof ConnectSchema>;
    const detected = b.host ? null : await detectMailServers(b.fromEmail);
    const port = b.port ?? detected?.smtpPort ?? 587;
    const smtp = { host: b.host || detected!.smtpHost, port, secure: b.secure ?? (b.port ? port === 465 : detected!.secure), user: b.user || b.fromEmail };
    const fromName = b.fromName || await businessName(ctx.organizationId);
    try {
        await verifySmtp(smtp, b.password);
    } catch (error) {
        await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email.connect", outcome: "failure", metadata: { host: smtp.host, error: (error as Error).message } });
        const hint = /auth|credential|password|535|534/i.test((error as Error).message)
            ? " Use an app password, not your normal password (Gmail: Google Account → Security → 2-Step Verification → App passwords)."
            : "";
        throw new BadRequest(`Could not sign in to ${detected?.provider ?? smtp.host} (${smtp.host}): ${(error as Error).message}.${hint}`);
    }
    let imap: Record<string, unknown> = { enabled: false };
    if (b.readInbox) {
        const cfg = { host: b.imapHost || detected?.imapHost || imapHostFor(smtp.host), port: b.imapPort, user: smtp.user };
        try {
            imap = { enabled: true, host: cfg.host, port: cfg.port, ...(await verifyImap(cfg, b.password)) };
        } catch (error) {
            throw new BadRequest(`Sending works, but reading the inbox at ${cfg.host} failed: ${(error as Error).message}. Check the IMAP host, enable IMAP for the mailbox, or untick "Read replies from inbox".`);
        }
    }
    const webhookSecret = randomBytes(24).toString("base64url");
    const integration = await EmailIntegration.findOneAndUpdate(
        { organizationId: ctx.organizationId },
        {
            organizationId: ctx.organizationId, provider: "smtp", status: "connected", fromName, fromEmail: b.fromEmail, replyTo: b.replyTo || undefined,
            smtp: { ...smtp, passwordEnc: encryptSecret(b.password) }, imap, webhookSecretEnc: encryptSecret(webhookSecret),
            lastVerifiedAt: new Date(), lastError: null, connectedBy: ctx.userId,
        },
        { upsert: true, new: true, runValidators: true },
    );
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email.connect", targetType: "integration", targetId: String(integration._id), outcome: "success", metadata: { host: smtp.host, fromEmail: b.fromEmail, readInbox: Boolean(imap.enabled) } });
    return Ok(res, "Email account connected", { integration: view(integration), webhookSecret });
});

/*
    @route POST /api/v1/integrations/email/test
    @desc Re-verify the stored credentials (integration health check)
*/
router.post("/email/test", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const i = await EmailIntegration.findOne({ organizationId: ctx.organizationId });
    if (!i?.smtp) throw new NotFound("No email account connected");
    try {
        await verifySmtp({ host: i.smtp.host, port: i.smtp.port, secure: Boolean(i.smtp.secure), user: i.smtp.user }, decryptSecret(i.smtp.passwordEnc));
        i.status = "connected";
        i.lastVerifiedAt = new Date();
        i.lastError = undefined;
    } catch (error) {
        i.status = "error";
        i.lastError = (error as Error).message.slice(0, 300);
    }
    await i.save();
    return Ok(res, i.status === "connected" ? "Connection healthy" : "Connection failed", { integration: view(i) });
});

/*
    @route POST /api/v1/integrations/email/rotate-secret
*/
router.post("/email/rotate-secret", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const webhookSecret = randomBytes(24).toString("base64url");
    const i = await EmailIntegration.findOneAndUpdate({ organizationId: ctx.organizationId }, { webhookSecretEnc: encryptSecret(webhookSecret) }, { new: true });
    if (!i) throw new NotFound("No email account connected");
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email.rotate_secret", outcome: "success" });
    return Ok(res, "Webhook secret rotated", { integration: view(i), webhookSecret });
});

/*
    @route DELETE /api/v1/integrations/email
    @desc Disconnect: credentials are deleted, queued outreach stays queued until a new account is connected
*/
router.delete("/email", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const removed = await EmailIntegration.findOneAndDelete({ organizationId: ctx.organizationId });
    if (!removed) throw new NotFound("No email account connected");
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email.disconnect", outcome: "success" });
    return Ok(res, "Email account disconnected");
});

/* --------------------------- OAuth providers --------------------------- */

const providerOf = (req: Request) => {
    const p = String(req.params.provider);
    if (!(OAUTH_PROVIDERS as readonly string[]).includes(p)) throw new NotFound("Unknown integration");
    return p as OAuthProvider;
};

/*
    @route POST /api/v1/integrations/:provider/connect
    @desc Start OAuth (state + PKCE). Returns the provider's consent URL to open.
*/
router.post("/:provider/connect", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Open the consent page", await startConnect(ctx.organizationId, ctx.userId, providerOf(req)));
});

router.post("/:provider/test", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Connection checked", await testConnection(ctx.organizationId, providerOf(req)));
});

router.delete("/:provider", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    await disconnect(ctx.organizationId, providerOf(req), ctx.userId);
    return Ok(res, "Disconnected; access was revoked and stored tokens deleted");
});

const SettingsSchema = z.object({
    stageOwner: z.enum(["platform", "crm"]).optional(),
    timezone: z.string().max(60).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone").optional(),
    workStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    workEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    meetingMinutes: z.number().int().min(10).max(240).optional(),
    bufferMinutes: z.number().int().min(0).max(120).optional(),
    minNoticeHours: z.number().int().min(0).max(336).optional(),
}).strict();

router.patch("/:provider/settings", authorize("org.manage"), validate(SettingsSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const provider = providerOf(req);
    const set = Object.fromEntries(Object.entries(req.body).map(([k, v]) => [`settings.${k}`, v]));
    const conn = await IntegrationConnection.findOneAndUpdate({ organizationId: ctx.organizationId, provider }, set, { new: true }).lean();
    if (!conn) throw new NotFound(`${provider} is not connected`);
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.settings", targetType: "integration", targetId: String(conn._id), outcome: "success", metadata: req.body });
    return Ok(res, "Settings saved", { integration: connectionView(conn) });
});

/*
    @route POST /api/v1/integrations/:provider/sync
    @desc Start (or resume) an incremental CRM import as a durable job (202)
*/
router.post("/:provider/sync", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    if (providerOf(req) !== "hubspot") throw new NotFound("Only CRM integrations sync records");
    const conn = await IntegrationConnection.findOne({ organizationId: ctx.organizationId, provider: "hubspot", status: { $ne: "disconnected" } }).lean();
    if (!conn) throw new NotFound("HubSpot is not connected");
    const running = await Workflow.findOne({ organizationId: ctx.organizationId, type: "integration.sync", status: { $in: ["queued", "running"] } }).lean();
    const { workflow } = running ? { workflow: running } : await startWorkflow({
        organizationId: ctx.organizationId, type: "integration.sync", entityType: "integration", entityId: conn._id,
        idempotencyKey: `crm-sync:${conn._id}:${Date.now()}`, startedBy: ctx.userId, actor: { type: "user", id: ctx.userId },
    });
    return res.status(202).json({ success: true, status: 202, message: running ? "A sync is already running" : "Sync started", data: { workflowId: workflow._id } });
});

router.get("/:provider/sync-status", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Sync status", { status: await syncStatus(ctx.organizationId, providerOf(req)) });
});

router.get("/:provider/errors", authorize("org.manage"), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    return Ok(res, "Sync errors", await syncErrors(ctx.organizationId, providerOf(req)));
});

export default router;
