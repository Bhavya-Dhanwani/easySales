// Importing modules
import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import logger from "../config/logger.config.js";
import env from "../config/env.config.js";

// function to handle errors in the application
function errorHandler(err: Error & { statusCode?: number; status?: number; code?: number }, req: Request, res: Response, next: NextFunction) {

    let status = err.statusCode || err.status || 500;
    let message = err.message || "Internal Server Error";

    // mapping well-known database errors to client errors
    if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
        status = 400;
    } else if (err.code === 11000) {
        status = 409;
        message = "A record with these details already exists";
    }

    // logging the error (full detail stays server-side)
    if (status >= 500) logger.error(err);
    else logger.debug({ status, message }, "Client error");

    // never leak internals of unexpected failures to clients in production
    if (status >= 500 && env.NODE_ENV === "production") message = "Internal Server Error";

    // sending the error response with status code and message
    return res.status(status).json({
        success: false,
        status,
        message
    });

}

export default errorHandler;
