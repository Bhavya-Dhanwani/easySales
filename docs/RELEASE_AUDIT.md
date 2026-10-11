# Release audit: general availability

Date: 2026-10-11 · Scope: Sprints 1–10 · Evidence: automated tests (85 server tests, 31 deterministic evaluation cases), audits, drills and load tests recorded in this repo.

## Sprint deliverables

| Sprint | Delivered | Evidence | Open |
|---|---|---|---|
| 1 Foundation, auth, tenancy | Verified accounts, refresh rotation, organizations and roles, tenant plugin refusing unscoped queries, policy engine, approvals bound to payload hashes, outbox, audit | `tenancy`, `policy`, `pipeline` tests | none |
| 2 Leads and research | CSV import with dedupe and error report, SSRF-safe research, evidence verification, deterministic scoring | `sprint2` tests | none |
| 3 Outreach and conversations | Tenant mailboxes (encrypted), signed webhooks, threading, 9 reply intents, follow-ups that stop, campaigns | `sprint3` tests | none |
| 4 Demos and proposals | Requirements versions, template demos with QA, sandboxed expiring previews, priced proposal versions, acceptance | `sprint4` tests | none |
| 5 Production hardening | Usage ledger, atomic budgets, flags, tracing, health checks, alerts, runbook | `sprint5` tests; load test; restore and rollback drills (local) | **Atlas restore drill** |
| 6 Conversion and scaling | Funnel events, cohorts, cost per opportunity, experiments, evaluation dataset, capacity view; 10× API throughput fix | `sprint6` tests; `PILOT_REVIEW.md` | **real pilot data** |
| 7 Commercial readiness | Self-service onboarding with activation gate, versioned plans and entitlements, signed billing webhook, support access | `sprint7` tests | **payment provider adapter** |
| 8 Integrations | HubSpot and Google Calendar adapters, OAuth (state + PKCE), resumable sync, verified webhooks, real-availability booking; paging bug fixed | `sprint8` tests; `npm run pilot:hubspot` (simulator 10/10) | **pilot on a real HubSpot test portal** |
| 9 Controlled autonomy | Next-best-action core, autonomy levels, event-driven evaluations, pause/resume/escalate, state-bound approvals with atomic claim | `sprint9` tests; decision guardrail evals | none |
| 10 Release | Migrations with lock, staging → production pipeline with smoke tests, billing records and reconciliation, launch dashboard, customer journey and negative-path tests, Help / Terms / Privacy | `sprint10` tests; smoke 8/8 on a production build | see blockers |

## Launch gates

| Gate | Status | Evidence / what is missing |
|---|---|---|
| No unresolved critical release-blocking security issues | ✅ | `npm audit` 0 (server, client); tenant isolation, SSRF, injection, signature, replay and credential tests. No external penetration test yet (recommended before scaling past pilots) |
| Tenant isolation, credentials, approvals and suppression rules pass their tests | ✅ | cross-tenant tests in sprints 1–9; approvals bound to payload + state with atomic claim; opt-out tests |
| Critical workflows recover from provider and worker failures | ✅ | provider outage, rate limits, revoked tokens, stale leases, uncertain sends, lost responses (sprints 5, 8, 10) |
| Backups, restoration, monitoring and rollback verified | ⚠️ partial | monitoring/alerts, migrations and rollback (previous release on current data) verified; **restore drill done on local MongoDB only: repeat on Atlas** |
| A business can onboard and activate without manual engineering | ✅ | self-service onboarding and activation; customer journey test |
| Customer documentation, support ownership and billing procedures ready | ⚠️ | Help / Terms / Privacy, support and billing procedures in RUNBOOK. **Name the support owner; get legal review of Terms and Privacy; connect the payment provider** |
| Pilot metrics based on real, verifiable outcomes | ❌ | dashboards and definitions are ready; **no real pilot has run yet** |
| Usage costs, pricing assumptions and capacity reviewed | ⚠️ | metering, cost per opportunity and capacity tooling ready; **unit prices (`LLM_COST_*`) and plan prices need the owner's review against real pilot costs** |

## Release blockers (must be closed before general availability)

1. Run one pilot business through the full journey on staging, then production (Level 1 Copilot, `live_email` on, strict limits) and record real outcomes in `PILOT_REVIEW.md`.
2. Repeat the restore drill on the Atlas cluster (RUNBOOK → Backup restore drill).
3. Connect the payment provider to `/api/webhooks/billing` (small adapter) or keep charging manually with plans set by an operator.
4. Legal review of Terms, Privacy and outreach practices for each market (e.g. India DPDP, GDPR, CAN-SPAM).
5. Set `LLM_API_KEY`, run `npm run eval -- --live` and record the pass rates.
6. Run `npm run pilot:hubspot` on a real HubSpot test portal (if HubSpot is offered at launch).

## Launch decision

**Extend the pilot.** The software gates that can be proven by tests and drills pass. The business gates (real outcomes, costs, payment, legal) need a real pilot and owner decisions. Proceed to general availability when blockers 1–4 are closed and the pilot shows qualified opportunities at an acceptable cost with no sev-1 incidents for two weeks.
