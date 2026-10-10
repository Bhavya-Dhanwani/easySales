// Importing modules
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

function generateOTPToken(length = 6) {
    const min = Math.pow(10, length - 1);
    const max = Math.pow(10, length) - 1;
    const otp = Math.floor(Math.random() * (max - min) + min);
    return otp.toString();
}

function generateResetPasswordToken(length = 32) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz';
    let token = '';
    for (let i = 0; i < length; i++) {
        token += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return token;
}

export { generateAccessToken, generateRefreshToken, generateOTPToken, generateResetPasswordToken };
