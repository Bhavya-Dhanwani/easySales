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
| `SEND_MAIL`, `SMTP_*`, `SENDING_USER` | real mail delivery |
| `WEBHOOK_SECRET` | inbound email signature |
| `ALERT_WEBHOOK_URL` | optional; Slack or Discord incoming webhook |
| `RUN_WORKER` | `false` on API instances when you run a separate worker |

Keep secrets in your platform's secret manager, not in the image (`.dockerignore` excludes every `.env`).

## Deploy
1. CI on `main` must be green: audit, typecheck, tests, lint, build, image.
2. Build and tag with the commit SHA: `docker build -t registry/easysales:<sha> .`
3. Roll out the **worker** first, then the **API** (`docker compose up -d --build` for a single host). Schema changes are additive, and Mongoose builds new indexes on boot.
4. Smoke-check `GET /api/health`, log in, and open the Leads page.

## Rollback
- Images are immutable per SHA: redeploy the previous tag (`docker compose` with `image: registry/easysales:<previous-sha>`).
- Data changes in this codebase are additive (new optional fields and new collections), so the previous version can run against the current database.
- Policies and business profiles are versioned. To roll back a bad policy, publish the previous version's values again (the history is under Autonomy & limits).
- Workflows in flight resume from their LangGraph checkpoint after a restart. Messages stuck in `sending` become `uncertain` and are never resent blindly.

## Backups and restore (tested)
```bash
scripts/db.sh backup  "mongodb+srv://…/easysales"     # gzip archive in backups/
scripts/db.sh restore backups/<file> "mongodb://…/easysales"
scripts/db.sh verify  "mongodb://…/easysales"         # backup → restore into <db>_restore_check → compare counts → drop
```
`verify` was run against the development database (34 documents restored, counts matched). On Atlas, also enable continuous cloud backups and run `verify` against a staging cluster monthly.

## Security notes
- **In transit:** terminate TLS at the load balancer. `helmet` sends HSTS, and the refresh cookie is `Secure` + `SameSite=None` in production.
- **At rest:** use MongoDB Atlas (encrypted storage by default) or encrypted volumes. Backups in `backups/` are gitignored; store them in encrypted object storage.
- **Retention:** message bodies and audit events older than the policy's `retention.messageDays` / `auditDays` are deleted daily by the worker. LangGraph checkpoints expire after 30 days.
- **Alerts:** failed workflows, an exhausted AI budget, reached send caps and uncertain deliveries are written to the audit log as `alert.*` and posted to `ALERT_WEBHOOK_URL`.
- **Compliance:** consent basis, opt-out suppression and quiet hours are enforced in code. A legal review per market (e.g. TRAI/DPDP in India, GDPR, CAN-SPAM) is still the operator's responsibility.
