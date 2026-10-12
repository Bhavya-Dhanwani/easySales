// Importing modules
import { isEnabled } from "../shared/flags/flags.service.js";
import nodemailer, { type Transporter } from "nodemailer";
import mongoose from "mongoose";
import transporter from "../shared/config/mail.config.js";
import env from "../shared/config/env.config.js";
import logger from "../shared/config/logger.config.js";
import EmailIntegration from "../shared/models/emailIntegration.model.js";
import { decryptSecret } from "../shared/utils/crypto.util.js";
import BusinessProfile from "../shared/models/businessProfile.model.js";
import Organization from "../shared/models/organization.model.js";
import { replyAddressFor } from "../shared/conversations/replyAddress.js";
import { brevoEnabled, brevoSend } from "./brevo.js";
import ApiError from "../shared/utils/ApiError.util.js";

export interface OutboundEmail {
    to: string;
    subject: string;
    text: string;
    // stable per message; becomes the RFC Message-ID so replies can be threaded back to it
    messageKey: string;
    inReplyTo?: string;
    references?: string[];
    // the conversation: replies to platform mail are routed back by it
    replyKey?: string;
}

export interface EmailProvider {
    readonly name: string;
    send(email: OutboundEmail): Promise<{ providerMessageId: string }>;
}

export class NoEmailIntegrationError extends ApiError {
    code = "NO_EMAIL_INTEGRATION";
    constructor() {
        super(409, "No email account is connected. Connect one under Settings → Email.");
    }
}

export const messageIdFor = (key: string, domain: string) => `<${key}@${domain}>`;

// nodemailer SMTP: our Message-ID, threading headers and a List-Unsubscribe header on every message
class SmtpProvider implements EmailProvider {
    readonly name = "smtp";
    constructor(private transport: Transporter, private from: string, private replyTo?: string) {}
    async send(email: OutboundEmail) {
        const domain = this.from.split("@").pop()?.replace(/>$/, "") || "easysales.local";
        const messageId = messageIdFor(email.messageKey, domain);
        await this.transport.sendMail({
            from: this.from,
            replyTo: this.replyTo,
            to: email.to,
            subject: email.subject,
            text: email.text,
            messageId,
            inReplyTo: email.inReplyTo,
            references: email.references,
            headers: { "List-Unsubscribe": `<mailto:${this.replyTo || this.from.replace(/.*</, "").replace(/>$/, "")}?subject=unsubscribe>` },
        });
        return { providerMessageId: messageId };
    }
}

/*
    The platform address (Brevo) for workspaces that skipped connecting their own mailbox:
    "<Business> via easySales" <platform sender>. Replies go to a signed per-conversation
    address on the platform reply inbox, which the worker reads.
*/
class PlatformProvider implements EmailProvider {
    readonly name = "platform";
    constructor(private businessName: string) {}
    async send(email: OutboundEmail) {
        const replyTo = env.PLATFORM_REPLY_EMAIL && email.replyKey ? { email: replyAddressFor(email.replyKey), name: this.businessName } : undefined;
        const headers: Record<string, string> = { "List-Unsubscribe": `<mailto:${replyTo?.email ?? env.PLATFORM_FROM_EMAIL}?subject=unsubscribe>` };
        if (email.inReplyTo) headers["In-Reply-To"] = email.inReplyTo;
        if (email.references?.length) headers.References = email.references.join(" ");
        const sent = await brevoSend({
            sender: { name: `${this.businessName} via ${env.PLATFORM_FROM_NAME}`.slice(0, 70), email: env.PLATFORM_FROM_EMAIL },
            to: [{ email: email.to }], replyTo, subject: email.subject, textContent: email.text, headers,
        });
        // Brevo's id is the message's Message-ID: replies and follow-ups thread on it
        return { providerMessageId: sent.messageId ?? messageIdFor(email.messageKey, env.PLATFORM_FROM_EMAIL.split("@")[1]) };
    }
}

// development delivery: logs instead of sending, behaves like a successful provider
class LogProvider implements EmailProvider {
    constructor(readonly name = "log", private domain = "easysales.local") {}
    async send(email: OutboundEmail) {
        logger.info({ subject: email.subject, provider: this.name }, "[email] captured outbound message (not delivered)");
        return { providerMessageId: messageIdFor(email.messageKey, this.domain) };
    }
}

let override: EmailProvider | null = null;
const cache = new Map<string, { at: number; provider: EmailProvider }>();

/*
    The sending account for a tenant: its connected integration, else (development only)
    the global SMTP/log fallback. Production refuses to send without a connected account.
*/
export async function getEmailProvider(organizationId: mongoose.Types.ObjectId | string): Promise<EmailProvider> {
    // pilot / internal testing: the whole pipeline runs, nothing reaches a real inbox
    if (!await isEnabled(organizationId, "live_email")) return new LogProvider("test", "easysales.test");
    if (override) return override;
    const integration = await EmailIntegration.findOne({ organizationId, status: { $ne: "disconnected" } }).lean();
    if (integration) {
        const key = String(organizationId);
        const hit = cache.get(key);
        if (hit && hit.at === integration.updatedAt.getTime()) return hit.provider;
        const smtp = integration.smtp!;
        const provider = new SmtpProvider(
            createTransport(smtp, decryptSecret(smtp.passwordEnc)),
            `"${integration.fromName.replace(/"/g, "")}" <${integration.fromEmail}>`,
            integration.replyTo ?? undefined,
        );
        cache.set(key, { at: integration.updatedAt.getTime(), provider });
        return provider;
    }
    // no own mailbox (or the user skipped): the platform address
    if (brevoEnabled()) return new PlatformProvider(await senderName(organizationId));
    if (env.NODE_ENV === "production") throw new NoEmailIntegrationError();
    return env.SEND_MAIL ? new SmtpProvider(transporter, env.SENDING_USER) : new LogProvider();
}

export function createTransport(smtp: { host: string; port: number; secure?: boolean | null; user: string }, password: string) {
    return nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: Boolean(smtp.secure), auth: { user: smtp.user, pass: password }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 });
}

async function senderName(organizationId: mongoose.Types.ObjectId | string) {
    const profile = await BusinessProfile.findOne({ organizationId }, { businessName: 1 }).lean();
    if (profile?.businessName) return profile.businessName;
    return (await Organization.findOne({ _id: organizationId }, { name: 1 }).lean())?.name ?? "Your business";
}

// tests and future adapters (SES, Postmark, Gmail API) plug in here
export function setEmailProvider(next: EmailProvider | null) {
    override = next;
}
