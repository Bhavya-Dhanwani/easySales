# Pilot review: Sprint 6 baseline

Written at the end of Sprint 6. The measurements so far come from internal, synthetic runs; no real prospects have been contacted yet. Re-run this review after every two weeks of the first pilot business (see "How to review the pilot").

## What improved

| Area | Before (Sprint 5) | After (Sprint 6) | Evidence |
|---|---|---|---|
| API throughput, `/api/health/live` | 331 req/s, p95 111 ms | **3,317 req/s, p95 9 ms** | load test below |
| Leads list | 106 req/s, p95 212 ms | **467 req/s, p95 70 ms** | load test below |
| Dashboard | 80 req/s, p95 275 ms | **218 req/s, p95 117 ms** | load test below |
| Repeat research of a lead | paid AI call every time | **free re-score** while research is fresh (`researchFreshDays`, default 30) and the business profile is unchanged | `sprint6.test.ts` "priority queue and research cache" |
| Work order | oldest first | **high-fit leads first** (score bands from policy) | same test |
| Cost visibility | per tenant | **per opportunity and per funnel stage**, plus wasted spend | `GET /v1/analytics/costs` |
| AI changes | unit tests only | **versioned evaluation dataset**, run in CI (deterministic) and on demand with the model | `npm run eval`, Operations → AI evaluations |

### Load test: the bottleneck that was found and fixed

Production build, local MongoDB, 20 concurrent clients, 20 s per path (`scripts/load-test.ts`).

1. **Baseline:** even the trivial liveness endpoint capped at about 330 req/s with a 60 ms median. That meant per-request overhead, not the database.
2. **Cause:** the API error-rate alert (added in Sprint 5) recomputed latency percentiles, a sort over up to 25,000 samples, after **every** request.
3. **Change (one variable):** the alert check now uses running counters and only runs on 5xx responses. Percentiles are computed only when an operator opens the metrics.
4. **Result:** 10× on the overhead-bound endpoint and 2.7–4.4× on data endpoints, with 0 errors throughout.
5. **Next bottleneck:** the dashboard's fan-out of about 10 queries per request (database bound). Next step if pilot traffic needs it: a short per-tenant cache or a pre-aggregated counter, then re-measure.

## What failed or is still unproven

- **Conversion is unmeasured.** There is no real pilot data yet. Every funnel rate, the cost per qualified opportunity and the experiment results need real prospects. The dashboards are ready, the numbers are not.
- **Model quality on live traffic is unknown.** The live evaluation (`npm run eval -- --live`) needs `LLM_API_KEY`. Run it once the key is set and before the pilot. Track the reply-intent and requirements pass rates.
- **Research evidence gaps.** Run Analytics → "Most often unknown" after the first 50 researched leads. A criterion that is usually unknown either needs better sources or less weight.
- **Atlas restore.** The drill was run against the local MongoDB (see RUNBOOK). It still has to be repeated once on the real Atlas cluster.

## Safety and compliance check

- No new external action bypasses policy. Experiments only change the writer's instruction for first-touch emails. Consent, suppression, caps, quiet hours and approvals apply unchanged (tested: an experiment under approval mode still produces `pending_approval`).
- Analytics endpoints return aggregates and company names only, never contact details, and are tenant-scoped (tested).
- `npm audit`: 0 vulnerabilities (server and client). 65 server tests pass. Deterministic evaluations pass 17/17 in CI.

## Decision

- **Do not scale lead volume or infrastructure yet.** No resource is saturated at pilot load (see Operations → Worker capacity → recommendations).
- **Next:** onboard the first pilot business with `auto_send` off. Run one subject-line experiment with at least 50 contacted prospects per variant. Review this document after two weeks, comparing positive reply rate, qualification rate and cost per qualified opportunity against these baselines.
- **Sprint 7 (multi-tenant scale and commercial readiness)** should start only when real data shows qualified opportunities at an acceptable cost.

## How to review the pilot

1. Analytics → cohorts by week. Ignore cohorts marked "still maturing".
2. Compare positive reply rate and qualification rate with the previous review, segment by industry.
3. Analytics → cost per qualified opportunity and "spend that bought nothing".
4. Experiments → results. Act only when the stopping rule is met and |z| ≥ 1.96.
5. Operations → worker capacity, evaluations and incidents since the last review.
6. Record what improved, what failed and the next change here (one change at a time).
