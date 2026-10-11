// Importing modules
import { traced } from "../shared/observability/neatlogs.js";
import mongoose from "mongoose";
import { z, ZodTypeAny } from "zod";
import { getLlm, ModelTier } from "./llm.js";
import AgentTask from "../shared/models/agentTask.model.js";
import { evaluate } from "../shared/policy/policy.engine.js";
import { getCurrentPolicy, llmCallsToday } from "../shared/policy/policy.service.js";
import { audit } from "../shared/audit/audit.service.js";
import ApiError from "../shared/utils/ApiError.util.js";
import { alert } from "../shared/alerts/alert.service.js";
import { llmCostMinor, recordUsage, release, reserve, settle } from "../shared/billing/budget.service.js";
import logger from "../shared/config/logger.config.js";

export interface AgentRunContext {
    organizationId: mongoose.Types.ObjectId | string;
    workflowId?: mongoose.Types.ObjectId | string;
    correlationId?: string;
    // set when another budget already pays for this call (e.g. a prototype build attempt)
    costCoveredBy?: string;
}

// a typical call, reserved up front and settled with the real token count afterwards
const ESTIMATE_MINOR = llmCostMinor(8000, 2000);
let consecutiveProviderErrors = 0;

export class BudgetExceededError extends ApiError {
    code = "BUDGET_EXCEEDED";
    constructor(reason: string) {
        super(429, reason);
    }
}

/*
    Every model call goes through here: the tenant's AI budget is enforced first,
    then usage and the agent's structured output are recorded for cost tracking,
    debugging and evaluation.
*/
export async function runAgent<S extends ZodTypeAny>(
    ctx: AgentRunContext,
    agent: string,
    call: { schema: S; system: string; user: string; tier?: ModelTier },
): Promise<z.infer<S>> {

    const { config, version } = await getCurrentPolicy(ctx.organizationId);
    const budget = evaluate({ type: "llm.call", callsToday: await llmCallsToday(ctx.organizationId) }, config);
    if (budget.decision === "deny") {
        await audit({
            organizationId: ctx.organizationId, actorType: "agent", actorId: agent, action: "llm.call",
            decision: "deny", outcome: "denied", policyVersion: version, correlationId: ctx.correlationId,
            metadata: { reasons: budget.reasons },
        });
        await alert(ctx.organizationId, "budget_exhausted", "Daily AI budget exhausted; agent runs are paused until tomorrow or the budget is raised.");
        throw new BudgetExceededError(budget.reasons.join("; "));
    }

    // money is held before the call, so concurrent runs cannot overshoot the tenant's budget
    const reservation = ctx.costCoveredBy ? null : await reserve(ctx.organizationId, "llm", ESTIMATE_MINOR, ctx.workflowId ? String(ctx.workflowId) : undefined)
        .catch(async (error) => {
            await alert(ctx.organizationId, "budget_exhausted", `${(error as Error).message}; agent runs are paused until the budget is raised.`);
            throw error;
        });

    const started = Date.now();
    try {
        const result = await traced(
            { agent, organizationId: String(ctx.organizationId), workflowId: ctx.workflowId ? String(ctx.workflowId) : undefined, correlationId: ctx.correlationId },
            () => getLlm().structured({ agent, ...call }),
        );
        consecutiveProviderErrors = 0;
        const durationMs = Date.now() - started;
        const costMinor = ctx.costCoveredBy ? 0 : llmCostMinor(result.inputTokens, result.outputTokens);
        if (reservation) await settle(ctx.organizationId, reservation._id, costMinor);
        await recordUsage(ctx.organizationId, {
            kind: "llm", agent, model: result.model, provider: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
            costMinor, durationMs, workflowId: ctx.workflowId, refId: ctx.costCoveredBy,
        });
        logger.info({ organizationId: String(ctx.organizationId), correlationId: ctx.correlationId, workflowId: ctx.workflowId ? String(ctx.workflowId) : undefined, agent, model: result.model, durationMs, tokens: result.inputTokens + result.outputTokens, costMinor }, "llm.call");
        await AgentTask.create({
            organizationId: ctx.organizationId, workflowId: ctx.workflowId, agent, status: "completed",
            output: result.data, model: result.model, inputTokens: result.inputTokens,
            outputTokens: result.outputTokens, durationMs: Date.now() - started,
        });
        return result.data;
    } catch (error) {
        if (reservation) await release(ctx.organizationId, reservation._id);
        // ponytail: in-process counter; a shared store when many workers need one view of provider health
        const code = (error as { code?: string }).code ?? "";
        if (!["LLM_NOT_CONFIGURED"].includes(code) && !(error instanceof z.ZodError) && ++consecutiveProviderErrors >= 3) {
            await alert(null, "provider_outage", `AI provider failed ${consecutiveProviderErrors} calls in a row: ${(error as Error).message}`);
        }
        await AgentTask.create({
            organizationId: ctx.organizationId, workflowId: ctx.workflowId, agent, status: "failed",
            error: (error as Error).message?.slice(0, 2000), durationMs: Date.now() - started,
        });
        throw error;
    }

}
