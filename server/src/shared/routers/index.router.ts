// Importing modules
import express, { Request, Response, NextFunction } from "express";
import healthRouter from "./health.router.js";
import authRouter from "../../modules/public/auth/auth.router.js";
import webhooksRouter from "../../modules/public/webhooks/webhooks.router.js";
import organizationRouter from "../../modules/private/organization/organization.router.js";
import settingsRouter from "../../modules/private/settings/settings.router.js";
import leadsRouter from "../../modules/private/leads/leads.router.js";
import pipelineRouter from "../../modules/private/pipeline/pipeline.router.js";
import insightsRouter from "../../modules/private/insights/insights.router.js";
import researchRouter from "../../modules/private/research/research.router.js";
import authMiddleware from "../middlewares/auth.middleware.js";
import orgContext from "../tenancy/orgContext.middleware.js";
import Forbidden from "../errors/Forbidden.error.js";

// making the router
const router = express.Router();

// mounting the public routers
router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/webhooks", webhooksRouter);

// only verified accounts can act on tenant data (the agent sends email on their behalf)
function requireVerified(req: Request & { user?: { isVerified?: boolean } }, res: Response, next: NextFunction) {
    if (!req.user?.isVerified) throw new Forbidden("Verify your email to continue");
    next();
}

// versioned, authenticated, tenant-scoped API
const v1 = express.Router();
v1.use(authMiddleware, requireVerified, orgContext);
v1.use("/organization", organizationRouter);
v1.use("/leads", leadsRouter);
v1.use("/", settingsRouter);
v1.use("/", pipelineRouter);
v1.use("/", insightsRouter);
v1.use("/", researchRouter);
router.use("/v1", v1);

// exporting the router
export default router;
