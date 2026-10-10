// Importing modules
import mongoose from "mongoose";
import { z, ZodTypeAny } from "zod";
import { getLlm, ModelTier } from "./llm.js";
import AgentTask from "../shared/models/agentTask.model.js";
import UsageRecord from "../shared/models/usageRecord.model.js";
import { evaluate } from "../shared/policy/policy.engine.js";
import { getCurrentPolicy, llmCallsToday } from "../shared/policy/policy.service.js";
import { audit } from "../shared/audit/audit.service.js";
import ApiError from "../shared/utils/ApiError.util.js";
import { alert } from "../shared/alerts/alert.service.js";

export interface AgentRunContext {
    organizationId: mongoose.Types.ObjectId | string;
    workflowId?: mongoose.Types.ObjectId | string;
    correlationId?: string;
}

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

    const started = Date.now();
    try {
        const result = await getLlm().structured({ agent, ...call });
        await UsageRecord.create({
            organizationId: ctx.organizationId, agent, model: result.model,
            inputTokens: result.inputTokens, outputTokens: result.outputTokens, workflowId: ctx.workflowId,
        });
        await AgentTask.create({
            organizationId: ctx.organizationId, workflowId: ctx.workflowId, agent, status: "completed",
            output: result.data, model: result.model, inputTokens: result.inputTokens,
            outputTokens: result.outputTokens, durationMs: Date.now() - started,
        });
        return result.data;
    } catch (error) {
        await AgentTask.create({
            organizationId: ctx.organizationId, workflowId: ctx.workflowId, agent, status: "failed",
            error: (error as Error).message?.slice(0, 2000), durationMs: Date.now() - started,
        });
        throw error;
    }

}
