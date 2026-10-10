import mongoose from "mongoose";
import connectDB from "./src/shared/config/db.config.js";
import logger from "./src/shared/config/logger.config.js";
import { startWorker, stopWorker } from "./src/jobs/worker.js";

// standalone agent worker process: scale it independently of the API
async function main() {
	await connectDB();
	startWorker();
	const shutdown = () => {
		logger.info("Worker shutting down");
		stopWorker();
		mongoose.disconnect().finally(() => process.exit(0));
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main();
