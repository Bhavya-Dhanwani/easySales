// Importing modules
import { BrevoClient } from "@getbrevo/brevo";
import env from "../shared/config/env.config.js";

export interface BrevoEmail {
    sender: { name: string; email: string };
    to: { email: string }[];
    replyTo?: { email: string; name?: string };
    subject: string;
    textContent?: string;
    htmlContent?: string;
    headers?: Record<string, string>;
}

// the platform address is usable once a key and a (Brevo-verified) sender are set
export const brevoEnabled = () => Boolean(env.BREVO_API_KEY && env.PLATFORM_FROM_EMAIL);

// without Brevo, the SMTP account in .env (e.g. a Gmail + app password) is the platform address
const smtpPlatform = () => !brevoEnabled() && Boolean(env.SMTP_USER && env.SMTP_PASS && env.SMTP_USER.includes("@"));
export const platformMailEnabled = () => brevoEnabled() || smtpPlatform();
export const platformFromEmail = () => (brevoEnabled() ? env.PLATFORM_FROM_EMAIL : env.SMTP_USER);

// where replies to platform mail arrive: the configured reply inbox, else the SMTP mailbox itself
export const platformReplyInbox = () => (env.PLATFORM_REPLY_EMAIL && env.PLATFORM_REPLY_PASSWORD
    ? { email: env.PLATFORM_REPLY_EMAIL, password: env.PLATFORM_REPLY_PASSWORD }
    : smtpPlatform() ? { email: env.SMTP_USER, password: env.SMTP_PASS } : null);

let send: ((email: BrevoEmail) => Promise<{ messageId?: string }>) | null = null;

export function brevoSend(email: BrevoEmail) {
    if (!send) {
        const client = new BrevoClient({ apiKey: env.BREVO_API_KEY });
        send = async (e) => client.transactionalEmails.sendTransacEmail(e) as Promise<{ messageId?: string }>;
    }
    return send(email);
}

// tests replace Brevo with an in-memory outbox
export const setBrevoSender = (fn: typeof send) => { send = fn; };
