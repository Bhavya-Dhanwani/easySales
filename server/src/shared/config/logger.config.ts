// Importing modules
import pino from "pino";
import env from "./env.config.js";

// creating a logger instance
// secrets never reach the logs, whatever object gets logged
export const REDACT_PATHS = [
    "password", "*.password", "pass", "*.pass", "passwordEnc", "*.passwordEnc", "token", "*.token", "accessToken", "*.accessToken",
    "refreshToken", "*.refreshToken", "apiKey", "*.apiKey", "secret", "*.secret", "webhookSecret", "*.webhookSecret",
    "authorization", "*.authorization", "headers.authorization", "req.headers.authorization", "req.headers.cookie", "cookie", "*.cookie",
];

const logger = pino({
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    level: env.NODE_ENV === "production" ? "info" : env.NODE_ENV === "test" ? "warn" : "debug",
    ...(env.NODE_ENV === "development" && {
        transport: {
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
            },
        },
    }),
});

export default logger;
