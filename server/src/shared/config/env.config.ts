// Importing modules
import { config } from "dotenv";
import z from "zod";
import envConstants from "../constants/env.constants.js";

// loading environment variables
config();

// parses "true"/"false" strings coming from process.env
const booleanFromEnv = (fallback: boolean) => z.preprocess((val) => {
    if (typeof val === "string") return val.toLowerCase() === "true";
    return val;
}, z.boolean()).default(fallback);

// defining the schema for environment variables
const envSchema = z.object({
    PORT: z.coerce.number().default(envConstants.PORT),
    NODE_ENV: z.enum(["development", "production", "test"]).default(envConstants.NODE_ENV),
    MONGO_URI: z.string().default(envConstants.MONGO_URI),
    CORS_ORIGIN: z.string().default(envConstants.CORS_ORIGIN),
    FRONTEND_URL: z.string().url().default(envConstants.FRONTEND_URL),
    ACCESS_TOKEN_SECRET: z.string().min(32).default(envConstants.ACCESS_TOKEN_SECRET),
    REFRESH_TOKEN_SECRET: z.string().min(32).default(envConstants.REFRESH_TOKEN_SECRET),
    SMTP_HOST: z.string().default(envConstants.SMTP_HOST),
    SMTP_PORT: z.coerce.number().default(envConstants.SMTP_PORT),
    SMTP_USER: z.string().default(envConstants.SMTP_USER),
    SMTP_PASS: z.string().default(envConstants.SMTP_PASS),
    SENDING_USER: z.string().default(envConstants.SENDING_USER),
    SEND_MAIL: booleanFromEnv(envConstants.SEND_MAIL),
    GOOGLE_CLIENT_ID: z.string().default(envConstants.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: z.string().default(envConstants.GOOGLE_CLIENT_SECRET),
    GOOGLE_REDIRECT_URI: z.string().url().default(envConstants.GOOGLE_REDIRECT_URI),

    // AI gateway (any OpenAI-compatible endpoint, e.g. LiteLLM)
    LLM_BASE_URL: z.string().url().default(envConstants.LLM_BASE_URL),
    LLM_API_KEY: z.string().default(""),
    LLM_MODEL_SMART: z.string().default(envConstants.LLM_MODEL_SMART),
    LLM_MODEL_FAST: z.string().default(envConstants.LLM_MODEL_FAST),

    // key for encrypting stored credentials (email account passwords, webhook secrets)
    ENCRYPTION_KEY: z.string().min(32).default("dev_only_encryption_key_change_in_production_000"),

    // optional Slack/Discord-compatible webhook for operational alerts
    ALERT_WEBHOOK_URL: z.union([z.literal(""), z.string().url()]).default(""),

    // run the background worker inside the API process (disable when running `npm run worker` separately)
    RUN_WORKER: booleanFromEnv(true),
});

// parsing and validating environment variables
const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
    console.error("Invalid environment variables:", parsedEnv.error.format());
    process.exit(1);
}

// getting the validated environment variables
const env = parsedEnv.data;

// refusing to boot production with the development secrets
if (env.NODE_ENV === "production" && (
    env.ACCESS_TOKEN_SECRET === envConstants.ACCESS_TOKEN_SECRET ||
    env.REFRESH_TOKEN_SECRET === envConstants.REFRESH_TOKEN_SECRET ||
    env.ENCRYPTION_KEY.startsWith("dev_only_") ||
    env.CORS_ORIGIN === "*"
)) {
    console.error("Refusing to start: set ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET, ENCRYPTION_KEY and CORS_ORIGIN for production.");
    process.exit(1);
}

export default env;
