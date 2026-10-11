// Importing modules
import { init, shutdown, trace } from "neatlogs";
import { langchainHandler } from "neatlogs/langchain";
import env from "../config/env.config.js";
import logger from "../config/logger.config.js";

/*
    Neatlogs: traces of every AI call (prompt, structured output, model, tokens, latency, errors),
    grouped per agent run and per workflow. Off unless NEATLOGS_API_KEY is set; never on in tests.
    Prompts can contain prospect data, so PII is redacted by the SDK, and
    NEATLOGS_CAPTURE_CONTENT=false sends timing, tokens and metadata only.
*/
let enabled = false;

// metadata-only mode: drop prompt/completion text (input.value, output.value, llm.input_messages.*, ...)
const CONTENT_KEY = /(^|\.)(input|output|messages?|prompts?|completions?|content|documents?)(\.|$)/i;
export function stripContent(spanData: Record<string, any>) {
    for (const key of Object.keys(spanData)) if (CONTENT_KEY.test(key) && !/token/i.test(key)) delete spanData[key];
    return spanData;
}

export async function initNeatlogs(service: "api" | "worker") {
    if (!env.NEATLOGS_API_KEY || env.NODE_ENV === "test") return;
    try {
        await init({
            apiKey: env.NEATLOGS_API_KEY,
            endpoint: env.NEATLOGS_ENDPOINT,
            workflowName: `easysales-${service}`,
            tags: [env.NODE_ENV, service],
            metadata: { service, version: process.env.APP_VERSION ?? process.env.npm_package_version ?? "dev" },
            pii: "redact",
            // the host owns shutdown (graceful drain in server.ts / worker.ts flushes Neatlogs)
            registerShutdownHandlers: false,
            ...(env.NEATLOGS_CAPTURE_CONTENT ? {} : { mask: stripContent }),
        });
        enabled = true;
        logger.info({ service, contentCaptured: env.NEATLOGS_CAPTURE_CONTENT }, "Neatlogs tracing enabled");
    } catch (error) {
        // observability must never stop the product from running
        logger.warn({ error: (error as Error).message }, "Neatlogs could not start; tracing disabled");
    }
}

// LangChain callbacks for a model call (empty when tracing is off)
export const neatlogsCallbacks = () => (enabled ? [langchainHandler({ workflowName: "easysales" })] : []);

/*
    Groups one agent run (and the model call inside it) under a trace carrying the tenant,
    agent and workflow. The correlation id is the session, so every model call made for one
    user request or workflow lines up together in Neatlogs.
*/
export function traced<T>(meta: { agent: string; organizationId: string; workflowId?: string; correlationId?: string }, fn: () => Promise<T>): Promise<T> {
    if (!enabled) return fn();
    return trace({
        name: `agent.${meta.agent}`, kind: "CHAIN", sessionId: meta.correlationId,
        tags: [meta.agent], metadata: { organizationId: meta.organizationId, workflowId: meta.workflowId, correlationId: meta.correlationId },
    }, () => fn());
}

export async function shutdownNeatlogs() {
    if (enabled) await shutdown("process exit", 5000).catch(() => false);
}
