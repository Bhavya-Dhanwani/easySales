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
| POST | `/v1/leads/import` | `{ fileName?, rows: [...], source?: "csv" \| "discovery", research?: boolean }` (≤ 2000 mapped rows), `Idempotency-Key` header → `ImportJob`. `research: true` queues research for the new leads |
| GET | `/v1/leads/discover/niche` | the search terms and areas lead search is locked to |
| POST | `/v1/leads/discover` | `{ what, where }` or `{ auto: true }`, plus `limit?`. Searches OpenStreetMap, locked to the profile's `searchTerms` x `searchAreas`: no niche → 400, off-niche → 403 (audited). `auto` runs the three least recently searched pairs. Returns deduplicated `candidates` (disqualifiers dropped, `alreadyLead` marked), `queries`, `failed`, `disqualified`. Nothing is saved; daily cap `DISCOVERY_SEARCHES_PER_DAY` counts queries (429) |
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
| POST | `/v1/integrations/email/connect` | `{ fromName, fromEmail, replyTo?, host, port (25/465/587/2525), secure, user, password, readInbox? (default true), imapHost?, imapPort? (993/143) }`: logs in to verify (SMTP, and IMAP when reading the inbox), stores the password AES-256-GCM encrypted, returns the webhook secret **once**. Inbox reading starts from the current newest message |
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

## Onboarding, plans & support (Sprint 7)
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/onboarding/organizations` | `{ name, industry, timezone, defaultCurrency? }`: another workspace for the signed-in user (owner; trial starts) |
| GET | `/v1/onboarding/status` | steps `organization → business → icp → voice → email → limits → test_run → activation`, each with what is missing; `currentStep` is the first unfinished one (resumable) |
| PUT | `/v1/onboarding/organization` · `/business-profile` · `/icp` · `/limits` | each saves real configuration (profile and policy versions); `business-profile` confirms voice/claims, `limits` publishes a policy version |
| POST | `/v1/onboarding/validate` | `{ ok, issues: [{ step, issue }] }` |
| POST | `/v1/onboarding/test-run` | 202. Runs the real pipeline on a synthetic lead whose only contact is the requesting user. Never counted in analytics, never enrolled in campaigns |
| POST | `/v1/onboarding/activate` | only when every step passed. **Before activation no message can go to anyone except the test lead** |
| GET | `/v1/plans` | latest active version of each plan |
| GET | `/v1/organization/subscription` · `/v1/organization/entitlements` | subscription (plan version and entitlement snapshot), limits in force, usage this period, `suspended` |
| POST | `/v1/organization/subscription` | `{ planKey }`. During a trial it switches at once; a downgrade waits for period end; an upgrade becomes `pendingPlanKey` until the billing webhook confirms payment |
| POST | `/v1/organization/subscription/cancel` | cancel at period end |
| GET | `/v1/integrations` | every integration with status `connected \| degraded \| disconnected \| not_available` and last health check. Email uses `/v1/integrations/email/connect \| test \| rotate-secret`, `DELETE /v1/integrations/email` |
| GET | `/api/admin/organizations` · `/api/admin/organizations/:id/health` | staff (`ADMIN_EMAILS` or read-only `SUPPORT_EMAILS`). Viewing a workspace's health writes `support.view_health` to its audit log |
| POST | `/api/admin/organizations/:id/subscription` | operators only: `{ planKey?, status?, periodDays?, note }` (pilots, comps, extensions); audited in the tenant's log |
| POST | `/api/admin/plans` | operators only: publish a new immutable plan version |

**Plan limits vs spending limits.** Entitlements (`maxMembers`, `researchJobsPerMonth`, `emailSendsPerMonth`, `prototypeBuildsPerMonth`, `analyticsLevel`, `apiAccess`) count work per subscription period. The policy's `budgets.monthlySpendMinor` caps money. Either one stops spending independently.
- **Enforced in the API:** invites, research and demo requests answer 402 at the limit; advanced analytics and experiments need `analyticsLevel: advanced`.
- **Enforced in the workers:** research waits for the next period; email over quota is held (`queued`, never dropped) and released by an upgrade.
- **Suspension:** past_due beyond a 7-day grace, or cancelled, means suspended (read and export only).

**Billing webhook.** `POST /api/webhooks/billing`, header `X-EasySales-Signature: hex HMAC-SHA256(raw body, BILLING_WEBHOOK_SECRET)`, body `{ id, type: subscription.activated | subscription.renewed | payment.failed | subscription.cancelled, organizationId, planKey?, periodStart?, periodEnd?, customerId?, subscriptionId? }`. Each `id` is applied once. Map your provider's events (Razorpay/Stripe) onto this in a small adapter. A browser redirect is never proof of payment.

## Integrations: CRM & calendar (Sprint 8)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/integrations` | email, HubSpot and Google Calendar with status (`connected \| degraded \| disconnected`), account, last health check / sync, and the field-ownership table. Never tokens |
| POST | `/v1/integrations/:provider/connect` | `hubspot \| google_calendar`. Returns `authorizeUrl` (single-use state, PKCE for Google, least-privilege scopes) |
| GET | `/api/integrations/oauth/:provider/callback` | public; consumes the state (once, 10 min), exchanges the code, encrypts the tokens, binds the account to that workspace only, then redirects to `/app/integrations?connected=…` or `?error=…` |
| POST | `/v1/integrations/:provider/test` · DELETE `/v1/integrations/:provider` | health check; disconnect revokes at the provider and deletes stored tokens |
| PATCH | `/v1/integrations/:provider/settings` | HubSpot `{ stageOwner: platform \| crm }`; Google `{ timezone, workStart, workEnd, workDays, meetingMinutes, bufferMinutes, minNoticeHours }` |
| POST | `/v1/integrations/hubspot/sync` | incremental import as a durable job (202); resumes from its checkpoint after failures or rate limits |
| GET | `/v1/integrations/:provider/sync-status` · `/errors` | checkpoints, linked records, queued pushes/webhooks; actionable errors (e.g. "Reconnect the integration") |
| POST | `/api/webhooks/hubspot` | HubSpot signature v3 (HMAC-SHA256 with the app's client secret over method+URI+body+timestamp), 5-minute replay window, each `eventId` stored once, tenant resolved from the connected portal |
| GET | `/v1/calendar/availability?days=7` | free slots: working hours in the business timezone minus Google free/busy and meetings already held |
| GET / POST | `/v1/calendar/events` | `?leadId=`; POST `{ leadId, start, inviteProspect, title? }`. Slot re-checked, held (no double booking), created with a deterministic event id (retries never duplicate), confirmation sent only after Google confirms |
| PATCH / DELETE | `/v1/calendar/events/:id` | reschedule (re-checked) / cancel; only meetings we booked, never arbitrary calendar events |

**Sync rules.**
- **Pull** applies only CRM-owned fields (contact name, title, phone, identity email; company fields) and ignores updates older than the last one applied.
- **Push** writes only platform-owned fields (deal stage when `stageOwner = platform`, deal amount from the latest sent proposal). CRM-owned values go out only when the record is created.
- **Matching:** contacts by HubSpot id, then by email. Before any create, the record is looked up (domain, email, deal name), so an ambiguous response never causes a duplicate.
- **Consent:** imported contacts get consent basis `none`, so outreach stays blocked until a basis is recorded.
- **Deletions:** a deletion in the CRM marks the mapping and never deletes our history.

The reply agent offers meeting times only from these free slots and never invents availability.

## Next best action & autonomy (Sprint 9)
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/opportunities/:id/evaluate-next-action` | decide now and apply policy; returns the recorded decision |
| GET | `/v1/opportunities/:id/decisions` | decisions (action, reason, evidence ids, missing information, policy decision, status, rules vs model), current sales state, actions valid right now |
| POST | `/v1/opportunities/:id/pause-automation` · `/resume-automation` | pausing expires pending engine approvals and stops follow-ups; resuming marks the reply a human took over as handled, then re-evaluates |
| GET / PUT | `/v1/automation-settings` | `{ level: 1 \| 2 \| 3, eventDriven, inactivityDays }` (published as a policy version; default level 1, events off) |
| GET / POST | `/v1/approvals`, `/v1/approvals/:id/approve \| reject` | engine actions appear as `sales.action`. Approval is bound to a payload hash and a state fingerprint (changed state → 409, re-evaluate) and claimed atomically (two simultaneous approvals: one 409) |

**How a decision is made.**
1. **Facts are read from records:** stage, outreach status, suppression, messages, requirements, demo, proposal, meetings, pending approvals and work in progress.
2. **The sales state is derived:** new, qualified, contacted, engaged, discovery, meeting_scheduled, solution_design, proposal_sent, negotiation, nurture, won or lost.
3. **Code lists the valid actions**, with hard stops first: opted out, suppressed, closed, paused or test → `wait`.
4. **One valid action:** rules decide. **Several:** the model picks one and explains it; anything outside the list is rejected, and only offered evidence ids are kept.
5. **Authorization is server-side by autonomy level:**
   - Level 1: research only; every external action needs approval.
   - Level 2: also routine replies, questions, follow-ups and meeting offers.
   - Level 3: also demo builds within budget and closing declined deals.
   - Proposals always need a human, at every level.
6. **Execution goes through the existing gates** (message policy, caps, quiet hours, budgets, demo eligibility, pricing engine).

Requested discounts are parsed by code: within the limit, a proposal revision is drafted, priced by the pricing engine and approved by a human; over the limit, the decision escalates. "Won" needs acceptance evidence (handoff), never a status edit or a message.

**Events** (when `eventDriven` is on): lead.researched, lead.qualified, email.delivered, conversation.reply_received, conversation.opted_out, meeting.booked, meeting.cancelled, prototype.ready, proposal.sent, proposal.accepted, opportunity.inactive (weekly). Each becomes one idempotent evaluation job, so a duplicated event never produces a second decision or action.

## Release, billing records & launch metrics (Sprint 10)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/webhooks/billing` | adds `invoice.paid` and `payment.refunded` (`amountMinor`, `currency`, `invoiceId`). They are recorded as billing records (money) and never change access |
| GET | `/api/admin/billing/reconciliation` | staff: per workspace, expected vs paid vs refunded this period, with issues ("active without full payment", "paid but cancelled", "payment failed") |
| GET | `/api/admin/launch-dashboard?days=30` | staff: activation, sales outcomes, conversion, economics (usage cost, net revenue, cost per qualified opportunity and win, gross margin), reliability, retention, AI decisions (automatic / approval / blocked / escalated, approvals rejected) with metric definitions |
| GET | `/api/admin/quality-sample` | staff: a random sample of recent AI decisions and messages for human review |

Public pages: `/help`, `/terms`, `/privacy`. Release tooling: `npm run migrate`, `scripts/smoke.ts`, `render.yaml`, `.github/workflows/release.yml`.

## Outreach, conversations, proposals (earlier sprints)
`POST /v1/leads/:id/run` (research → qualify → outreach), `GET/POST /v1/approvals[/:id/approve|reject]`, `PATCH /v1/approvals/:id` (edit a draft), `GET /v1/conversations[/:id]`, `POST /v1/conversations/:id/inbound|reply`, `POST /v1/leads/:id/proposals`, `POST /v1/proposals/:id/send`, `PATCH /v1/proposals/:id`.

## Configuration & trust
`GET/PUT /v1/business-profile` (each save bumps `version`), `GET/PUT /v1/policies` (immutable versions), `GET/PATCH/DELETE /v1/organization`, `GET /v1/organization/export`, `/v1/organization/members`, `GET/POST/DELETE /v1/suppressions`, `GET /v1/audit-events`, `GET /v1/usage/summary`, `GET /v1/dashboard`, `GET /v1/workflows[/:id]`.
