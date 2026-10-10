// Importing modules
import transporter from "../shared/config/mail.config.js";
import env from "../shared/config/env.config.js";
import logger from "../shared/config/logger.config.js";

export interface OutboundEmail {
    to: string;
    subject: string;
    text: string;
    // stable per message, so a provider-side duplicate can be detected
    messageKey: string;
}

export interface EmailProvider {
    readonly name: string;
    send(email: OutboundEmail): Promise<{ providerMessageId: string }>;
}

// real SMTP delivery via nodemailer
class SmtpProvider implements EmailProvider {
    readonly name = "smtp";
    async send(email: OutboundEmail) {
        const info = await transporter.sendMail({
            from: env.SENDING_USER,
            to: email.to,
            subject: email.subject,
            text: email.text,
            headers: {
                "X-EasySales-Message": email.messageKey,
                "List-Unsubscribe": `<mailto:${env.SMTP_USER || "unsubscribe@example.com"}?subject=unsubscribe>`,
            },
        });
        return { providerMessageId: info.messageId };
    }
}

// development / demo delivery: logs instead of sending, behaves like a successful provider
class LogProvider implements EmailProvider {
    readonly name = "log";
    async send(email: OutboundEmail) {
        logger.info({ to: email.to, subject: email.subject }, "[email:log] outbound message (SEND_MAIL=false)");
        return { providerMessageId: `log-${email.messageKey}` };
    }
}

let provider: EmailProvider = env.SEND_MAIL ? new SmtpProvider() : new LogProvider();

export const getEmailProvider = () => provider;

// tests and future adapters (SES, Postmark, Gmail API) plug in here
export function setEmailProvider(next: EmailProvider) {
    provider = next;
}
