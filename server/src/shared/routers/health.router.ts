// Importing modules
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import env from "../config/env.config.js";
import { workerHeartbeat } from "../../jobs/worker.js";
import Ok from "../responses/Ok.response.js";

// Making the express router
const router = express.Router();

/*
    @route GET /api/health, /api/health/live
    @desc the process is up (no dependencies checked, nothing internal disclosed)
*/
const live = (req: Request, res: Response) => Ok(res, "Server is healthy", { status: "UP", uptime: Math.round(process.uptime()) });
router.get("/", live);
router.get("/live", live);

/*
    @route GET /api/health/ready
    @desc can serve traffic: database reachable and, when it runs in-process, the worker ticking
*/
router.get("/ready", async (req: Request, res: Response) => {
    let db = false;
    try {
        db = mongoose.connection.readyState === 1 && Boolean(await mongoose.connection.db?.admin().ping());
    } catch {
        db = false;
    }
    const w = workerHeartbeat();
    const worker = !env.RUN_WORKER || env.NODE_ENV === "test" || (w.running && Date.now() - w.lastTickAt < 60_000);
    const ok = db && worker;
    return res.status(ok ? 200 : 503).json({ success: ok, status: ok ? 200 : 503, message: ok ? "Ready" : "Not ready", data: { database: db ? "up" : "down", worker: worker ? "up" : "stalled" } });
});

// exporting the router
export default router;
