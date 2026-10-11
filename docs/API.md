# easySales API (v1)

Base URL `/api`. Authenticated routes live under `/api/v1` and need `Authorization: Bearer <accessToken>`. To pick an organization, send `X-Organization-Id`; membership is always checked on the server. Errors have the shape `{ success: false, status, message }`. Asynchronous actions return **202** with a job id. Lists use cursor pagination (`limit` ≤ 100, `cursor` = last `_id`).

## Auth (public)
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | `{ name, email, password, organizationName? }` → creates the user, an organization and a default policy |
| POST | `/auth/login` | sets an httpOnly refresh cookie, returns `accessToken` |
| POST | `/auth/refresh` | rotates the refresh token (single use) |
| POST | `/auth/logout`, `/auth/logoutall` | |
| GET | `/auth/me` | user + organizations |
| POST | `/auth/verify-email` `{ otp }`, `/auth/resend-otp` | `/v1` requires a verified email |
| POST | `/auth/forgot-password`, `/auth/reset-password` | |
| POST | `/webhooks/email/:integrationId` | provider events, HMAC-signed with that account's webhook secret (see below) |

## Leads & research (Sprint 2)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/leads` | filters: `status`, `stage`, `industry`, `country`, `minScore`, `maxScore`, `assignedTo`, `createdAfter`, `createdBefore`, `q`, `cursor`, `limit` |
| POST | `/v1/leads` | manual create; 409 on duplicate |
| POST | `/v1/leads/import` | `{ fileName?, rows: [...] }` (≤ 2000 mapped rows), `Idempotency-Key` header → `ImportJob` |
| GET | `/v1/imports`, `/v1/imports/:id` | progress and counts |
| GET | `/v1/imports/:id/errors.csv` | row-level error report (formula-safe) |
| GET / PATCH / DELETE | `/v1/leads/:id` | PATCH: `opportunityStage`, `contact`, `consent`, `status` (human override) |
| POST | `/v1/leads/:id/research` | 202 `{ jobId, status, leadId }`; `Idempotency-Key` supported |
| GET | `/v1/leads/:id/research` | latest report, criteria breakdown, score, evidence coverage |
| POST | `/v1/leads/:id/qualify` | re-score stored research with the current ICP weights and thresholds (no AI call) |
| POST | `/v1/leads/bulk-research` | `{ leadIds (≤100), dryRun? }`; a dry run returns the usage estimate |
| GET | `/v1/research-jobs`, `/v1/research-jobs/:id` | status, attempts, failure code, token usage, agent outputs |
| POST | `/v1/research-jobs/:id/retry` | failed jobs only |
| GET | `/v1/pipeline/summary` | counts per status, average fit and coverage |

Lead `status`: `new → research_queued → researching → qualified | needs_review | disqualified | research_failed`.
Scoring: `score = Σ weight × {match 1, partial .5, mismatch 0, unknown 0} / Σ weight`; `evidenceCoverage` = known weight / total weight. The thresholds (`minimumScore` 70, `minimumEvidenceCoverage` 60, `reviewScore` 50) are set in the policy, and the weights in the business profile.

## Email, campaigns & conversations (Sprint 3)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/integrations/email` | connection status (credentials are never returned) |
| POST | `/v1/integrations/email/connect` | `{ fromName, fromEmail, replyTo?, host, port (25/465/587/2525), secure, user, password }`: logs in to verify, stores the password AES-256-GCM encrypted, returns the webhook secret **once** |
| POST | `/v1/integrations/email/test`, `/rotate-secret` | health check / new webhook secret |
| DELETE | `/v1/integrations/email` | disconnect (credentials deleted) |
| GET / POST | `/v1/campaigns` | `{ name, objective, audience: { statuses, minScore, industries, countries }, followUpDelaysDays: [3,4], dailyLimit, autoSend }` |
| GET / PATCH | `/v1/campaigns/:id` | `?days=7` analytics with denominators + audience preview |
| POST | `/v1/campaigns/:id/start` · `/pause` · `/complete` | pausing cancels everything not yet sent |
| POST | `/v1/leads/:id/outreach-drafts` | evidence-checked draft (saved, not sent) |
| GET | `/v1/outbound-actions/:id` | draft → pending_approval/queued → sent → delivered/bounced |
| POST | `/v1/outbound-actions/:id/send` | policy decides: queued, review, or blocked |
| POST | `/v1/outbound-actions/:id/reconcile` | `{ outcome: was_sent \| not_sent }` for uncertain sends |
| GET | `/v1/conversations` | `?status=needs_review`, `?assigned=me` |
| GET | `/v1/conversations/:id`, `/messages`, `/activity` | |
| POST | `/v1/conversations/:id/reply` · `/inbound` · `/close` · `/assign` | assigning hands the thread to a human (stops automation) |
| POST | `/v1/recipients/:leadId/suppress` | suppress and cancel everything pending |
| GET | `/v1/review-queue` | approvals count, escalated threads, uncertain sends, recent policy blocks |

**Provider webhook.** `POST /api/webhooks/email/:integrationId` with header `X-EasySales-Signature: <hex HMAC-SHA256 of the raw body>` (the account's webhook secret) and body `{ events: [...] }`:
`{ type: "inbound", id, messageId?, from, subject, text, inReplyTo?, references?, autoSubmitted? }` or `{ type: "delivered" | "bounced" | "complained", id, providerMessageId, bounceType?: "hard" | "soft" }`. Events are stored (deduplicated by `id`) and acknowledged with 202, then processed by the worker. The organization always comes from the integration, never from the payload. Outbound mail uses `<messageId@sender-domain>` as its Message-ID, so replies thread through `In-Reply-To`.

## Requirements, prototypes & proposals (Sprint 4)
The opportunity id is the lead id. Build and extraction requests answer `202 Accepted`.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/opportunities/:id` | latest requirements + version list, prototypes, proposal versions, approved templates, monthly prototype budget |
| GET | `/v1/opportunities/:id/timeline` | audit history of the opportunity, its prototypes and proposals |
| POST | `/v1/opportunities/:id/requirements/extract` | requirements agent reads the conversation (needs at least one inbound message) and stores a new version |
| GET | `/v1/opportunities/:id/requirements` | current version, or `?version=N` |
| PUT | `/v1/opportunities/:id/requirements` | `{ requirements, changeSummary }` → new immutable version; `sourceMessageIds` must belong to this opportunity |
| POST | `/v1/opportunities/:id/prototypes` | header `Idempotency-Key` required; `{ templateId? }`. Policy checks qualification, open questions, template and budgets: `202` (queued or awaiting approval) or `409 { reasons }` |
| GET | `/v1/prototypes/:id`, `/qa-report`, `/artifact` | status and costs; build/test/security results; the built page for internal review |
| POST | `/v1/prototypes/:id/cancel` · `/retry` | retry only failed builds, within budget |
| POST | `/v1/prototypes/:id/publish` · `/expire` | reviewer role. Publishes only a QA-passed, checksum-verified build; returns an expiring `previewUrl`. Expire revokes the link and deletes the page |
| POST | `/v1/opportunities/:id/proposals` | `{ services: (name \| { name, quantity })[], discountPercent, prototypeId? }` → new version priced from the current price book |
| GET | `/v1/proposals/:id` · `/versions` | |
| POST | `/v1/proposals/:id/validate` | stale price book, newer requirements, open questions, expiry and policy, as `issues` + `decision` |
| POST | `/v1/proposals/:id/submit-approval` | approved by policy, or an approval bound to the hash of the exact content |
| POST | `/v1/proposals/:id/send` | a draft is submitted first; an approved version is sent only if it still matches the approved hash |
| POST | `/v1/proposals/:id/revisions` | `{ note, services?, discountPercent?, prototypeId? }` → new version; the old one becomes `superseded` |
| POST | `/v1/proposals/:id/record-acceptance` | `{ acceptedBy, evidence, messageId? }`; sent, unexpired versions only. This records a commercial event, not a contract or payment |

**Public preview.** `GET /api/preview/:token` serves the page with `Content-Security-Policy: sandbox; default-src 'none'; ...`: an opaque origin with no scripts, forms or remote resources. After expiry or revocation it returns `410`.

## Operations, usage & launch controls (Sprint 5)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/health/live` · `/api/health/ready` | liveness; readiness checks the database and (in-process) the worker. Nothing internal is disclosed |
| GET | `/v1/organization/usage` | this month's funnel (qualified → contacted → replies → meetings → demos → views → proposals → won), metered usage by resource, cost per qualified opportunity and per won deal, spend vs limit |
| GET / POST | `/v1/organization/budgets` | limits next to committed + held spend; POST `{ monthlySpendMinor?, maxLlmCallsPerDay?, maxResearchPerDay?, maxConcurrentResearch?, maxConcurrentBuilds?, artifactStorageBytes? }` publishes a new policy version |
| POST | `/v1/opportunities/:id/handoff` | needs an accepted proposal; marks the deal won (only way to reach `won`) and returns the delivery package. Idempotent |
| POST | `/v1/workflows/:id/retry` | requeue a failed job |
| GET | `/api/admin/metrics/summary` | operators (`ADMIN_EMAILS`): API latency/errors, queue depth and age, failures, model latency, usage, demo builds, spend, cost per qualified opportunity |
| GET / POST / DELETE | `/api/admin/feature-flags[/:id]` | `{ key: live_email \| auto_send \| prototypes, enabled, organizationId? }` (no id = all tenants) |
| GET | `/api/admin/dead-letters` · POST `/api/admin/workflows/:id/retry` | failed jobs/events and uncertain sends, kept with their errors |

Every response carries `X-Request-Id` (a sane incoming one is kept). Workflows started by a request use it as their `correlationId`, so logs, jobs and model calls of one action can be found together. `PATCH /v1/proposals/:id` now only accepts `{ status: "rejected" }`: acceptance goes through `record-acceptance`.

## Conversion analytics, experiments & evaluation (Sprint 6)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/analytics/funnel` | `?groupBy=month\|week&bySegment=true`. Cohort funnel from stage events (discovered → researched → ICP-qualified → contacted → delivered → positive reply → qualified opportunity → proposal sent → won/lost), rate definitions, `incomplete` for cohorts under 30 days |
| GET | `/v1/analytics/costs` | `?days=30`. Spend by funnel stage, per opportunity (company and stage only), cost per qualified opportunity, wasted spend |
| GET | `/v1/analytics/lead-quality` | outcomes per score band (high/medium/low) and criteria most often unknown |
| GET / POST | `/v1/experiments` | `{ name, hypothesis, variable: subject_line\|opening\|value_proposition\|call_to_action, audience?: { campaignId?, industries?, minScore? }, variants: [{ label, instruction }] (2–4, first is control), primaryMetric?, minSamplePerVariant? }` |
| POST | `/v1/experiments/:id/start` · `/pause` · `/complete` | completed experiments never restart |
| GET | `/v1/experiments/:id/results` | per-variant funnel, z-score against the control, stopping rule |
| POST | `/v1/leads/:id/research?force=true` | without `force`, fresh research (same profile version, within `qualification.researchFreshDays`) is re-scored instead of re-run |
| POST / GET | `/api/admin/evaluations/run` · `/api/admin/evaluations/results` | operators: run the versioned dataset (`{ live: true }` includes model tasks); results by task, model, prompt hash and dataset version |
| GET | `/api/admin/analytics/worker-capacity` | backlog, oldest due job, run times and failures per job type, process and database health, scaling advice |

Each lead's qualification now carries `priority` (from `qualification.highPriorityScore` / `mediumPriorityScore`) and each criterion an `observedAt`. Higher-priority lead work is leased first.

## Outreach, conversations, proposals (earlier sprints)
`POST /v1/leads/:id/run` (research → qualify → outreach), `GET/POST /v1/approvals[/:id/approve|reject]`, `PATCH /v1/approvals/:id` (edit a draft), `GET /v1/conversations[/:id]`, `POST /v1/conversations/:id/inbound|reply`, `POST /v1/leads/:id/proposals`, `POST /v1/proposals/:id/send`, `PATCH /v1/proposals/:id`.

## Configuration & trust
`GET/PUT /v1/business-profile` (each save bumps `version`), `GET/PUT /v1/policies` (immutable versions), `GET/PATCH/DELETE /v1/organization`, `GET /v1/organization/export`, `/v1/organization/members`, `GET/POST/DELETE /v1/suppressions`, `GET /v1/audit-events`, `GET /v1/usage/summary`, `GET /v1/dashboard`, `GET /v1/workflows[/:id]`.
