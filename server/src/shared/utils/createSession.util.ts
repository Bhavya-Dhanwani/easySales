// Importing modules
import mongoose from "mongoose";
import SessionDao from "../dao/session.dao.js";
import { Response } from "express";
import { COOKIE_EXPIRY_TIME, REFRESH_TOKEN_COOKIE_OPTIONS } from "../constants/tokens.constants.js";
import { generateAccessToken, generateRefreshToken } from "./token.util.js";
import buildTokenPayload from "./buildTokenPayload.util.js";

// function to create a session and return sanitized user with tokens
async function createSession(user: Record<string, unknown> | object, res: Response) {
    const u = (user as { _id: { toString(): string } });
    const tokenPayload = await buildTokenPayload(user);
    const sessionId = new mongoose.Types.ObjectId();
    const refreshToken = generateRefreshToken({
        sessionId: sessionId.toString(),
        userId: u._id.toString()
    });

    const sDao = new SessionDao();
    await sDao.createSession({
        _id: sessionId,
        userId: u._id,
        refreshToken: refreshToken,
        expiresAt: new Date(Date.now() + COOKIE_EXPIRY_TIME)
    });

    const accessToken = generateAccessToken(tokenPayload);
    res.cookie("refreshToken", refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
    return { sanitizedUser: tokenPayload, accessToken };
}

export default createSession;
