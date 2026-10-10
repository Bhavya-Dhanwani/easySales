// Importing modules
import nodemailer, { type Transporter } from "nodemailer";
import mongoose from "mongoose";
import transporter from "../shared/config/mail.config.js";
import env from "../shared/config/env.config.js";
import logger from "../shared/config/logger.config.js";
import EmailIntegration from "../shared/models/emailIntegration.model.js";
import { decryptSecret } from "../shared/utils/crypto.util.js";
import ApiError from "../shared/utils/ApiError.util.js";

export interface OutboundEmail {
    to: string;
    subject: string;
    text: string;
    // stable per message; becomes the RFC Message-ID so replies can be threaded back to it
    messageKey: string;
    inReplyTo?: string;
    references?: string[];
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

// development delivery: logs instead of sending, behaves like a successful provider
class LogProvider implements EmailProvider {
    readonly name = "log";
    async send(email: OutboundEmail) {
        logger.info({ to: email.to, subject: email.subject }, "[email:log] outbound message (no account connected, SEND_MAIL=false)");
        return { providerMessageId: messageIdFor(email.messageKey, "easysales.local") };
    }
}

let override: EmailProvider | null = null;
const cache = new Map<string, { at: number; provider: EmailProvider }>();

/*
    The sending account for a tenant: its connected integration, else (development only)
    the global SMTP/log fallback. Production refuses to send without a connected account.
*/
export async function getEmailProvider(organizationId: mongoose.Types.ObjectId | string): Promise<EmailProvider> {
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
    if (env.NODE_ENV === "production") throw new NoEmailIntegrationError();
    return env.SEND_MAIL ? new SmtpProvider(transporter, env.SENDING_USER) : new LogProvider();
}

export function createTransport(smtp: { host: string; port: number; secure?: boolean | null; user: string }, password: string) {
    return nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: Boolean(smtp.secure), auth: { user: smtp.user, pass: password }, connectionTimeout: 10_000 });
}

// tests and future adapters (SES, Postmark, Gmail API) plug in here
export function setEmailProvider(next: EmailProvider | null) {
    override = next;
}
