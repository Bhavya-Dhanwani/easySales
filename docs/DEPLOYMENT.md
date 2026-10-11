# Deployment, rollback and recovery

## Environment
Copy `server/.env.example` and set at least:

| Variable | Production requirement |
|---|---|
| `NODE_ENV` | `production` |
| `MONGO_URI` | MongoDB Atlas (or a replica set); TLS enabled (`mongodb+srv://`) |
| `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET` | ≥ 32 random chars; the API refuses to start with the dev defaults |
| `CORS_ORIGIN`, `FRONTEND_URL` | your public origin (never `*`) |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_SMART`, `LLM_MODEL_FAST` | AI gateway |
| `SEND_MAIL`, `SMTP_*`, `SENDING_USER` | account emails (verification, password reset). Outreach is sent through each tenant's connected account; production refuses to send outreach without one |
| `ENCRYPTION_KEY` | ≥ 32 random chars; encrypts stored email credentials (the API refuses to start in production without it) |
| `PREVIEW_BASE_URL` | recommended; a separate domain (for example `https://preview.yourdomain.com`) pointed at the API, used for prototype preview links. Defaults to `FRONTEND_URL` |
| `ADMIN_EMAILS` | comma-separated operator emails for `/api/admin/*` and the Operations page |
| `BILLING_CURRENCY`, `LLM_COST_INPUT_PER_MTOK_MINOR`, `LLM_COST_OUTPUT_PER_MTOK_MINOR`, `EMAIL_COST_MINOR` | unit prices used to meter spend (set them to your real provider prices) |
| `GLOBAL_DAILY_SPEND_CAP_MINOR` | optional emergency cap on total daily spend across all tenants |
| `API_RATE_LIMIT_PER_MIN`, `TENANT_RATE_LIMIT_PER_MIN`, `QUEUE_BACKPRESSURE` | per-IP and per-workspace request limits; queue depth above which follow-ups and campaign enrolment wait |
| `WORKER_TYPES` | optional; comma-separated job types a worker process takes (e.g. `prototype.build`), so one workload can scale on its own. Empty means all |
| `APP_VERSION` | optional; recorded on funnel events as the workflow version (defaults to the package version) |
| `ALERT_WEBHOOK_URL` | optional; Slack or Discord incoming webhook |
| `RUN_WORKER` | `false` on API instances when you run a separate worker |

Keep secrets in your platform's secret manager, not in the image (`.dockerignore` excludes every `.env`).

## Deploy
1. CI on `main` must be green: audit, typecheck, tests, lint, build, image.
2. Build and tag with the commit SHA: `docker build -t registry/easysales:<sha> .`
3. Roll out the **worker** first, then the **API** (`docker compose up -d --build` for a single host). Schema changes are additive, and Mongoose builds new indexes on boot.
4. Smoke-check `GET /api/health/ready` (point the platform's health check at it), log in, and open the Leads page.
5. Operating the pilot (alerts, incidents, flags, restore drill): see [RUNBOOK.md](RUNBOOK.md).

## Rollback
- Images are immutable per SHA: redeploy the previous tag (`docker compose` with `image: registry/easysales:<previous-sha>`).
- Data changes in this codebase are additive (new optional fields and new collections), so the previous version can run against the current database.
- Policies and business profiles are versioned. To roll back a bad policy, publish the previous version's values again (the history is under Autonomy & limits).
- Workflows in flight resume from their LangGraph checkpoint after a restart. Messages stuck in `sending` become `uncertain` and are never resent blindly.

## Database
MongoDB Atlas (`MONGO_URI=mongodb+srv://…`). Backups are handled by Atlas cloud backups; enable them on the cluster.

## Security notes
- **In transit:** terminate TLS at the load balancer. `helmet` sends HSTS, and the refresh cookie is `Secure` + `SameSite=None` in production.
- **At rest:** MongoDB Atlas encrypts storage by default.
- **Retention:** message bodies and audit events older than the policy's `retention.messageDays` / `auditDays` are deleted daily by the worker. LangGraph checkpoints expire after 30 days.
- **Alerts:** failed workflows, an exhausted AI budget, reached send caps and uncertain deliveries are written to the audit log as `alert.*` and posted to `ALERT_WEBHOOK_URL`.
- **Prototypes:** the builder agent only fills content slots of fixed templates. Code renders and HTML-escapes the content, and no generated code is ever executed, so no build sandbox is needed. Before publication, QA rejects active markup, links, contact details and prohibited claims. Previews are served with a CSP `sandbox` (opaque origin, no scripts) and expire automatically. If templates ever need real builds (npm, bundlers), run them in a gVisor/Firecracker sandbox with no network or secrets before enabling that.
- **Compliance:** consent basis, opt-out suppression and quiet hours are enforced in code. A legal review per market (e.g. TRAI/DPDP in India, GDPR, CAN-SPAM) is still the operator's responsibility.
