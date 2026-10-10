// Importing modules
import express, { Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import router from "./shared/routers/index.router.js";
import applyMiddlewares from "./shared/middlewares/index.middleware.js";
import notFoundHandler from "./shared/middlewares/NotFound.middleware.js";
import errorHandler from "./shared/middlewares/error.middleware.js";
import { setupSwagger } from "./shared/swagger.js";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(serverDirectory, "public");
const frontendIndex = path.join(publicDirectory, "index.html");

// function to make the app
function createApp(): Express {

    // create an express app
    const app = express();

    // applying middlewares
    applyMiddlewares(app);

    // adding the index router to the app
    app.use("/api", router);

    // API routes must continue returning JSON 404 responses instead of the SPA shell.
    app.use("/api", notFoundHandler);

    // setting up swagger documentation
    setupSwagger(app);

    // Serve a built frontend copied into server/public, when present.
    if (existsSync(frontendIndex)) {
        app.use(express.static(publicDirectory));

        // Express 5 requires a named wildcard. This lets client-side routes reload correctly.
        app.get("/*path", (req, res) => res.sendFile(frontendIndex));
    }

    // not found middleware
    app.use(notFoundHandler);

    // error handling middleware
    app.use(errorHandler);

    // returning the app
    return app;

}

export default createApp;
