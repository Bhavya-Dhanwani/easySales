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

    // origin that serves prototype previews; use a separate domain in production (defaults to FRONTEND_URL)
    PREVIEW_BASE_URL: z.union([z.literal(""), z.string().url()]).default(""),

    // metering: unit prices in minor units of BILLING_CURRENCY (operator configuration, never model output)
    BILLING_CURRENCY: z.string().length(3).default("INR"),
    LLM_COST_INPUT_PER_MTOK_MINOR: z.coerce.number().int().min(0).default(25_000),
    LLM_COST_OUTPUT_PER_MTOK_MINOR: z.coerce.number().int().min(0).default(125_000),
    EMAIL_COST_MINOR: z.coerce.number().int().min(0).default(0),
    // platform-wide emergency brake on total daily spend across all tenants (0 = off)
    GLOBAL_DAILY_SPEND_CAP_MINOR: z.coerce.number().int().min(0).default(0),

    // Sprint 8 integrations: HubSpot public app (OAuth + webhook signing uses the client secret)
    HUBSPOT_CLIENT_ID: z.string().default(""),
    HUBSPOT_CLIENT_SECRET: z.string().default(""),
    // public origin of this API, used for OAuth redirect URIs (defaults to FRONTEND_URL when served together)
    PUBLIC_API_URL: z.union([z.literal(""), z.string().url()]).default(""),

    // HMAC secret for the billing provider's webhook (POST /api/webhooks/billing)
    BILLING_WEBHOOK_SECRET: z.string().default(""),

    // comma-separated emails of support staff: read-only access to operator views
    SUPPORT_EMAILS: z.string().default(""),

    // comma-separated emails of platform operators (admin metrics, feature flags, dead letters)
    ADMIN_EMAILS: z.string().default(""),

    // per-IP request limit on /api (health checks are exempt)
    API_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(300),
    // per-workspace request limit on /api/v1, so one tenant cannot starve the others
    TENANT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(600),

    // comma-separated workflow types this process works on (empty = all), e.g. "prototype.build"
    WORKER_TYPES: z.string().default(""),

    // above this many due jobs the worker defers non-critical scheduling (follow-ups, campaign enrolment)
    QUEUE_BACKPRESSURE: z.coerce.number().int().min(1).default(500),

    // lead discovery on OpenStreetMap (free, no key); the public server allows low volume only
    NOMINATIM_URL: z.string().url().default("https://nominatim.openstreetmap.org"),
    DISCOVERY_SEARCHES_PER_DAY: z.coerce.number().int().min(1).default(30),

    // Neatlogs AI tracing (off unless a key is set); content capture can be turned off (metadata only)
    NEATLOGS_API_KEY: z.string().default(""),
    NEATLOGS_ENDPOINT: z.string().url().default("https://ingest.neatlogs.com"),
    NEATLOGS_CAPTURE_CONTENT: booleanFromEnv(true),

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
