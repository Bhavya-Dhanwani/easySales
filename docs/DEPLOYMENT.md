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
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot public app. Redirect URL `<PUBLIC_API_URL>/api/integrations/oauth/hubspot/callback`; webhook target `<PUBLIC_API_URL>/api/webhooks/hubspot` (contact/company/deal creation, deletion, property changes) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | also used for Google Calendar. Add redirect URI `<PUBLIC_API_URL>/api/integrations/oauth/google_calendar/callback` and the scopes `calendar.events`, `calendar.freebusy`, `openid`, `email` to the consent screen |
| `PUBLIC_API_URL` | public origin of the API (OAuth redirects, webhook signature URI). Defaults to `FRONTEND_URL` when the API serves the app |
| `BILLING_WEBHOOK_SECRET` | shared secret for `POST /api/webhooks/billing` (the endpoint answers 503 until it is set) |
| `SUPPORT_EMAILS` | optional; read-only support staff for the Operations page and workspace health |
| `ALERT_WEBHOOK_URL` | optional; Slack or Discord incoming webhook |
| `NEATLOGS_API_KEY`, `NEATLOGS_ENDPOINT`, `NEATLOGS_CAPTURE_CONTENT` | optional AI tracing in [Neatlogs](https://neatlogs.com): every agent run and model call (prompt, output, tokens, latency, errors) with workspace, agent, workflow and request id. Off when the key is empty. PII is redacted; `NEATLOGS_CAPTURE_CONTENT=false` sends timing, tokens and metadata only. Use a separate Neatlogs project per environment |
| `RUN_WORKER` | `false` on API instances when you run a separate worker |

Keep secrets in your platform's secret manager, not in the image (`.dockerignore` excludes every `.env`).

## Environments and release pipeline

- **Environments:**
  - `render.yaml` defines staging and production. Each has an API (which serves the app) and a worker, with health check `/api/health/ready`.
  - Secrets are set per environment in Render, never in the repo or the client bundle (only `VITE_*` values reach the browser).
  - Use separate databases, OAuth clients and billing secrets per environment.
- **Pipeline** (`.github/workflows/release.yml`): CI passes (audit, typecheck, tests, evaluations, lint, build, image) → deploy staging → smoke tests (`server/scripts/smoke.ts`) → approval on the protected `production` environment → deploy production → smoke tests. Secrets needed: `RENDER_STAGING_DEPLOY_HOOK`, `RENDER_PRODUCTION_DEPLOY_HOOK`, `STAGING_URL`, `PRODUCTION_URL`.
- **Migrations:**
  - `node dist/migrate.js` runs as Render's `preDeployCommand`, so a failed migration blocks the release.
  - Each migration runs once, is recorded in `migrations` and is locked against concurrent deploys.
  - Production never builds indexes on boot; migration `001` does it.
  - Migrations are additive, so the previous release keeps working on migrated data.

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
