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

Last local run (dev build, 20 concurrent clients, 15 s per path): health p95 88 ms, leads list p95 151 ms, dashboard p95 230 ms, 0 errors.

## Controlled launch

1. **Internal:** create a test workspace, set its `live_email` flag **off** (Operations → Feature flags). Emails are captured as sent and never delivered. Run synthetic leads through research → outreach → reply → demo → proposal → handoff.
2. **One pilot business:** configure its ICP, services/price book, terms, connected mailbox, roles and strict limits (Autonomy & limits → monthly spend, research per day, demo budget). Start with `auto_send` **off**: every message and proposal waits for a human even where policy would allow it.
3. **Limited autonomy:** after a week with clean delivery and no incidents, turn `auto_send` on for that tenant. Exceptions (discounts, prohibited claims, low confidence, pricing questions) still require approval by policy.
4. **Expand** to a few more businesses only after reviewing delivery/bounce rates, reply quality, cost per opportunity, demo success and incidents.

Kept under human control throughout: exceptional pricing, contracts, payments, production deployments of client work.

## Alerts and first response

Alerts go to the logs, the tenant's audit log (tenant alerts) and `ALERT_WEBHOOK_URL` (Slack/Discord).

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

## Support workflow

- Pilot users report in a shared channel or `support@` with the workspace name, what they did and when.
- Look up the workspace's audit log (Audit log page or `GET /api/v1/audit-events`) and the request id from the browser's network tab (`X-Request-Id` header).
- Data requests: export is `GET /api/v1/organization/export` (secrets excluded); deletion is the owner's "Delete organization" (removes every tenant collection).

## Rollback

- Redeploy the previous image tag (see DEPLOYMENT.md). Schema changes are additive, so the previous version runs on the current database.
- A bad policy: publish the previous values again (versions are immutable and listed in Autonomy & limits).
- A bad flag change: Operations → remove the flag row (the default applies).

## Backup restore drill (do this before the pilot, then quarterly)

1. In Atlas, restore the latest snapshot to a **new** cluster (never over production).
2. Point a staging deploy's `MONGO_URI` at it and start it with `live_email` off globally and `RUN_WORKER=false`.
3. Check: log in as a pilot user, leads/conversations/proposals present, `/api/health/ready` = 200, `GET /api/v1/organization/export` completes.
4. Record restore time and snapshot age here. Delete the restored cluster.

| Date | Snapshot age | Restore time | Result |
|---|---|---|---|
| _not yet run_ | | | |
