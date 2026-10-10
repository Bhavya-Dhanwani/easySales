// Importing modules
import express from "express";
import healthRouter from "./health.router.js";
import authRouter from "../../modules/public/auth/auth.router.js";

// making the router
const router = express.Router();

// mounting the public routers
router.use("/health", healthRouter);
router.use("/auth", authRouter);

// exporting the router
export default router;
