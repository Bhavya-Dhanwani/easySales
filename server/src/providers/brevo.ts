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
