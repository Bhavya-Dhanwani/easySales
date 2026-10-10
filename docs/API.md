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

## Outreach, conversations, proposals (earlier sprints)
`POST /v1/leads/:id/run` (research → qualify → outreach), `GET/POST /v1/approvals[/:id/approve|reject]`, `PATCH /v1/approvals/:id` (edit a draft), `GET /v1/conversations[/:id]`, `POST /v1/conversations/:id/inbound|reply`, `POST /v1/leads/:id/proposals`, `POST /v1/proposals/:id/send`, `PATCH /v1/proposals/:id`.

## Configuration & trust
`GET/PUT /v1/business-profile` (each save bumps `version`), `GET/PUT /v1/policies` (immutable versions), `GET/PATCH/DELETE /v1/organization`, `GET /v1/organization/export`, `/v1/organization/members`, `GET/POST/DELETE /v1/suppressions`, `GET /v1/audit-events`, `GET /v1/usage/summary`, `GET /v1/dashboard`, `GET /v1/workflows[/:id]`.
