// Importing modules
import { randomBytes, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import env from "../config/env.config.js";
import { EXPIRY } from "../constants/tokens.constants.js";

// function to generate access token
function generateAccessToken(payload: Record<string, unknown> | object) {
    return jwt.sign(payload, env.ACCESS_TOKEN_SECRET, { expiresIn: EXPIRY.ACCESS_TOKEN });
}

// function to generate refresh token
function generateRefreshToken(payload: Record<string, unknown> | object) {
    return jwt.sign(payload, env.REFRESH_TOKEN_SECRET, { expiresIn: EXPIRY.REFRESH_TOKEN });
}

// cryptographically secure numeric OTP
function generateOTPToken(length = 6) {
    return randomInt(10 ** (length - 1), 10 ** length).toString();
}

// cryptographically secure URL-safe token
function generateResetPasswordToken(length = 32) {
    return randomBytes(length).toString("base64url").slice(0, length);
}

export { generateAccessToken, generateRefreshToken, generateOTPToken, generateResetPasswordToken };
