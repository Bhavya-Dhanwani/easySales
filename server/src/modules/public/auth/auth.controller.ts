// Importing modules
import { isPlatformAdmin, isSupport } from "../../admin/admin.router.js";
import { Request, Response } from "express";
import { AuthenticatedRequest, SignupRequest, LoginRequest, SessionRequest, GoogleLoginRequest, ForgotPasswordRequest, ResetPasswordRequest } from "./auth.types.js";
import env from "../../../shared/config/env.config.js";
import { OTP_EXPIRY_TIME, RESET_PASSWORD_TOKEN_EXPIRY_TIME } from "../../../shared/constants/tokens.constants.js";
import UserDao from "../../../shared/dao/user.dao.js";
import SessionDao from "../../../shared/dao/session.dao.js";
import TokenDao from "../../../shared/dao/token.dao.js";
import NotFound from "../../../shared/errors/NotFound.error.js";
import Unauthorized from "../../../shared/errors/Unauthorized.error.js";
import Created from "../../../shared/responses/Created.response.js";
import Ok from "../../../shared/responses/Ok.response.js";
import createSession from "../../../shared/utils/createSession.util.js";
import { getGoogleAuthorizationUrl, getGoogleUserFromCode, verifyGoogleToken } from "../../../shared/utils/googleAuth.util.js";
import sendMail from "../../../shared/utils/sendMail.util.js";
import { generateOTPToken, generateResetPasswordToken } from "../../../shared/utils/token.util.js";
import BadRequest from "../../../shared/errors/BadRequest.error.js";
import { activateInvitations, createOrganizationForUser, listUserOrganizations } from "../../../shared/tenancy/organization.service.js";

// class to handle public authentication operations
class AuthController {
	userDao: UserDao;
	sessionDao: SessionDao;
	tokenDao: TokenDao;

	constructor() {
		// initializing the user dao
		this.userDao = new UserDao();

		// initializing the session dao
		this.sessionDao = new SessionDao();

		// initializing the token dao
		this.tokenDao = new TokenDao();
	}

	// signup a new user
	signup = async (req: SignupRequest, res: Response) => {
		// getting the user from the request body
		const { name, email, password, organizationName } = req.body;

		// creating a new user using the user dao (always unverified until the OTP is confirmed)
		const user = await this.userDao.createUser({
			name,
			email: email.toLowerCase(),
			password,
			providers: ["local"],
			isVerified: false,
		});

		// every new account starts with its own organization (tenant)
		await createOrganizationForUser(user, organizationName || `${name}'s workspace`);

		// creating session and tokens
		const { sanitizedUser, accessToken } = await createSession(
			user,
			res,
		);

		// generating the otp to verify the user email
		const otp = generateOTPToken();

		// setting otp in the database using the token dao
		await this.tokenDao.createToken({
			email: user.email,
			type: "otp",
			value: otp,
			expiresAt: new Date(Date.now() + OTP_EXPIRY_TIME),
		});

		sendMail(
			user.email,
			"Verify your email",
			`Your OTP is ${otp}. It will expire in ${OTP_EXPIRY_TIME / 60000} minutes.`,
		);

		// returning otp verification response with access token
		return Created(res, "Otp Sent Successfully for verification", {
			user: sanitizedUser,
			accessToken: accessToken,
		});
	};

	// login an existing user
	login = async (req: LoginRequest, res: Response) => {
		// getting the user from the request body
		const { email, password } = req.body;

		// finding the user using the user dao
		const user = await this.userDao.findUserByEmail(email.toLowerCase());

		// same error for unknown email and wrong password, so accounts cannot be enumerated
		if (!user) {
			throw new Unauthorized("Invalid email or password");
		}

		// checking if the password is valid
		const userWithAuth = user as unknown as { comparePassword(password: string): Promise<boolean> };
		const isPasswordValid = await userWithAuth.comparePassword(password || "");

		// if the password is not valid, throw an unauthorized error
		if (!isPasswordValid) {
			throw new Unauthorized("Invalid email or password");
		}

		// creating session and tokens
		const { sanitizedUser, accessToken } = await createSession(
			user,
			res,
		);

		// returning the logged in user with access token
		return Ok(res, "User Logged in Successfully", {
			user: sanitizedUser,
			accessToken: accessToken,
		});
	};

	// get authenticated user profile
	me = async (req: AuthenticatedRequest, res: Response) => {
		// returning the authenticated user profile
		const organizations = await listUserOrganizations(String(req.user?.userId));
		return Ok(res, "User profile fetched successfully", { user: req.user, organizations, isPlatformAdmin: isPlatformAdmin(req.user?.email), isSupport: isSupport(req.user?.email) });
	};

	// verify the email address with the OTP sent at signup
	verifyEmail = async (req: AuthenticatedRequest, res: Response) => {
		const { otp } = req.body as { otp: string };
		const email = String(req.user?.email || "").toLowerCase();

		const token = await this.tokenDao.findValidToken(String(otp), "otp", email);
		if (!token) throw new BadRequest("Invalid or expired code");

		const user = await this.userDao.updateUserById(String(req.user?.userId), { isVerified: true });
		if (!user) throw new NotFound("User not found");
		await this.tokenDao.deleteTokenByEmail(email, "otp");
		await activateInvitations(user);

		// re-issuing the session so the token payload carries isVerified
		const { sanitizedUser, accessToken } = await createSession(user, res);
		return Ok(res, "Email verified", { user: sanitizedUser, accessToken });
	};

	// send a fresh verification code
	resendOtp = async (req: AuthenticatedRequest, res: Response) => {
		const email = String(req.user?.email || "").toLowerCase();
		await this.tokenDao.deleteTokenByEmail(email, "otp");
		const otp = generateOTPToken();
		await this.tokenDao.createToken({ email, type: "otp", value: otp, expiresAt: new Date(Date.now() + OTP_EXPIRY_TIME) });
		sendMail(email, "Verify your email", `Your OTP is ${otp}. It will expire in ${OTP_EXPIRY_TIME / 60000} minutes.`);
		return Ok(res, "Verification code sent");
	};

	// refresh access token
	refresh = async (req: SessionRequest, res: Response) => {
		// getting the session and refresh token from the request
		const { session, refreshToken } = req;

		// checking if the session and refresh token are present
		if (!session || !refreshToken) {
			throw new Unauthorized("Session expired or invalid");
		}

		// getting the session id from the decoded session
		const sessionId = (session as unknown as Record<string, unknown>).sessionId as string;

		// finding the session in the database
		const dbSession = await this.sessionDao.findSessionByRefreshTokenandSessionId(refreshToken, sessionId);

		// checking if the session exists
		if (!dbSession) {
			throw new Unauthorized("Session expired or invalid");
		}

		// getting the user from the session
		const dbUserId = String((dbSession as unknown as Record<string, unknown>).userId || "");
		const user = await this.userDao.findUserById(dbUserId);

		// checking if the user exists
		if (!user) {
			throw new Unauthorized("Session expired or invalid");
		}

		// creating session and tokens
		const { sanitizedUser, accessToken } = await createSession(
			user,
			res,
		);

		// deleting the old session
		await this.sessionDao.deleteSessionByRefreshTokenandSessionId(refreshToken, sessionId);

		// returning the refreshed tokens
		return Ok(res, "Token refreshed successfully", {
			user: sanitizedUser,
			accessToken: accessToken,
		});
	};

	// logout user
	logout = async (req: SessionRequest, res: Response) => {
		// getting the session and refresh token from the request
		const { session, refreshToken } = req;

		// deleting the session if present
		if (refreshToken && session) {
			await this.sessionDao.deleteSessionByRefreshTokenandSessionId(refreshToken, session.sessionId);
		}

		// clearing the refresh token cookie
		res.clearCookie("refreshToken");

		// returning success response
		return Ok(res, "Logged out successfully");
	};

	// logout user from all active sessions
	logoutAll = async (req: AuthenticatedRequest, res: Response) => {
		// getting the user id from the request
		const userId = (req.user?._id || req.user?.userId) as string;

		// deleting all sessions for the user
		await this.sessionDao.deleteSessionByUserId(userId);

		// clearing the refresh token cookie
		res.clearCookie("refreshToken");

		// returning success response
		return Ok(res, "Logged out from all sessions successfully");
	};

	// login via google credential token
	googleLogin = async (req: GoogleLoginRequest, res: Response) => {
		// getting the credential from the request body
		const { credential } = req.body;

		// verifying the Google credential token
		const googleUser = await verifyGoogleToken(credential);

		// finding the user by email
		let user = await this.userDao.findUserByEmail(googleUser.email);

		if (user) {
			// checking if the user already has google provider
			if (!user.providers.includes("google")) {
				// adding google to the providers list and setting googleId
				user = await this.userDao.updateUserById(user._id.toString(), {
					$addToSet: { providers: "google" },
					googleId: googleUser.googleId,
				});
			}
		} else {
			// creating a new user with google provider
			user = await this.userDao.createUser({
				name: googleUser.name,
				email: googleUser.email,
				providers: ["google"],
				googleId: googleUser.googleId,
				isVerified: true,
			});
			await createOrganizationForUser(user, `${googleUser.name || "My"}'s workspace`);
		}
		await activateInvitations(user!);

		// creating session and tokens
		const { sanitizedUser, accessToken } = await createSession(
			user!,
			res,
		);

		// returning the google logged in user with access token
		return Ok(res, "User Logged in Successfully via Google", {
			user: sanitizedUser,
			accessToken: accessToken,
		});
	};

	// redirect user to google oauth authorization page
	googleRedirect = (req: Request, res: Response) => {
		const state = generateResetPasswordToken(32);

		// setting the google oauth state cookie
		res.cookie("googleOAuthState", state, {
			httpOnly: true,
			secure: env.NODE_ENV === "production",
			sameSite: "lax",
			maxAge: 10 * 60 * 1000,
		});

		// returning the redirect to google authorization url
		return res.redirect(getGoogleAuthorizationUrl(state));
	};

	// handle google oauth callback
	googleCallback = async (req: Request, res: Response) => {
		const { code, state, error } = req.query;
		const cookies = (req.cookies as Record<string, string>);
		const clientOrigin = env.FRONTEND_URL;
		const redirectToLogin = `${clientOrigin}/login?googleError=1`;

		// redirecting to login if state is invalid or error
		const isStateValid = state && state === cookies?.googleOAuthState;
		if (error || !code || !state || !isStateValid) {
			res.clearCookie("googleOAuthState");
			return res.redirect(redirectToLogin);
		}

		res.clearCookie("googleOAuthState");

		// fetching the google user using the authorization code
		const googleUser = await getGoogleUserFromCode(code as string);
		let user = await this.userDao.findUserByEmail(googleUser.email);

		if (user && !user.providers.includes("google")) {
			// adding google provider to existing user
			user = await this.userDao.updateUserById(user._id.toString(), {
				$addToSet: { providers: "google" },
				googleId: googleUser.googleId,
				isVerified: true,
			});
		} else if (!user) {
			// creating a new user from google profile
			user = await this.userDao.createUser({
				name: googleUser.name,
				email: googleUser.email,
				providers: ["google"],
				googleId: googleUser.googleId,
				isVerified: true,
			});
			await createOrganizationForUser(user, `${googleUser.name || "My"}'s workspace`);
		}
		await activateInvitations(user!);

		// creating session for the authenticated user
		await createSession(user!, res);

		// returning redirect to dashboard
		return res.redirect(`${clientOrigin}/dashboard`);
	};

	// send password reset email
	forgotPassword = async (req: ForgotPasswordRequest, res: Response) => {
		// getting the email from the request body
		const email = req.body.email.toLowerCase();

		// deleting any existing reset token for this email
		await this.tokenDao.deleteTokenByEmail(email, "reset");

		// generating the new reset token
		const resetToken = generateResetPasswordToken();

		// setting the reset token in the database
		await this.tokenDao.createToken({
			email: email,
			type: "reset",
			value: resetToken,
			expiresAt: new Date(Date.now() + RESET_PASSWORD_TOKEN_EXPIRY_TIME),
		});

		// sending the reset password token as a magic link to the email
		sendMail(
			email,
			"Your reset Password Link",
			`Click the link and reset your password <a href="${env.FRONTEND_URL}/reset-password/${resetToken}">Reset Your Password</a>`,
		);

		// returning success response
		return Ok(res, "Reset password Mail sent Successfully");
	};

	// reset password using token
	resetPassword = async (req: ResetPasswordRequest, res: Response) => {
		// getting the token from the request body
		const { token, password } = req.body;

		// finding the reset token in the database
		const resetToken = await this.tokenDao.findValidToken(token, "reset");

		if (!resetToken) {
			throw new NotFound("Reset link is invalid or has expired.");
		}

		// finding the user from the email
		const tokenEmail = (resetToken as unknown as { email: string }).email;
		const user = await this.userDao.findUserByEmail(tokenEmail);

		if (!user) throw new NotFound("Reset link is invalid or has expired.");

		// setting the new password
		const userDoc = user as unknown as { password?: string; save(): Promise<unknown> };
		userDoc.password = password;

		// saving the user with the new password
		await userDoc.save();

		// deleting the token after successful reset and signing out every existing session
		await this.tokenDao.deleteTokenByValue(token);
		await this.sessionDao.deleteSessionByUserId(user._id);

		// returning success response
		return Ok(res, "Password reset Successfully");
	};
}

export default AuthController;
