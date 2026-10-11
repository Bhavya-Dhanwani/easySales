import mongoose from "mongoose";
import connectDB from "./src/shared/config/db.config.js";
import logger from "./src/shared/config/logger.config.js";
// registers every model so index sync covers all of them
import "./src/app.js";
import { migrate, migrationStatus } from "./src/migrations/index.js";

// release step: apply pending data migrations, then exit (non-zero on failure blocks the deploy)
async function main() {
	await connectDB();
	const applied = await migrate();
	logger.info({ applied, status: await migrationStatus() }, applied.length ? "Migrations applied" : "No pending migrations");
	await mongoose.disconnect();
}

main().catch(async (error) => {
	logger.error(error, "Migration failed; release blocked");
	await mongoose.disconnect().catch(() => undefined);
	process.exit(1);
});
