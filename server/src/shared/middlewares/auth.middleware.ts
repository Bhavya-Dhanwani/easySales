// Importing modules
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import env from "../config/env.config.js";
import Unauthorized from "../errors/Unauthorized.error.js";

// Function to check if the user is authenticated or not
function authMiddleware(req: Request & { user?: Record<string, unknown> }, res: Response, next: NextFunction) {

    // getting the access token from the request headers
    const accessToken = req.headers?.authorization?.split(" ")[1];

    // if the access token is not present, return an error
    if (!accessToken) {

        throw new Unauthorized("User unauthenticated.");

    }

    try {

        // verifying the access token
        const decoded = jwt.verify(accessToken, env.ACCESS_TOKEN_SECRET);

        // if the access token is valid, attach the decoded user to the request object
        req.user = decoded as Record<string, unknown>;

        next();

    } catch (error) {

        // if the access token is invalid, return an error
        throw new Unauthorized("Access token expired or invalid.");

    }

}

export default authMiddleware;
