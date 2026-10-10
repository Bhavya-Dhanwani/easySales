// Importing modules
import express from "express";
import AuthController from "./auth.controller.js";
import { signupValidators, loginValidators, forgotPasswordValidators, resetPasswordValidators, googleLoginValidators } from "./auth.validator.js";
import authMiddleware from "../../../shared/middlewares/auth.middleware.js";
import refreshMiddleware from "../../../shared/middlewares/refresh.middleware.js";

// making the router
const router = express.Router();

// creating a auth controller instance
const authController = new AuthController();

/*
    @route POST /api/auth/signup
    @desc Signup user
    @access Public
*/
router.post("/signup", signupValidators, authController.signup);

/*
    @route POST /api/auth/login
    @desc Login user
    @access Public
*/
router.post("/login", loginValidators, authController.login);

/*
    @route GET /api/auth/me
    @desc Get authenticated user profile
    @access Private
*/
router.get("/me", authMiddleware, authController.me);

/*
    @route POST /api/auth/refresh
    @desc Refresh access token
    @access Public
*/
router.post("/refresh", refreshMiddleware, authController.refresh);

/*
    @route POST /api/auth/logout
    @desc Logout user
    @access Public
*/
router.post("/logout", refreshMiddleware, authController.logout);

/*
    @route POST /api/auth/logoutall
    @desc Logout user from all active sessions
    @access Private
*/
router.post("/logoutall", authMiddleware, authController.logoutAll);

/*
    @route POST /api/auth/google-login
    @desc Login user via Google
    @access Public
*/
router.post("/google-login", googleLoginValidators, authController.googleLogin);
router.get("/google", authController.googleRedirect);
router.get("/google/callback", authController.googleCallback);

/*
    @route POST /api/auth/forgot-password
    @desc Forgot password
    @access Public
*/
router.post("/forgot-password", forgotPasswordValidators, authController.forgotPassword);

/*
    @route POST /api/auth/reset-password
    @desc Reset password
    @access Public
*/
router.post("/reset-password", resetPasswordValidators, authController.resetPassword);

// exporting the router
export default router;
