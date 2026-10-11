// Importing modules
import { createHash, randomUUID } from "node:crypto";
import { DATASET_VERSION, DECISIONS, GUARDRAILS, PRICING, QUALIFICATION, REPLY_INTENT, REQUIREMENTS, SCORING } from "./dataset.js";
import { authorize, candidates, canTransition, SalesAction } from "../shared/sales/engine.js";
import { calculateLeadScore, decideStatus } from "../shared/qualification/scoring.js";
import { priceProposal } from "../shared/utils/pricing.util.js";
import { handleInbound, isAutoReply, isOptOut } from "../agents/conversation.agent.js";
import { extractRequirements } from "../agents/requirements.agent.js";
import { getLlm, setLlm } from "../agents/llm.js";
import { GLOBAL_ORG } from "../shared/billing/budget.service.js";
import env from "../shared/config/env.config.js";
import ModelEvaluation from "../shared/models/modelEvaluation.model.js";

export interface EvalResult {
    taskType: string;
    exampleId: string;
    passed: boolean;
    modelVersion: string;
    promptVersion: string;
    failureCategory?: string;
    detail?: string;
}

const PROFILE = {
    businessName: "Eval Studio", businessType: "Web agency", description: "Booking websites for clinics.", brandVoice: "warm",
    services: [{ name: "Booking website", basePriceMinor: 80_000_00 }], approvedClaims: [], prohibitedClaims: [],
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function deterministic(): EvalResult[] {
    const code = { modelVersion: "code", promptVersion: "n/a" };
    const out: EvalResult[] = [];
    for (const e of SCORING) {
        const got = calculateLeadScore(e.criteria.map((c) => ({ weight: e.weights[c.criterionId], result: c.result })));
        out.push({ taskType: "icp_scoring", exampleId: e.id, passed: same(got, e.expect), ...code, ...(same(got, e.expect) ? {} : { failureCategory: "wrong_score", detail: JSON.stringify(got) }) });
    }
    for (const e of QUALIFICATION) {
        const got = decideStatus(e.input, e.thresholds).status;
        out.push({ taskType: "qualification_decision", exampleId: e.id, passed: got === e.expect, ...code, ...(got === e.expect ? {} : { failureCategory: "wrong_status", detail: got }) });
    }
    for (const e of PRICING) {
        const p = priceProposal(e.services, e.selected, e.discountPercent, e.taxBasisPoints);
        const got = { subtotalMinor: p.subtotalMinor, discountMinor: p.discountMinor, taxMinor: p.taxMinor, totalMinor: p.totalMinor };
        out.push({ taskType: "pricing_consistency", exampleId: e.id, passed: same(got, e.expect), ...code, ...(same(got, e.expect) ? {} : { failureCategory: "wrong_price", detail: JSON.stringify(got) }) });
    }
    for (const e of GUARDRAILS) {
        const got = { optOut: isOptOut(e.text), autoReply: isAutoReply(e.subject) };
        out.push({ taskType: "guardrails", exampleId: e.id, passed: same(got, e.expect), ...code, ...(same(got, e.expect) ? {} : { failureCategory: "guardrail_miss", detail: JSON.stringify(got) }) });
    }
    for (const e of DECISIONS) {
        const options = candidates(e.facts).map((c) => c.action);
        const problems = [
            options[0] !== e.expectFirst && `first action ${options[0]}, expected ${e.expectFirst}`,
            ...(e.forbid ?? []).filter((a) => options.includes(a as SalesAction)).map((a) => `forbidden ${a} offered`),
            ...Object.entries(e.authorize ?? {}).filter(([a, want]) => authorize(a as SalesAction, e.facts).decision !== want).map(([a, want]) => `${a} is ${authorize(a as SalesAction, e.facts).decision}, expected ${want}`),
        ].filter(Boolean) as string[];
        out.push({ taskType: "decision_guardrails", exampleId: e.id, passed: !problems.length, ...code, ...(problems.length ? { failureCategory: "guardrail", detail: problems.join("; ") } : {}) });
    }
    // "Sounds great" is never a win: only acceptance evidence can move a deal to won
    const won = !canTransition("discovery", "won", "agent") && !canTransition("discovery", "won", "user") && canTransition("negotiation", "won", "user", true);
    out.push({ taskType: "decision_guardrails", exampleId: "won-needs-acceptance-evidence", passed: won, ...code, ...(won ? {} : { failureCategory: "guardrail" }) });
    return out;
}

// runs model tasks through the real gateway while recording a hash of each system prompt sent
async function live(): Promise<EvalResult[]> {
    const real = getLlm();
    let prompt = "";
    setLlm({ structured: (c) => { prompt = c.system; return real.structured(c); } });
    const ctx = { organizationId: GLOBAL_ORG, correlationId: "evaluation" };
    const version = () => createHash("sha256").update(prompt).digest("hex").slice(0, 10);
    const out: EvalResult[] = [];
    try {
        for (const e of REPLY_INTENT) {
            try {
                const r = await handleInbound(ctx, { company: { name: "Acme Dental" } }, [{ direction: "outbound", body: "Would online booking help?" }, { direction: "inbound", body: e.text }], PROFILE, "INR");
                const ok = e.accept.includes(r.intent);
                out.push({ taskType: "reply_intent", exampleId: e.id, passed: ok, modelVersion: env.LLM_MODEL_FAST, promptVersion: version(), ...(ok ? {} : { failureCategory: "wrong_intent", detail: r.intent }) });
            } catch (error) {
                out.push({ taskType: "reply_intent", exampleId: e.id, passed: false, modelVersion: env.LLM_MODEL_FAST, promptVersion: version(), failureCategory: "error", detail: (error as Error).message.slice(0, 300) });
            }
        }
        for (const e of REQUIREMENTS) {
            try {
                const msgs = e.messages.map((m, i) => ({ id: (i + 1).toString(16).padStart(24, "0"), direction: m.direction, at: new Date(), body: m.body }));
                const r = await extractRequirements(ctx, { company: { name: "Acme" } }, msgs, PROFILE, "INR");
                const text = JSON.stringify(r.features).toLowerCase();
                const problems = [
                    !e.expect.projectTypes.includes(r.projectType) && `projectType ${r.projectType}`,
                    ...e.expect.mustMention.filter((w) => !text.includes(w)).map((w) => `missing "${w}"`),
                    e.expect.budgetMinorUnits !== r.constraints.budgetMinorUnits && `budget ${r.constraints.budgetMinorUnits}`,
                    r.sourceMessageIds.some((id) => !msgs.some((m) => m.id === id)) && "cited an unknown message",
                ].filter(Boolean) as string[];
                out.push({ taskType: "requirements_extraction", exampleId: e.id, passed: !problems.length, modelVersion: env.LLM_MODEL_SMART, promptVersion: version(), ...(problems.length ? { failureCategory: "extraction", detail: problems.join("; ") } : {}) });
            } catch (error) {
                out.push({ taskType: "requirements_extraction", exampleId: e.id, passed: false, modelVersion: env.LLM_MODEL_SMART, promptVersion: version(), failureCategory: "error", detail: (error as Error).message.slice(0, 300) });
            }
        }
    } finally {
        setLlm(real);
    }
    return out;
}

/*
    Runs the dataset: deterministic checks always, model tasks with `live`. Run it whenever
    the model, a prompt, scoring or workflow logic changes; results are stored per run.
*/
export async function runEvaluation(opts: { live?: boolean; record?: boolean } = {}) {
    const runId = randomUUID();
    const results = [...deterministic(), ...(opts.live ? await live() : [])];
    if (opts.record !== false) {
        await ModelEvaluation.insertMany(results.map((r) => ({ ...r, runId, datasetVersion: DATASET_VERSION, evaluatedAt: new Date() })));
    }
    const byTask = new Map<string, { taskType: string; total: number; passed: number }>();
    for (const r of results) {
        const t = byTask.get(r.taskType) ?? { taskType: r.taskType, total: 0, passed: 0 };
        t.total += 1;
        if (r.passed) t.passed += 1;
        byTask.set(r.taskType, t);
    }
    return { runId, datasetVersion: DATASET_VERSION, live: Boolean(opts.live), passed: results.every((r) => r.passed), summary: [...byTask.values()], failures: results.filter((r) => !r.passed) };
}
