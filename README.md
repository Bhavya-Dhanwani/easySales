# easySales

A multi-tenant AI business development platform. A business describes what it sells and who it sells to; a team of AI agents researches prospects, qualifies them, starts conversations, handles replies and drafts proposals, **inside limits the business controls**.

> Reason with AI. Authorize with policy. Execute with code.

## How it works

```
lead ─► Research agent ─► Qualification agent ─► Outreach agent ─► Policy engine ─┬─► outbox ─► email
          (SSRF-safe          (LLM score +          (approved           (deterministic, ├─► human approval (LangGraph interrupt)
           web fetch)          hard rules)           claims only)        versioned)      └─► denied + audited
reply ──► Conversation agent ─► requirements → CRM ─► reply draft ─► Policy engine ─► …
requirements ◄─ Requirements agent (versioned, confirmed vs assumed, cited messages)
demo ─► eligibility + budget policy ─► Builder agent (content only) ─► approved template ─► QA ─► review ─► expiring sandboxed preview
proposal ─► price book + tax + payment schedule (code) ─► Proposal agent (scope & prose) ─► validate ─► approval bound to content ─► send ─► revise = new version
```

- **Agents** (`server/src/agents`): LangChain over any OpenAI-compatible endpoint (LiteLLM, OpenAI…), zod-validated structured output, untrusted content wrapped and never obeyed.
- **Orchestration** (`server/src/agents/graphs`): LangGraph state graphs with MongoDB checkpoints. A workflow that waits for a human pauses with `interrupt()` and resumes from its checkpoint after the decision, even across restarts.
- **Policy engine** (`server/src/shared/policy`): a pure function decides `allow` / `needs_approval` / `deny` for every external action: consent, suppression, daily caps, follow-up count and spacing, quiet hours, prohibited claims, discount and deal-value limits, and the AI budget. Policies are immutable, versioned documents.
- **Approvals** are bound to a SHA-256 hash of the exact payload; editing the draft re-binds it, and a stale approval is refused.
- **Outbox**: messages are committed before sending, re-checked against policy at send time, and never blindly retried when the outcome is uncertain.
- **Worker** (`server/src/jobs/worker.ts`): Mongo-leased job queue with stale-lease recovery and exponential backoff. It runs in-process or as its own process (`npm run worker`).
- **Budgets & metering**: every AI call, email and demo build is written to an append-only usage ledger. Money is reserved on an atomic per-tenant counter before work starts and settled with the real cost after, so parallel workers cannot overshoot a limit. Feature flags (`live_email`, `auto_send`, `prototypes`) stage the launch per tenant.
- **Conversion**: every lead's first arrival at each funnel stage is an event. Cohort funnels, cost per opportunity and stage, score-band outcomes and controlled outreach experiments are all computed from those events. A versioned evaluation dataset guards scoring, pricing, guardrails and model behaviour (`npm run eval`, also in CI).
- **Commercial readiness**: self-service, resumable onboarding with a safe rehearsal (the only recipient is you) and an explicit activation gate. Versioned plans with entitlement snapshots, enforced by API and workers independently of spending limits. Subscription state changes only through a signed, idempotent billing webhook or audited operator action. Read-only support access.
- **Integrations**: HubSpot CRM and Google Calendar behind provider adapters.
  - Durable, resumable sync with explicit field ownership and duplicate-safe matching.
  - Verified, deduplicated webhooks with replay protection; encrypted OAuth tokens (state + PKCE).
  - Meeting booking only from real free slots.
- **Next best action**: a pure decision core derives the sales state from records and lists the valid actions. The model may only choose among them. Autonomy levels are enforced server-side, events trigger idempotent evaluations, and approvals are bound to the payload and the state, with atomic claims.
- **Operations**: request ids flow into workflow correlation ids and structured logs (secrets redacted); readiness checks; alerts for provider outages, stalled queues, API errors, abnormal spend and failed scheduled tasks; an operators' console for metrics, flags and dead letters.
- **Multi-tenancy**: every tenant-owned model uses a plugin that refuses any query without `organizationId`. Org context and roles are resolved server-side from memberships. Audit events are append-only.

## Stack

| Layer | Choice |
| --- | --- |
| Client | React 19 + TypeScript (Vite), react-router, plain CSS design system |
| API | Express 5 + TypeScript (scaffolded with `make-backend-kit`), zod, helmet, rate limits |
| AI | LangChain (`@langchain/openai`), LangGraph + `@langchain/langgraph-checkpoint-mongodb` |
| Data | MongoDB (Mongoose) |
| Tests | `node:test` + supertest + mongodb-memory-server, fake LLM gateway |

`npm audit` reports **0 vulnerabilities** in both packages (CI enforces this).

## Run locally

```bash
docker run -d --name easysales-mongo -p 27017:27017 mongo:7
```

```bash
cd server && cp .env.example .env && npm install && npm run dev
```

```bash
cd client && npm install && npm run dev
```

Open http://localhost:5173. Set `LLM_API_KEY` (and optionally `LLM_BASE_URL`, `LLM_MODEL_SMART`, `LLM_MODEL_FAST`) in `server/.env` to let the agents run. With `SEND_MAIL=false`, emails (including the signup code) are written to the server log instead of being sent.

Optional demo data (a verified account, business profile and three leads):

```bash
cd server && npm run seed:demo
```

## Tests

```bash
cd server && npm test
```

The suite covers the policy engine, integer pricing, the SSRF guard, tenant isolation, RBAC, the append-only audit log, refresh-token rotation, signed webhooks, and end-to-end agent workflows: approval interrupt and resume, payload-hash binding, opt-out suppression, pricing escalation and budget exhaustion.

## Production

```bash
docker compose up --build
```

This runs the API (which also serves the SPA), a separate agent worker, and MongoDB. In production the API refuses to start with the development JWT secrets or `CORS_ORIGIN=*`.

### Email

Each workspace connects its own sending account (SMTP) under **Settings → Email**. Credentials are verified, then stored AES-256-GCM encrypted. Delivery, bounce, complaint and reply events arrive at that account's signed webhook (see [docs/API.md](docs/API.md)).

## Docs

- [docs/API.md](docs/API.md): endpoint reference (Sprints 1–4)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): environment, deploy, rollback, security
- [docs/RUNBOOK.md](docs/RUNBOOK.md): release targets, controlled launch, alerts, incidents, support, restore and rollback drills
- [docs/PILOT_REVIEW.md](docs/PILOT_REVIEW.md): what improved, what is unproven, and how to review the pilot
- [docs/RELEASE_AUDIT.md](docs/RELEASE_AUDIT.md): all ten sprints, launch gates with evidence, release blockers and the launch decision

## API

Interactive docs live at `/docs`. Authenticated routes are under `/api/v1` and require a bearer access token. To pick an organization, send `X-Organization-Id`; membership is always verified on the server.
