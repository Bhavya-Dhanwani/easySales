// Importing modules
import { ChatOpenAI } from "@langchain/openai";
import { z, ZodTypeAny } from "zod";
import env from "../shared/config/env.config.js";
import ApiError from "../shared/utils/ApiError.util.js";

export type ModelTier = "smart" | "fast";

export interface StructuredCall<S extends ZodTypeAny> {
    agent: string;
    schema: S;
    system: string;
    user: string;
    tier?: ModelTier;
}

export interface StructuredResult<T> {
    data: T;
    model: string;
    inputTokens: number;
    outputTokens: number;
}

// the only surface agents use to talk to a model; swappable for tests and other providers
export interface LlmGateway {
    structured<S extends ZodTypeAny>(call: StructuredCall<S>): Promise<StructuredResult<z.infer<S>>>;
}

export class LlmNotConfiguredError extends ApiError {
    code = "LLM_NOT_CONFIGURED";
    constructor() {
        super(503, "AI model is not configured. Set LLM_API_KEY (and LLM_BASE_URL) in server/.env.");
    }
}

// LangChain-backed gateway for any OpenAI-compatible endpoint (LiteLLM, OpenAI, vLLM, ...)
class LangChainGateway implements LlmGateway {

    private models = new Map<string, ChatOpenAI>();

    private model(tier: ModelTier) {
        if (!env.LLM_API_KEY) throw new LlmNotConfiguredError();
        const name = tier === "fast" ? env.LLM_MODEL_FAST : env.LLM_MODEL_SMART;
        let model = this.models.get(name);
        if (!model) {
            model = new ChatOpenAI({
                model: name,
                apiKey: env.LLM_API_KEY,
                configuration: { baseURL: env.LLM_BASE_URL },
                temperature: 0.3,
                maxRetries: 2,
                timeout: 90_000,
            });
            this.models.set(name, model);
        }
        return { name, model };
    }

    async structured<S extends ZodTypeAny>({ agent, schema, system, user, tier = "smart" }: StructuredCall<S>) {
        const { name, model } = this.model(tier);
        // tool-calling structured output: the response is validated against the zod schema
        const runnable = model.withStructuredOutput(schema, { name: agent.replace(/[^a-zA-Z0-9_]/g, "_"), includeRaw: true });
        const { raw, parsed } = await runnable.invoke([
            { role: "system", content: system },
            { role: "user", content: user },
        ]);
        if (!parsed) throw new Error(`${agent}: model returned no structured output`);
        const usage = (raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
        return {
            data: schema.parse(parsed) as z.infer<S>,
            model: name,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
        };
    }

}

let gateway: LlmGateway = new LangChainGateway();

export const getLlm = () => gateway;

// used by tests (and future provider routing) to replace the model gateway
export function setLlm(next: LlmGateway) {
    gateway = next;
}
