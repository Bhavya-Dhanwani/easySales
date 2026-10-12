// Importing modules
import logger from "../shared/config/logger.config.js";
import { neatlogsCallbacks } from "../shared/observability/neatlogs.js";
import { ChatOpenAI } from "@langchain/openai";
import { ChatMistralAI } from "@langchain/mistralai";
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
        super(503, "AI model is not configured. Set LLM_API_KEY (and LLM_BASE_URL) or MISTRAL_API_KEY in server/.env.");
    }
}

export class LlmAuthError extends ApiError {
    code = "LLM_AUTH_FAILED";
    constructor() {
        super(503, "The AI provider rejected the API key. Check LLM_API_KEY / LLM_BASE_URL (or MISTRAL_API_KEY) in server/.env.");
    }
}

/*
    Provider errors are shown to users (workflow errors) and stored: keep the cause, drop the provider's
    text, which can echo parts of the key or its hash. The full message stays in the server log only.
*/
export function providerError(error: unknown) {
    const e = error as { status?: number; message?: string };
    const message = String(e?.message ?? "");
    logger.warn({ status: e?.status, error: message.slice(0, 500) }, "AI provider call failed");
    if (e?.status === 401 || e?.status === 403 || /authenticat|invalid (api key|proxy server token)|incorrect api key/i.test(message)) return new LlmAuthError();
    if (e?.status === 429) return new Error("The AI provider is rate limiting requests; it will be retried.");
    if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)) return new Error("The AI provider could not be reached; it will be retried.");
    return new Error(`The AI provider returned an error${e?.status ? ` (HTTP ${e.status})` : ""}; it will be retried.`);
}

type ChatModel = ChatOpenAI | ChatMistralAI;
type Provider = { id: "primary" | "mistral"; modelName: (tier: ModelTier) => string; make: (name: string) => ChatModel };

// configured providers in order: the OpenAI-compatible endpoint (LiteLLM, OpenAI, ...) first, Mistral as the fallback
function providers(): Provider[] {
    const list: Provider[] = [];
    if (env.LLM_API_KEY) list.push({
        id: "primary",
        modelName: (tier) => (tier === "fast" ? env.LLM_MODEL_FAST : env.LLM_MODEL_SMART),
        make: (name) => new ChatOpenAI({ model: name, apiKey: env.LLM_API_KEY, configuration: { baseURL: env.LLM_BASE_URL }, temperature: 0.3, maxRetries: 2, timeout: 90_000 }),
    });
    if (env.MISTRAL_API_KEY) list.push({
        id: "mistral",
        modelName: (tier) => (tier === "fast" ? env.MISTRAL_MODEL_FAST : env.MISTRAL_MODEL_SMART),
        make: (name) => new ChatMistralAI({ model: name, apiKey: env.MISTRAL_API_KEY, temperature: 0.3, maxRetries: 2 }),
    });
    return list;
}

// a provider whose key was rejected is skipped for a while instead of failing every call first
// ponytail: per process, in memory; good enough for one API + one worker
const COOLDOWN_MS = 10 * 60_000;
const coolingUntil = new Map<string, number>();
export const resetProviderCooldowns = () => coolingUntil.clear();

/*
    LangChain gateway with fallback: each call tries the configured providers in order and moves on
    when one fails (bad key, outage, rate limit, timeout or unusable output), so an agent run only
    fails when every provider does. Which model answered is recorded with the usage.
*/
class LangChainGateway implements LlmGateway {

    private models = new Map<string, ChatModel>();

    private model(p: Provider, tier: ModelTier) {
        const name = p.modelName(tier);
        const key = `${p.id}:${name}`;
        let model = this.models.get(key);
        if (!model) this.models.set(key, model = p.make(name));
        return { name, model };
    }

    async structured<S extends ZodTypeAny>({ agent, schema, system, user, tier = "smart" }: StructuredCall<S>) {
        const all = providers();
        if (!all.length) throw new LlmNotConfiguredError();
        const ready = all.filter((p) => (coolingUntil.get(p.id) ?? 0) < Date.now());
        // everything cooling down: try them all anyway rather than failing without asking
        const order = ready.length ? ready : all;
        let lastError: Error | undefined;
        for (const [i, p] of order.entries()) {
            const { name, model } = this.model(p, tier);
            try {
                // tool-calling structured output: the response is validated against the zod schema
                const runnable = model.withStructuredOutput(schema, { name: agent.replace(/[^a-zA-Z0-9_]/g, "_"), includeRaw: true });
                const { raw, parsed } = await runnable.invoke([
                    { role: "system", content: system },
                    { role: "user", content: user },
                ], { callbacks: neatlogsCallbacks() }).catch((error: unknown) => { throw providerError(error); });
                if (!parsed) throw new Error(`${agent}: model returned no structured output`);
                const usage = (raw as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
                return {
                    data: schema.parse(parsed) as z.infer<S>,
                    model: p.id === "primary" ? name : `${p.id}:${name}`,
                    inputTokens: usage?.input_tokens ?? 0,
                    outputTokens: usage?.output_tokens ?? 0,
                };
            } catch (error) {
                lastError = error as Error;
                if ((error as { code?: string }).code === "LLM_AUTH_FAILED") coolingUntil.set(p.id, Date.now() + COOLDOWN_MS);
                if (i < order.length - 1) logger.warn({ agent, provider: p.id, next: order[i + 1].id, error: lastError.message.slice(0, 200) }, "AI provider failed; falling back");
            }
        }
        throw lastError!;
    }

}

let gateway: LlmGateway = new LangChainGateway();

export const getLlm = () => gateway;

// used by tests (and future provider routing) to replace the model gateway
export function setLlm(next: LlmGateway) {
    gateway = next;
}
