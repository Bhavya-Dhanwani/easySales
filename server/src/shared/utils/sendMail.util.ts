// Importing modules
import transporter from "../config/mail.config.js";
import logger from "../config/logger.config.js";
import env from "../config/env.config.js";

// function to send the mails
function sendMail(to: string, subject: string, html: string) {
    if (env.SEND_MAIL) {
        transporter.sendMail({
            from: env.SENDING_USER || "noreply@example.com",
            to,
            subject,
            html
        });
    } else {
        logger.info(`[Mail Mock Log] To: ${to} | Subject: ${subject} | HTML: ${html}`);
    }
}

export default sendMail;
