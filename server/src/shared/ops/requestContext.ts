// Importing modules
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import logger from "../config/logger.config.js";
import env from "../config/env.config.js";
import { alert } from "../alerts/alert.service.js";

const store = new AsyncLocalStorage<{ requestId: string }>();

// the id of the HTTP request being served, if any: workflows started inside it inherit it as correlationId
export const currentRequestId = () => store.getStore()?.requestId;

/* ------------------------- in-process API metrics ------------------------ */

// ponytail: per-process rolling minutes; export to Prometheus/OTel when running several API instances
const minutes = new Map<number, { count: number; errors: number; ms: number[] }>();
const WINDOW_MIN = 15;

function record(ms: number, status: number) {
    const m = Math.floor(Date.now() / 60_000);
    const b = minutes.get(m) ?? { count: 0, errors: 0, ms: [] };
    b.count += 1;
    if (status >= 500) b.errors += 1;
    if (b.ms.length < 5000) b.ms.push(ms);
    minutes.set(m, b);
    for (const k of minutes.keys()) if (k < m - WINDOW_MIN) minutes.delete(k);
}

const pct = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

export function apiMetrics(windowMin = 5) {
    const now = Math.floor(Date.now() / 60_000);
    const buckets = [...minutes.entries()].filter(([k]) => k > now - windowMin).map(([, b]) => b);
    const count = buckets.reduce((a, b) => a + b.count, 0);
    const errors = buckets.reduce((a, b) => a + b.errors, 0);
    const ms = buckets.flatMap((b) => b.ms);
    return { windowMinutes: windowMin, requests: count, errors, errorRate: count ? errors / count : 0, p50Ms: pct(ms, 50), p95Ms: pct(ms, 95), p99Ms: pct(ms, 99) };
}

export const resetApiMetrics = () => minutes.clear();

/*
    Gives every request an id (accepting a sane X-Request-Id from a proxy), returns it in
    the response, and writes one structured log line per request: no bodies, no headers.
*/
export function requestContext(req: Request, res: Response, next: NextFunction) {
    const incoming = req.header("x-request-id");
    const requestId = incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        record(ms, res.statusCode);
        if (env.NODE_ENV === "test") return;
        const ctx = (req as Request & { ctx?: { organizationId?: unknown; userId?: string } }).ctx;
        logger[res.statusCode >= 500 ? "error" : "info"]({
            requestId, method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, ms: Math.round(ms),
            organizationId: ctx?.organizationId ? String(ctx.organizationId) : undefined, userId: ctx?.userId,
        }, "http");
        // sustained 5xx: at least 20 requests in 5 minutes and over 10% failing
        const m = apiMetrics(5);
        if (m.requests >= 20 && m.errorRate > 0.1) void alert(null, "api_errors", `API error rate ${(m.errorRate * 100).toFixed(1)}% over the last 5 minutes (${m.errors}/${m.requests})`);
    });
    store.run({ requestId }, next);
}
