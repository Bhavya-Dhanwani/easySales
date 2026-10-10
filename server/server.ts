import mongoose from "mongoose";
import createApp from "./src/app.js";
import connectDB from "./src/shared/config/db.config.js";
import env from "./src/shared/config/env.config.js";
import logger from "./src/shared/config/logger.config.js";
import { startWorker, stopWorker } from "./src/jobs/worker.js";

async function startServer() {
	const app = createApp();

	await connectDB();

	// the agent worker can run in-process (simple deploys) or as its own process (npm run worker)
	if (env.RUN_WORKER) startWorker();

	const server = app.listen(env.PORT || 5000, () => {
		logger.info(`Server is running on port ${env.PORT || 5000}`);
	});

	// graceful shutdown: stop taking work, finish in-flight requests, close the database
	const shutdown = (signal: string) => {
		logger.info(`${signal} received, shutting down`);
		stopWorker();
		server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
		setTimeout(() => process.exit(1), 10_000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
