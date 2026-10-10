// Importing modules
import express, { Express } from "express";
import compression from "compression";
import cors from "cors";
import helmet from "helmet";
import hpp from "hpp";
import cookieParser from "cookie-parser";
import { requestContext } from "../ops/requestContext.js";
import { rateLimit } from "express-rate-limit";
import env from "../config/env.config.js";

// function to apply middlewares to the app
function applyMiddlewares(app: Express) {

    // trusting the first proxy so rate limits see the real client IP behind a reverse proxy
    app.set("trust proxy", 1);

    // request id, structured access log and latency metrics (first, so everything below is covered)
    app.use(requestContext);

    // applying middlewares
    app.use(compression());

    // credentials (refresh cookie) are only allowed for explicitly configured origins
    const origins = env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
    app.use(cors({ origin: origins.includes("*") ? true : origins, credentials: !origins.includes("*") }));

    app.use(helmet());

    app.use(hpp());

    app.use(cookieParser());

    // global API rate limit per IP
    app.use("/api", rateLimit({ windowMs: 60_000, limit: env.API_RATE_LIMIT_PER_MIN, standardHeaders: "draft-8", legacyHeaders: false, skip: (req) => req.path.startsWith("/health") }));

    // keeping the raw bytes so webhook signatures can be verified
    app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));

    app.use(express.urlencoded({ extended: true, limit: "100kb" }));

}

// stricter limiter for credential endpoints (brute-force protection)
export const authRateLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: env.NODE_ENV === "test" ? 1000 : 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
});

export default applyMiddlewares;
