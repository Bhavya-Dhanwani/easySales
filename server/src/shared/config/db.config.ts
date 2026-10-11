// Importing modules
import mongoose from "mongoose";
import env from "./env.config.js";
import logger from "./logger.config.js";

// function to connect to the database
async function connectDB() {

    try {

        // connecting to the database
        mongoose.set("strictQuery", false);
        // production builds indexes only through the migration step (npm run migrate), never on boot
        if (env.NODE_ENV === "production") mongoose.set("autoIndex", false);
        await mongoose.connect(env.MONGO_URI);
        logger.info("Connected to the database");

    }
    catch (error) {

        // logging the error and failing fast: the API must not run without its database
        logger.error(error, "Error connecting to the database");
        throw error;

    }

}

export default connectDB;
