// Importing modules
import transporter from "../config/mail.config.js";
import logger from "../config/logger.config.js";
import env from "../config/env.config.js";
import { brevoEnabled, brevoSend } from "../../providers/brevo.js";

// sends transactional (account) mail with a plain-text part; failures are logged instead of crashing the process
function sendMail(to: string, subject: string, html: string, text?: string) {
    if (brevoEnabled()) {
        brevoSend({ sender: { name: env.PLATFORM_FROM_NAME, email: env.PLATFORM_FROM_EMAIL }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
            .catch((error: unknown) => logger.error({ error: (error as Error).message, subject }, "Failed to send mail"));
    } else if (env.SEND_MAIL) {
        transporter.sendMail({
            from: env.SENDING_USER || "noreply@example.com",
            to,
            subject,
            html,
            text,
        }).catch((error: unknown) => logger.error({ error, to, subject }, "Failed to send mail"));
    } else {
        logger.info(`[Mail Mock Log] To: ${to} | Subject: ${subject} | ${text ?? html}`);
    }
}

export default sendMail;
