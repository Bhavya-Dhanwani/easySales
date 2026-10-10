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
| POST | `/webhooks/email/inbound` | HMAC-signed (`X-EasySales-Signature`), see README |

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

## Outreach, conversations, proposals (Sprint 3 preview, already available)
`POST /v1/leads/:id/run` (research → qualify → outreach), `GET/POST /v1/approvals[/:id/approve|reject]`, `PATCH /v1/approvals/:id` (edit a draft), `GET /v1/conversations[/:id]`, `POST /v1/conversations/:id/inbound|reply`, `POST /v1/leads/:id/proposals`, `POST /v1/proposals/:id/send`, `PATCH /v1/proposals/:id`.

## Configuration & trust
`GET/PUT /v1/business-profile` (each save bumps `version`), `GET/PUT /v1/policies` (immutable versions), `GET/PATCH/DELETE /v1/organization`, `GET /v1/organization/export`, `/v1/organization/members`, `GET/POST/DELETE /v1/suppressions`, `GET /v1/audit-events`, `GET /v1/usage/summary`, `GET /v1/dashboard`, `GET /v1/workflows[/:id]`.
