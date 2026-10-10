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

## API

Interactive docs live at `/docs`. Authenticated routes are under `/api/v1` and require a bearer access token. To pick an organization, send `X-Organization-Id`; membership is always verified on the server.
