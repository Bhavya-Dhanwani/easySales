// Importing modules
import pino from "pino";
import env from "./env.config.js";

// creating a logger instance
const logger = pino({
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
