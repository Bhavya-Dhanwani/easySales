// Importing modules
import os from "node:os";
import mongoose from "mongoose";
import Workflow, { WORKFLOW_TYPES } from "../models/workflow.model.js";
import Message from "../models/message.model.js";

const X = { crossTenant: true };
const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

/*
    Per job type: backlog, oldest due age, run time and failures, plus this process's CPU
    and memory and a database round trip. Recommendations follow the scaling table: fix
    the first saturated resource, not everything at once.
*/
export async function workerCapacity() {
    const since = new Date(Date.now() - 86400_000);
    const now = new Date();
    const [queued, running, done, failed, oldest, mailQueue] = await Promise.all([
        Workflow.aggregate([{ $match: { status: "queued", nextRunAt: { $lte: now } } }, { $group: { _id: "$type", n: { $sum: 1 }, oldest: { $min: "$nextRunAt" } } }]).option(X),
        Workflow.aggregate([{ $match: { status: "running" } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).option(X),
        Workflow.aggregate([{ $match: { updatedAt: { $gte: since }, durationMs: { $gt: 0 } } }, { $group: { _id: "$type", ms: { $push: "$durationMs" } } }]).option(X),
        Workflow.aggregate([{ $match: { status: "failed", updatedAt: { $gte: since } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).option(X),
        Workflow.findOne({ status: "queued", nextRunAt: { $lte: now } }).sort({ nextRunAt: 1 }).setOptions(X).lean(),
        Message.aggregate([{ $match: { status: "queued", direction: "outbound", notBefore: { $lte: now } } }, { $group: { _id: null, n: { $sum: 1 }, oldest: { $min: "$notBefore" } } }]).option(X),
    ]);
    const t0 = process.hrtime.bigint();
    await mongoose.connection.db?.admin().ping();
    const dbPingMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;

    const by = <T extends { _id: string }>(rows: T[], type: string) => rows.find((r) => r._id === type);
    const types = WORKFLOW_TYPES.map((type) => {
        const q = by(queued, type);
        const ms = (by(done, type)?.ms as number[] | undefined ?? []).sort((a, b) => a - b);
        return {
            type, queued: q?.n ?? 0, running: by(running, type)?.n ?? 0,
            oldestDueSec: q ? Math.round((now.getTime() - (q.oldest as Date).getTime()) / 1000) : 0,
            runs24h: ms.length, p50Ms: pct(ms, 50), p95Ms: pct(ms, 95), failed24h: by(failed, type)?.n ?? 0,
        };
    });
    const mem = process.memoryUsage();
    const mail = mailQueue[0];
    const recommendations: string[] = [];
    for (const t of types) {
        if (t.oldestDueSec > 300) recommendations.push(`${t.type}: oldest job waited ${Math.round(t.oldestDueSec / 60)} min. Reduce redundant work first, then run a dedicated worker (WORKER_TYPES=${t.type}).`);
        if (t.runs24h >= 5 && t.failed24h / (t.runs24h + t.failed24h) > 0.2) recommendations.push(`${t.type}: ${t.failed24h} failures in 24 h. Fix the cause before adding capacity.`);
    }
    if (mail && (now.getTime() - (mail.oldest as Date).getTime()) > 300_000) recommendations.push("Email backlog over 5 min: check provider throttling before adding workers.");
    if (dbPingMs > 50) recommendations.push(`Database round trip ${dbPingMs} ms: check indexes and connection pool before upgrading the cluster.`);
    if (os.loadavg()[0] > os.cpus().length) recommendations.push("CPU saturated on this instance: profile hot endpoints, then scale API instances.");
    return {
        types,
        email: { queued: mail?.n ?? 0, oldestDueSec: mail ? Math.round((now.getTime() - (mail.oldest as Date).getTime()) / 1000) : 0 },
        oldestDueJobSec: oldest ? Math.round((now.getTime() - oldest.nextRunAt!.getTime()) / 1000) : 0,
        process: { rssMb: Math.round(mem.rss / 1e6), heapUsedMb: Math.round(mem.heapUsed / 1e6), load1: os.loadavg()[0], cpus: os.cpus().length, uptimeSec: Math.round(process.uptime()) },
        database: { pingMs: dbPingMs, poolMax: (mongoose.connection.getClient().options as { maxPoolSize?: number }).maxPoolSize ?? null },
        recommendations: recommendations.length ? recommendations : ["No saturated resource. Do not scale yet."],
    };
}
