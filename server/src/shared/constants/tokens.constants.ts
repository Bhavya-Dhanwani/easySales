// Importing modules
import env from "../config/env.config.js";

export const EXPIRY = {
    ACCESS_TOKEN: env.NODE_ENV === "development" ? "5m" : "15m",
    REFRESH_TOKEN: env.NODE_ENV === "development" ? "2h" : "7d",
    SINGLE_TOKEN: "30d",
} as const;

export const COOKIE_EXPIRY_TIME = env.NODE_ENV === "development" ? 2 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;

export const REFRESH_TOKEN_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: env.NODE_ENV === "production" ? "none" as const : "lax" as const,
    maxAge: COOKIE_EXPIRY_TIME,
};

export const SINGLE_TOKEN_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: env.NODE_ENV === "production" ? "none" as const : "lax" as const,
    maxAge: 30 * 24 * 60 * 60 * 1000,
};

export const OTP_EXPIRY_TIME = env.NODE_ENV === "development" ? 5 * 60 * 1000 : 10 * 60 * 1000;

export const RESET_PASSWORD_TOKEN_EXPIRY_TIME = env.NODE_ENV === "development" ? 5 * 60 * 1000 : 10 * 60 * 1000;
