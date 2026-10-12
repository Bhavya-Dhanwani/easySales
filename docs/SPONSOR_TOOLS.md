# Sponsor tools: what we used, and why we left two out

We looked at three tools for easySales. We kept one, **Neatlogs**, because it does a job the product needs every day. We tested **Entire** and **cfo.ai** against what easySales does, and did not integrate them, for the reasons below.

| Tool | What it is | Decision | One-line reason |
|---|---|---|---|
| **Neatlogs** | Tracing and debugging for AI agents | ✅ **Integrated, live in production** | Our product *is* AI agents talking to real customers; we need to see every model call |
| **Entire** (entire.io) | Records the AI reasoning behind each code commit | ❌ Not integrated | It's a tool for building software, not a feature for our users, and on our public repo it would publish our working sessions |
| **cfo.ai** (AI CFO tools) | AI finance: cash flow, P&L, forecasting from accounting data | ❌ Not integrated | Our users are sales teams, not finance teams; the numbers that matter (cost per lead, margin per deal) are already computed in easySales |

---

## ✅ Neatlogs: integrated

**Why it matters for easySales:** the agents research companies, write emails to real people, answer replies and price proposals. When an email is wrong, or a reply is misread, we have to see exactly what the model was given and what it answered. Neatlogs records every agent run as a trace.

**What we built** ([`server/src/shared/observability/neatlogs.ts`](../server/src/shared/observability/neatlogs.ts)):
- **Every model call is traced:** prompt, structured output, model, token counts, latency and errors (a LangChain callback in [`agents/llm.ts`](../server/src/agents/llm.ts)).
- **Every agent run is a trace,** tagged with the workspace, the agent (research, outreach, conversation…), the workflow and the request's correlation id ([`agents/runAgent.ts`](../server/src/agents/runAgent.ts)). One customer request can be followed across the API and the background worker.
- **Privacy:** personal data is redacted before it leaves the server, and `NEATLOGS_CAPTURE_CONTENT=false` sends timing and token counts only, with no prompts or replies.
- **Safe to leave on:** opt-in by key, never on in tests, and if Neatlogs is unreachable the app keeps working with tracing off. Traces are flushed on shutdown.
- **Live in production:** the API and the worker both log `Neatlogs tracing enabled`.

**Where it already paid off:** our primary AI endpoint started rejecting its key (`401`). We added Mistral as an automatic fallback. Neatlogs shows exactly that on each run: the call to the primary failing, then the same request answered by `mistral:ministral-14b-latest`. That told us the fallback works and what each agent costs.

**The one compromise, made openly:** the Neatlogs SDK pulls in OpenTelemetry 1.x, which has one moderate advisory (`GHSA-8988-4f7v-96qf`). It is in code we never call: it parses inbound trace headers, which easySales never reads. Our CI fails on *every* security advisory, so we allowed exactly this one, with the reason written down and a review date ([`server/audit-allowlist.json`](../server/audit-allowlist.json), review by 2027-01-11). The allowlist entry fails CI if it is still there after the advisory disappears, so it cannot be forgotten.

---

## ❌ Entire (entire.io): evaluated, not integrated

**What it is:** a developer platform from former GitHub CEO Thomas Dohmke. Its first product, the **Checkpoints CLI**, hooks into git and into AI coding agents (Claude Code, Gemini CLI), and on each commit stores the session's prompts, transcript and reasoning on a separate branch (`entire/checkpoints/v1`).

**Why it didn't fit:**
1. **It helps the builders, not our users.** A dentist using easySales to find and win clients gets nothing from it. Our hackathon effort went into what customers use.
2. **Our repository is public.** Pushing the checkpoints branch would publish every working session in full: server paths, deployment steps, error messages that echoed fragments of API keys. Keeping it local defeats the point of sharing it, and making the repo private would hide the code from judges.
3. **We already keep the "why" with every change.** Each commit explains what changed and why (see the git history), and design decisions are written down where the code lives (`docs/`, comments). Entire would add the raw transcript, not new decisions.
4. **Less is safer.** It installs hooks into git and into the AI agent's settings. More hooks are more things that can break a commit or a deploy, for no user benefit.

**When we would adopt it:** with a team of several developers and many AI agents committing in parallel, on a private repository. Then knowing which agent wrote what, and why, becomes worth the extra setup.

---

## ❌ cfo.ai (AI CFO tools): evaluated, not integrated

**What these tools are:** AI finance assistants that connect to accounting and banking (QuickBooks, Xero, Stripe, banks) to analyse cash flow, P&L and forecasts for a company's finance team. We looked at the "AI CFO" products available, such as Fuel AI CFO and Financial Fusion; we could not find a public developer API for a product called exactly "cfo.ai".

**Why it didn't fit:**
1. **Different user.** easySales is for the person *selling*: find leads, contact them, win deals. A CFO tool is for the person *running the books*. Our users don't connect their accounting software to a sales tool, so there would be no data to analyse.
2. **The finance numbers that matter for sales are already built in.** easySales records every AI call, email and demo build in an append-only usage ledger, with costs. From that, the launch dashboard computes **cost per qualified opportunity, cost per won deal, gross margin and net revenue**, spending limits stop runaway costs, and proposals are priced from the business's own price list with tax and payment schedules. An outside CFO tool would duplicate this.
3. **Financial data is sensitive.** Sending a business's accounting data to one more vendor adds privacy and compliance work (and a new item in our privacy policy) for a feature our users didn't ask for.
4. **Our money logic is deliberately deterministic.** Prices, discounts, taxes and limits are computed by code from the business's own settings, never guessed by an AI. That rule is what makes the proposals trustworthy.

**When we would adopt it:** if easySales grew a "revenue operations" side for finance teams, for example forecasting cash from the pipeline next to the company's real bank and accounting data.

---

*Summary for judges:* we integrated the tool that makes AI agents safe to run in front of real customers (Neatlogs), and we chose not to add two tools that would have served us as developers or a different user, at the cost of privacy and complexity.
