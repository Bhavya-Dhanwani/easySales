const envConstants = {
    PORT: 5000,
    NODE_ENV: 'development',
    MONGO_URI: 'mongodb://localhost:27017/easysales',
    CORS_ORIGIN: 'http://localhost:5173',
    FRONTEND_URL: 'http://localhost:5173',
    ACCESS_TOKEN_SECRET: "dev_only_access_jwt_secret_change_in_production",
    REFRESH_TOKEN_SECRET: "dev_only_refresh_jwt_secret_change_in_production",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: 587,
    SMTP_USER: "",
    SMTP_PASS: "",
    SENDING_USER: "easySales <noreply@example.com>",
    SEND_MAIL: false,
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_REDIRECT_URI: "http://localhost:5000/api/auth/google/callback",
    LLM_BASE_URL: "https://litellm.vision.aivar.app/v1",
    LLM_MODEL_SMART: "claude-sonnet-4.6",
    LLM_MODEL_FAST: "claude-haiku",
} as const;

export default envConstants;
