// Importing modules
import { Request } from "express";

// User payload interface
export interface IUserPayload {
    _id?: string;
    userId?: string;
    name?: string;
    email?: string;
    isVerified?: boolean;
    role?: string;
}

// Session payload interface
export interface ISessionPayload {
    sessionId: string;
    userId: string;
}

// Authenticated request interface
export interface AuthenticatedRequest extends Request {
    user?: IUserPayload;
}

// Session request interface
export interface SessionRequest extends Request {
    session?: ISessionPayload;
    refreshToken?: string;
}

// Signup request body interface
export interface SignupRequestBody {
    name: string;
    email: string;
    password?: string;
    token?: string;
}

// Login request body interface
export interface LoginRequestBody {
    email: string;
    password?: string;
    token?: string;
}

// Google login request body interface
export interface GoogleLoginRequestBody {
    credential: string;
}

// Forgot password request body interface
export interface ForgotPasswordRequestBody {
    email: string;
}

// Reset password request body interface
export interface ResetPasswordRequestBody {
    token: string;
    password?: string;
}

export type SignupRequest = Request<Record<string, string>, unknown, SignupRequestBody>;
export type LoginRequest = Request<Record<string, string>, unknown, LoginRequestBody>;
export type GoogleLoginRequest = Request<Record<string, string>, unknown, GoogleLoginRequestBody>;
export type ForgotPasswordRequest = Request<Record<string, string>, unknown, ForgotPasswordRequestBody>;
export type ResetPasswordRequest = Request<Record<string, string>, unknown, ResetPasswordRequestBody>;
