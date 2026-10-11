/*
    Regression check for scoring, qualification, pricing and guardrails (and, with --live,
    the AI tasks against the configured model). Exits non-zero on any failure, so CI can gate on it.

    npm run eval            deterministic only, no database needed
    npm run eval -- --live  also runs the model tasks (needs LLM_API_KEY; costs a few calls)
*/
import { runEvaluation } from "../src/evals/evaluate.js";

const live = process.argv.includes("--live");
const r = await runEvaluation({ live, record: false });
for (const t of r.summary) console.log(`${t.passed === t.total ? "PASS" : "FAIL"} ${t.taskType}: ${t.passed}/${t.total}`);
for (const f of r.failures) console.log(`  ✗ ${f.taskType}/${f.exampleId}: ${f.failureCategory} ${f.detail ?? ""}`);
console.log(`dataset ${r.datasetVersion}${live ? " (live)" : " (deterministic)"}`);
process.exit(r.passed ? 0 : 1);
