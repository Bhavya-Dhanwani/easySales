// Importing modules
import { alert } from "../../../shared/alerts/alert.service.js";
import express, { Request, Response } from "express";
import dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import EmailIntegration from "../../../shared/models/emailIntegration.model.js";
import { authorize, ctxOf } from "../../../shared/tenancy/orgContext.middleware.js";
import validate from "../../../shared/middlewares/validate.middleware.js";
import { audit } from "../../../shared/audit/audit.service.js";
import { encryptSecret, decryptSecret } from "../../../shared/utils/crypto.util.js";
import { isPrivateAddress } from "../../../shared/utils/safeFetch.util.js";
import { createTransport } from "../../../providers/email.provider.js";
import env from "../../../shared/config/env.config.js";
import Ok from "../../../shared/responses/Ok.response.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import NotFound from "../../../shared/errors/NotFound.error.js";

const router = express.Router();

const SMTP_PORTS = [25, 465, 587, 2525];

const ConnectSchema = z.object({
    fromName: z.string().trim().min(1).max(120),
    fromEmail: z.string().trim().toLowerCase().email(),
    replyTo: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
    host: z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "Invalid host"),
    port: z.coerce.number().int().refine((p) => SMTP_PORTS.includes(p), `Port must be one of ${SMTP_PORTS.join(", ")}`),
    secure: z.boolean().default(false),
    user: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(500),
}).strict();

// tenants choose the SMTP host, so the server must never be pointed at internal addresses
async function assertPublicHost(host: string) {
    const addrs = await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new BadRequest("SMTP host could not be resolved");
    if (addrs.some((a) => isPrivateAddress(a.address))) throw new BadRequest("SMTP host must be a public address");
}

// verifies credentials by logging in (no message is sent); replaceable in tests
export let verifySmtp = async (smtp: { host: string; port: number; secure: boolean; user: string }, password: string) => {
    await assertPublicHost(smtp.host);
    await createTransport(smtp, password).verify();
};
export const setSmtpVerifier = (fn: typeof verifySmtp) => { verifySmtp = fn; };

const webhookUrl = (id: unknown) => `${env.FRONTEND_URL.replace(/\/$/, "")}/api/webhooks/email/${id}`;

// never return credentials
const view = (i: InstanceType<typeof EmailIntegration> | null) => i && {
    _id: i._id, provider: i.provider, status: i.status, fromName: i.fromName, fromEmail: i.fromEmail, replyTo: i.replyTo,
    smtp: { host: i.smtp?.host, port: i.smtp?.port, secure: i.smtp?.secure, user: i.smtp?.user },
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
    return Ok(res, "Integrations", {
        integrations: [
            { provider: "email", status: email ? (email.status === "connected" ? "connected" : email.status === "error" ? "degraded" : "disconnected") : "disconnected", scopes: ["send", "receive_webhook"], lastHealthCheckAt: email?.lastVerifiedAt ?? null, details: view(email) },
            { provider: "crm", status: "not_available", scopes: [], lastHealthCheckAt: null, details: null },
            { provider: "calendar", status: "not_available", scopes: [], lastHealthCheckAt: null, details: null },
        ],
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
    return Ok(res, "Email integration", { integration: view(await EmailIntegration.findOne({ organizationId: ctx.organizationId })) });
});

/*
    @route POST /api/v1/integrations/email/connect
    @desc Verify SMTP credentials and store them encrypted. Returns the webhook secret once.
*/
router.post("/email/connect", authorize("org.manage"), validate(ConnectSchema), async (req: Request, res: Response) => {
    const ctx = ctxOf(req);
    const b = req.body as z.infer<typeof ConnectSchema>;
    const smtp = { host: b.host, port: b.port, secure: b.secure, user: b.user };
    try {
        await verifySmtp(smtp, b.password);
    } catch (error) {
        await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email.connect", outcome: "failure", metadata: { host: b.host, error: (error as Error).message } });
        throw new BadRequest(`Could not sign in to ${b.host}: ${(error as Error).message}`);
    }
    const webhookSecret = randomBytes(24).toString("base64url");
    const integration = await EmailIntegration.findOneAndUpdate(
        { organizationId: ctx.organizationId },
        {
            organizationId: ctx.organizationId, provider: "smtp", status: "connected", fromName: b.fromName, fromEmail: b.fromEmail, replyTo: b.replyTo || undefined,
            smtp: { ...smtp, passwordEnc: encryptSecret(b.password) }, webhookSecretEnc: encryptSecret(webhookSecret),
            lastVerifiedAt: new Date(), lastError: null, connectedBy: ctx.userId,
        },
        { upsert: true, new: true, runValidators: true },
    );
    await audit({ organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "integration.email.connect", targetType: "integration", targetId: String(integration._id), outcome: "success", metadata: { host: b.host, fromEmail: b.fromEmail } });
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

export default router;
