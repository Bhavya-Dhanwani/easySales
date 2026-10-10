// imported first by test helpers: ESM evaluates imports in order, so this runs before env.config
process.env.NODE_ENV = "test";
process.env.RUN_WORKER = "false";
process.env.SEND_MAIL = "false";
process.env.LLM_API_KEY = "sk-test-secret-must-never-reach-a-prompt";
