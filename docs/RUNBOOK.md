# Operations runbook

For whoever is on call for easySales during the pilot. Keep it short and current.

## Release targets (pilot workload)

| Measure | Target | How it is checked |
|---|---|---|
| API p95 latency (list/dashboard endpoints) | ≤ 300 ms | `npx tsx scripts/load-test.ts` against staging; `/api/admin/metrics/summary` → `api.last5m.p95Ms` |
| API error rate (5xx) | ≤ 1 % | load test; `api_errors` alert fires above 10 % over 5 min |
| Oldest due job / email | ≤ 10 min | `queue.oldestDueAgeSec`; `queue_stalled` alert |
| Spend per qualified opportunity | set per pilot (start at ₹150) | `GET /api/v1/organization/usage` → `costPerQualifiedMinor` |
| Tenant monthly spend | `budgets.monthlySpendMinor` | enforced by reservations; `budget_exhausted`, `abnormal_spend` alerts |

**Production build, local MongoDB, 20 concurrent clients, 20 s per path (2026-10-11, after the Sprint 6 fix):** liveness 3,317 req/s p95 9 ms · leads list 467 req/s p95 70 ms · dashboard 218 req/s p95 117 ms · 0 errors. All targets met. Before the fix: 331 / 106 / 80 req/s (see PILOT_REVIEW.md). Repeat against staging before the pilot with the same command.

## Controlled launch

1. **Internal:** create a test workspace, set its `live_email` flag **off** (Operations → Feature flags). Emails are captured as sent and never delivered. Run synthetic leads through research → outreach → reply → demo → proposal → handoff.
2. **One pilot business:** they sign up and follow Setup themselves (business, ICP, voice, mailbox, limits, a rehearsal email to themselves, then **Activate**). Nothing reaches a real prospect before activation. Give them their plan from Operations → Workspaces → Set plan (recorded in their audit log) until a billing provider is wired to the billing webhook. Then configure: configure its ICP, services/price book, terms, connected mailbox, roles and strict limits (Autonomy & limits → monthly spend, research per day, demo budget). Start with `auto_send` **off**: every message and proposal waits for a human even where policy would allow it.
3. **Limited autonomy:** after a week with clean delivery and no incidents, turn `auto_send` on for that tenant. Exceptions (discounts, prohibited claims, low confidence, pricing questions) still require approval by policy.
4. **Expand** to a few more businesses only after reviewing delivery/bounce rates, reply quality, cost per opportunity, demo success and incidents.

Kept under human control throughout: exceptional pricing, contracts, payments, production deployments of client work.

## Autonomy rollout

- New workspaces start at **Level 1 (Copilot)** with event-driven automation off: the engine recommends and asks.
- Move a pilot to **Level 2** after a week of approvals that needed no edits. Move to **Level 3** only for workflows that passed evaluation (`npm run eval` covers the decision guardrails).
- An escalation pauses that opportunity. A human handles it and presses **Resume**; the reply they took over is not re-escalated.

## Alerts and first response

Alerts go to the logs, the tenant's audit log (tenant alerts) and `ALERT_WEBHOOK_URL` (Slack/Discord).

For AI problems (wrong output, slow or failing model calls, cost spikes), open Neatlogs when `NEATLOGS_API_KEY` is set. Each agent run is a trace named `agent.<agent>`. Its session is the request's correlation id (the `x-request-id` in the logs), and its metadata holds the workspace and workflow id.

| Alert | First check | Typical fix |
|---|---|---|
| `provider_outage` (AI) | provider status page; `/api/admin/metrics/summary` → `model24h.failed` | wait/switch `LLM_BASE_URL`; failed jobs → Operations → Dead letters → Retry |
| `provider_outage` (email) | tenant's mailbox (Email account → Test) | tenant rotates the password / fixes SMTP; queued mail retries on its own |
| `queue_stalled` | is the worker running? `/api/health/ready` → `worker` | restart the worker; stale leases recover automatically |
| `api_errors` | logs by `requestId` for 5xx lines | roll back (below) if it started with a deploy |
| `abnormal_spend` | `/api/v1/organization/usage` for that tenant | lower the tenant's limits or turn `auto_send` off; investigate a loop |
| `budget_exhausted` | expected when a tenant hits its limit | tenant raises the limit, or wait for the next period |
| `uncertain_send` | provider logs for that message | reconcile in Review queue (`was_sent` / `not_sent`); never resend blindly |
| `scheduled_task_failed` | logs for `task` | fix the cause; the task runs again on the next tick |

**Emergency brake:** set `GLOBAL_DAILY_SPEND_CAP_MINOR` (all tenants) or turn `live_email`/`auto_send` off globally (Operations → flag with an empty organization id). Both take effect without a deploy (flags) or on restart (env).

## Incident procedure

1. **Declare** in the team channel: what is broken, since when, who leads.
2. **Contain** first: flags off, spend cap, scale the worker to zero (`RUN_WORKER=false`, stop worker), or roll back.
3. **Diagnose** with `requestId` / `correlationId`: one id links the HTTP request, its workflow, model calls (`llm.call` lines) and the audit trail.
4. **Recover:** retry dead letters, reconcile uncertain sends, re-enable flags gradually.
5. **Review** within 2 working days: timeline, cause, what will prevent it. Cross-tenant access, unauthorized outreach or a preview escaping its sandbox are **sev-1** and block releases until fixed and covered by a test.

## Integrations pilot

1. Create a HubSpot **developer test account** and a Google Cloud OAuth client in testing mode. Set the env vars from DEPLOYMENT.md.
2. **Automated pilot (HubSpot):** create a private app in the developer test account (contacts, companies and deals read+write), put its token in `server/.env` as `HUBSPOT_PILOT_TOKEN`, then run `npm run pilot:hubspot`. It refuses non-test portals and uses a throwaway database. It checks import-once, consent, mapping uniqueness, push-once (contact, company, deal), CRM-owned changes and platform-owned data. It also proves every pre-existing CRM record is unchanged, and deletes its own records. Record the result below.

   | Date | Portal | Result |
   |---|---|---|
   | 2026-10-11 | simulator (`PILOT_SIMULATE=1`) | 10/10 passed. Found and fixed a paging bug that could skip records |
   | _pending_ | your HubSpot test portal | |
3. Connect both from Integrations in a pilot workspace, run **Sync now**, and check that linked counts match the CRM and that no duplicates appear. Run it twice.
4. Edit a contact in HubSpot and confirm the change arrives (webhook). Qualify a lead here and confirm the deal appears there.
5. Book, move and cancel a meeting from a lead, and cancel one inside Google Calendar; the change shows here within a few minutes.
6. Only then enable it for a real business.
7. If a connection shows **degraded**, its token was revoked or expired. Errors say "Reconnect the integration": reconnecting resumes the sync from its checkpoint.

## Support workflow

- Support staff (`SUPPORT_EMAILS`) see Operations read-only: workspaces, plan and subscription, onboarding progress, integration health, failed jobs and alerts. Opening a workspace's health is recorded in that workspace's audit log. Only operators (`ADMIN_EMAILS`) can change plans, flags or retry jobs.

- Pilot users report in a shared channel or `support@` with the workspace name, what they did and when.
- Look up the workspace's audit log (Audit log page or `GET /api/v1/audit-events`) and the request id from the browser's network tab (`X-Request-Id` header).
- Data requests: export is `GET /api/v1/organization/export` (secrets excluded); deletion is the owner's "Delete organization" (removes every tenant collection).

## Billing procedures

- **Payments arrive only through the signed billing webhook** (`subscription.*`, `invoice.paid`, `payment.refunded`), or through an operator setting a plan (Operations → Workspaces → Set plan, audited). Never from the browser.
- **Access and quota are separate:**
  - **Overdue** (past due): a 7-day grace period, then read-only.
  - **Cancelled:** works until the end of the paid period, then read-only.
  - **Quota exhausted while paid:** research waits and emails are held (never dropped) until the next period or an upgrade.
- **Reconciliation:** check Operations → Billing reconciliation weekly. "Active without full payment" means chase the payment or set the plan deliberately; "paid but cancelled" means check whether a refund is due.
- **Refunds:** issued in the payment provider. The `payment.refunded` event records them here. A refund never changes access by itself; cancel or change the plan as agreed with the customer.

## Support ownership

| Area | Owner | Backup |
|---|---|---|
| Customer support inbox (`support@…`) | _name the owner before launch_ | |
| Incidents (alerts, sev-1) | _on-call person_ | |
| Billing and refunds | _owner_ | |

## Rollback

- Redeploy the previous image tag (Render: the service's deploy list → Rollback; or the previous commit through the Release workflow).
- Migrations are not rolled back. They are additive, so the previous release keeps working (verified by the rollback drill). Never ship a destructive data change in the same release that stops using it. Schema changes are additive, so the previous version runs on the current database.
- A bad policy: publish the previous values again (versions are immutable and listed in Autonomy & limits).
- A bad flag change: Operations → remove the flag row (the default applies).

## Backup restore drill (do this before the pilot, then quarterly)

1. In Atlas, restore the latest snapshot to a **new** cluster (never over production).
2. Point a staging deploy's `MONGO_URI` at it and start it with `live_email` off globally and `RUN_WORKER=false`.
3. Check: log in as a pilot user, leads/conversations/proposals present, `/api/health/ready` = 200, `GET /api/v1/organization/export` completes.
4. Record restore time and snapshot age here. Delete the restored cluster.

| Date | Where | Restore time | Result |
|---|---|---|---|
| 2026-10-11 | local MongoDB 7: `mongodump --archive --gzip` → `mongorestore --nsFrom easysales.* --nsTo easysales_restore.*` | 1 s (small dataset) | 26/26 collections and identical document counts. The production build started on the restored DB: `/health/ready` 200, login and lead list OK |
| _pending_ | Atlas snapshot → new cluster | | repeat once on the real cluster before the pilot |

## Rollback drill

| Date | What | Result |
|---|---|---|
| 2026-10-11 | Previous release (Sprint 4, `fae4ca6`) built and started against the database written by Sprint 5 | Started cleanly. Login, leads, dashboard, usage, policies and an opportunity workspace all returned 200. Only `/api/health/ready` was missing (it did not exist yet). Rolling back one release is safe because schema changes are additive |

Rule for every release: new fields are optional with defaults, nothing is renamed or removed in the same release, and policy keys are only added inside existing objects (the previous version validates stored policies strictly at the top level).
