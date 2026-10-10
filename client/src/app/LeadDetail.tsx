import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, idempotencyKey } from '../lib/api'
import { ago, human } from '../lib/format'
import { STAGES, type Approval, type Conversation, type Lead, type Message, type Proposal, type Workflow } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import OpportunityWorkspace from './Opportunity'

interface LeadBundle {
  lead: Lead
  conversation: Conversation | null
  messages: Message[]
  workflows: Workflow[]
  proposals: Proposal[]
  approvals: Approval[]
}

const PIPELINE_STEPS = ['research', 'draft_outreach', 'policy_check', 'awaiting_approval', 'done']
const REPLY_STEPS = ['classify_reply', 'policy_check', 'awaiting_approval', 'done']

function Timeline({ wf }: { wf: Workflow }) {
  const steps = wf.type === 'conversation.reply' ? REPLY_STEPS : wf.type === 'lead.pipeline' ? PIPELINE_STEPS : wf.type === 'lead.research' ? ['research', 'done'] : ['queued', 'done']
  const at = wf.status === 'completed' ? steps.length - 1 : Math.max(0, steps.indexOf(wf.currentStep))
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={s} className={`step ${i < at || wf.status === 'completed' ? 'done' : i === at ? 'now' : ''}`}>
          <span className="step-dot">{i < at || wf.status === 'completed' ? '✓' : i + 1}</span>
          <div className="row-flex between">
            <span className="small">{human(s)}</span>
            {i === at && wf.status !== 'completed' && (wf.status === 'running' ? <span className="spinner" /> : <Badge status={wf.status} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function DraftComposer({ leadId, onDone }: { leadId: string; onDone: () => void }) {
  const toast = useToast()
  const [draft, setDraft] = useState<Message | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const make = async () => {
    setBusy(true)
    try {
      const r = await api<{ draft: Message }>(`/v1/leads/${leadId}/outreach-drafts`, { method: 'POST' })
      setDraft(r.draft); setSubject(r.draft.subject ?? ''); setBody(r.draft.body)
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }
  const send = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const r = await api<{ status: string; reasons: string[] }>(`/v1/outbound-actions/${draft._id}/send`, { body: { subject, body } })
      toast(r.status === 'queued' ? 'Queued for sending' : r.status === 'pending_approval' ? `Sent to review: ${r.reasons[0] ?? ''}` : `Blocked: ${r.reasons[0] ?? ''}`, r.status === 'rejected')
      setDraft(null)
      onDone()
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }
  if (!draft) return <button className="btn sm lime" disabled={busy} onClick={make}>{busy ? 'Writing…' : 'Draft email with AI'}</button>
  return (
    <div className="card stack draft-card">
      <div className="row-flex between"><span className="h3">Draft · not sent</span><button className="linkish" onClick={() => setDraft(null)}>Discard</button></div>
      <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
      <textarea className="textarea" style={{ minHeight: 200 }} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Body" />
      {!!draft.claims?.length && (
        <div className="stack sm">
          <span className="label">Personalisation checked against research</span>
          {draft.claims.map((c, i) => <div key={i} className="row-flex between small"><span>{c.claim}</span><Badge status={c.verified ? 'approved' : 'pending'}>{c.verified ? 'backed by evidence' : 'unverified → review'}</Badge></div>)}
        </div>
      )}
      <div className="row-flex"><button className="btn" disabled={busy} onClick={send}>Send</button><span className="small muted">Your policy decides: send now, ask for review, or block.</span></div>
    </div>
  )
}

export default function LeadDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const [inbound, setInbound] = useState('')
  const [reply, setReply] = useState('')

  const { data, loading, reload } = useLoad(
    () => api<LeadBundle>(`/v1/leads/${id}`),
    [id],
    (d) => ['research_queued', 'researching'].includes(d.lead.status) || d.workflows.some((w) => w.status === 'queued' || w.status === 'running') || d.proposals.some((p) => p.status === 'generating') || d.messages.some((m) => m.status === 'queued' || m.status === 'sending'),
  )

  if (loading) return <Spinner label="Loading lead" />
  if (!data) return <Empty title="Lead not found." action={<Link className="btn" to="/app/leads">Back to leads</Link>} />

  const { lead, conversation, messages, workflows, approvals } = data
  const active = workflows.find((w) => ['queued', 'running', 'waiting_approval'].includes(w.status))
  const latest = workflows[0]

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); await reload() } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <div className="stack lg fade-in">
      <PageHead index={`Lead · ${lead.company.domain ?? 'no website'}`} title={lead.company.name}>
        <select className="select" style={{ width: 160 }} value={lead.opportunityStage} aria-label="Stage"
          onChange={(e) => act(() => api(`/v1/leads/${lead._id}`, { method: 'PATCH', body: { opportunityStage: e.target.value } }), 'Stage updated')}>
          {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn ghost" disabled={Boolean(active)} onClick={() => act(() => api(`/v1/leads/${lead._id}/research`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() } }), 'Research queued')}>
          {lead.research?.status === 'done' ? 'Refresh research' : 'Research'}
        </button>
        <button className="btn lime" disabled={Boolean(active)} onClick={() => act(() => api(`/v1/leads/${lead._id}/run`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() } }), 'Agents started')}>
          {active ? <><span className="spinner" /> Working…</> : 'Run full agent'}
        </button>
      </PageHead>

      {approvals.length > 0 && (
        <div className="card row-flex between" style={{ borderColor: 'rgba(178,106,0,.35)', background: 'rgba(178,106,0,.05)' }}>
          <span><b>{approvals.length}</b> action{approvals.length > 1 ? 's' : ''} for this lead need{approvals.length > 1 ? '' : 's'} your approval.</span>
          <Link className="btn sm" to="/app/review">Review</Link>
        </div>
      )}

      <div className="split">
        <div className="stack lg">
          <section className="card stack">
            <div className="row-flex between">
              <span className="h2">Qualification</span>
              <span className="row-flex"><Badge status={lead.status} />{lead.qualification?.overriddenBy && <span className="badge plain">manual override</span>}</span>
            </div>
            {lead.qualification?.score !== undefined ? <>
              <div className="grid-2">
                <div>
                  <div className="row-flex between"><span className="label">Fit score</span><span className="score">{lead.qualification.score}</span></div>
                  <div className="meter"><i style={{ width: `${lead.qualification.score}%` }} /></div>
                </div>
                <div>
                  <div className="row-flex between"><span className="label">Evidence coverage</span><span className="score" style={{ color: 'var(--forest-3)' }}>{lead.qualification.evidenceCoverage ?? 0}%</span></div>
                  <div className="meter"><i style={{ width: `${lead.qualification.evidenceCoverage ?? 0}%` }} /></div>
                </div>
              </div>
              <p style={{ margin: 0 }}>{lead.qualification.rationale}</p>
              {!!lead.qualification.flags?.length && <div className="chips">{lead.qualification.flags.map((f) => <span key={f} className="badge warn plain">{f}</span>)}</div>}
              {!!lead.qualification.criteria?.length && (
                <div>
                  <div className="crit label" style={{ borderTop: 0 }}><span>ICP criterion</span><span>Weight</span><span>Result</span><span className="exp">Why</span></div>
                  {lead.qualification.criteria.map((c) => (
                    <div key={c.criterionId} className="crit">
                      <span style={{ fontWeight: 600 }}>{c.label}</span>
                      <span className="mono">{c.weight}</span>
                      <span><Badge status={c.result} /></span>
                      <span className="exp small muted">{c.explanation}{c.evidenceUrls.filter((u) => u.startsWith('http')).map((u) => <a key={u} href={u} target="_blank" rel="noreferrer noopener" style={{ marginLeft: 6 }}>source ↗</a>)}{c.evidenceUrls.includes('lead-record') && <span className="badge plain" style={{ marginLeft: 6, height: 20 }}>your data</span>}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="row-flex">
                <button className="btn ghost sm" onClick={() => act(() => api(`/v1/leads/${lead._id}/qualify`, { method: 'POST' }), 'Re-scored with your current ICP')}>Re-qualify (no AI)</button>
                {(['qualified', 'needs_review', 'disqualified'] as const).filter((s) => s !== lead.status).map((s) => (
                  <button key={s} className="linkish" onClick={() => act(() => api(`/v1/leads/${lead._id}`, { method: 'PATCH', body: { status: s } }), `Marked ${human(s)}`)}>Mark {human(s)}</button>
                ))}
              </div>
              <span className="small muted">Scored by code from the evidence below · profile v{lead.qualification.profileVersion ?? 1} · {ago(lead.qualification.evaluatedAt)}</span>
            </> : <p className="muted small" style={{ margin: 0 }}>{lead.status === 'research_failed' ? 'Research failed. Check Research activity for the reason, then retry.' : 'Not scored yet. Research the lead to evaluate it against your ideal customer profile.'}</p>}
          </section>

          <section className="card stack">
            <div className="row-flex between"><span className="h2">Research report</span>{lead.research?.researchedAt && <span className="small muted">{ago(lead.research.researchedAt)}</span>}</div>
            {lead.research?.summary ? <>
              <p style={{ margin: 0, fontSize: 16 }}>{lead.research.summary}</p>
              {!!lead.research.sources?.length && <div className="chips">{lead.research.sources.map((u) => <a key={u} className="tag" href={u} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'none' }}>{new URL(u).pathname === '/' ? new URL(u).hostname : new URL(u).pathname} ↗</a>)}</div>}
              <div className="grid-2">
                <div className="stack sm">
                  <span className="label">Verified findings</span>
                  {(lead.research.evidence ?? []).filter((e) => e.verified).map((e, i) => <div key={i} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>✓ {e.claim}{e.sourceUrl && <a href={e.sourceUrl} target="_blank" rel="noreferrer noopener" style={{ marginLeft: 6 }}>↗</a>}</div>)}
                  {!(lead.research.evidence ?? []).some((e) => e.verified) && <span className="small muted">None verified.</span>}
                </div>
                <div className="stack sm">
                  <span className="label">Unverified / inferred</span>
                  {(lead.research.evidence ?? []).filter((e) => !e.verified).map((e, i) => <div key={i} className="small muted" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>? {e.claim}</div>)}
                  {!(lead.research.evidence ?? []).some((e) => !e.verified) && <span className="small muted">Nothing unverified.</span>}
                </div>
              </div>
              {!!lead.research.needs?.length && <div><div className="label" style={{ marginBottom: 8 }}>Possible needs (hypotheses, not requests)</div><div className="chips">{lead.research.needs.map((n) => <span className="tag" key={n}>{n}</span>)}</div></div>}
              {!!lead.research.conflicts?.length && <div className="chips">{lead.research.conflicts.map((c) => <span key={c} className="badge bad plain">Conflict: {c}</span>)}</div>}
            </> : <p className="muted small" style={{ margin: 0 }}>No report yet.</p>}
          </section>

          <section className="stack">
            <div className="row-flex between"><span className="h2">Conversation</span><span className="row-flex">{conversation && <Badge status={conversation.status} />}{conversation && <Link className="btn sm ghost" to={`/app/inbox?c=${conversation._id}`}>Open in inbox</Link>}</span></div>
            {lead.status === 'qualified' && lead.contact?.email && conversation?.status !== 'suppressed' && <DraftComposer leadId={lead._id} onDone={reload} />}
            {conversation?.summary && <div className="card tight small"><span className="label">AI summary · </span>{conversation.summary}</div>}
            {messages.length === 0 ? <Empty title="No messages yet.">The outreach agent drafts the first email after qualification.</Empty> : (
              <div className="thread">
                {messages.map((m) => (
                  <div key={m._id} className={`msg ${m.direction === 'inbound' ? 'in' : 'out'}`}>
                    <div className="msg-head">
                      <span className="label">{m.direction === 'inbound' ? `Prospect${m.intent ? ` · ${human(m.intent)}` : ''}` : human(m.kind)}</span>
                      <span className="row-flex"><Badge status={m.status} /><span className="small muted">{ago(m.sentAt ?? m.createdAt)}</span></span>
                    </div>
                    {m.subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{m.subject}</div>}
                    <pre className="body">{m.body}</pre>
                    {m.error && <div className="small form-error" style={{ marginTop: 8 }}>{m.error}</div>}
                  </div>
                ))}
              </div>
            )}
            {conversation && conversation.status !== 'suppressed' && (
              <div className="grid-2">
                <div className="card stack">
                  <div className="label">Log their reply</div>
                  <textarea className="textarea" placeholder="Paste the prospect's reply; the conversation agent will classify it and draft an answer." value={inbound} onChange={(e) => setInbound(e.target.value)} />
                  <div><button className="btn sm" disabled={!inbound.trim()} onClick={() => act(async () => { await api(`/v1/conversations/${conversation._id}/inbound`, { body: { body: inbound }, headers: { 'Idempotency-Key': idempotencyKey() } }); setInbound('') }, 'Reply logged, agent is responding')}>Log reply</button></div>
                </div>
                <div className="card stack">
                  <div className="label">Write it yourself</div>
                  <textarea className="textarea" placeholder="Your reply (an opt-out line is not added to human replies)." value={reply} onChange={(e) => setReply(e.target.value)} />
                  <div><button className="btn sm ghost" disabled={!reply.trim()} onClick={() => act(async () => { await api(`/v1/conversations/${conversation._id}/reply`, { body: { body: reply }, headers: { 'Idempotency-Key': idempotencyKey() } }); setReply('') }, 'Reply queued')}>Send reply</button></div>
                </div>
              </div>
            )}
          </section>

          <OpportunityWorkspace leadId={lead._id} />
        </div>

        <aside className="stack lg" style={{ position: 'sticky', top: 20 }}>
          <section className="card stack">
            <div className="row-flex between"><span className="h2">Agent run</span>{latest && <Link className="small" to="/app/runs">All runs</Link>}</div>
            {latest ? <>
              <div className="row-flex between"><span className="mono small">{human(latest.type)}</span><Badge status={latest.status} /></div>
              <Timeline wf={latest} />
              {latest.result?.outcome && <div className="small">Outcome: <b>{human(latest.result.outcome)}</b></div>}
              {latest.lastError && <div className="small form-error">{latest.failureCode}: {latest.lastError}</div>}
              {workflows.length > 1 && (
                <div className="stack sm">
                  <span className="label">History</span>
                  {workflows.slice(1).map((w) => (
                    <div key={w._id} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
                      <span>{human(w.type)} · {ago(w.createdAt)}</span><Badge status={w.status} />
                    </div>
                  ))}
                </div>
              )}
            </> : <p className="small muted" style={{ margin: 0 }}>No runs yet.</p>}
          </section>

          <section className="card stack">
            <span className="h2">Contact</span>
            <dl className="kv">
              <dt>Name</dt><dd>{lead.contact?.name ?? '—'}</dd>
              <dt>Title</dt><dd>{lead.contact?.title ?? '—'}</dd>
              <dt>Email</dt><dd className="mono">{lead.contact?.email ?? '—'}</dd>
              <dt>Website</dt><dd>{lead.company.website ? <a href={lead.company.website} target="_blank" rel="noreferrer noopener">{lead.company.domain} ↗</a> : '—'}</dd>
              <dt>Industry</dt><dd>{lead.company.industry ?? '—'}</dd>
              <dt>Country</dt><dd>{lead.company.country ?? '—'}</dd>
              <dt>Consent</dt><dd><Badge status={lead.consent?.basis === 'none' ? 'needs_review' : 'ok'}>{human(lead.consent?.basis)}</Badge></dd>
              <dt>Outreach</dt><dd><Badge status={lead.outreachStatus} /></dd>
            </dl>
          </section>

          {(lead.requirements?.needs?.length || lead.requirements?.budget || lead.requirements?.timeline) ? (
            <section className="card stack">
              <span className="h2">Captured requirements</span>
              <dl className="kv">
                <dt>Needs</dt><dd>{lead.requirements?.needs?.join(', ') || '—'}</dd>
                <dt>Budget</dt><dd>{lead.requirements?.budget || '—'}</dd>
                <dt>Timeline</dt><dd>{lead.requirements?.timeline || '—'}</dd>
              </dl>
            </section>
          ) : null}

          <button className="linkish" style={{ color: 'var(--bad)' }} onClick={async () => {
            if (!window.confirm(`Delete ${lead.company.name} and its conversation history? This cannot be undone.`)) return
            await act(() => api(`/v1/leads/${lead._id}`, { method: 'DELETE' }), 'Lead deleted')
            nav('/app/leads')
          }}>Delete lead</button>
        </aside>
      </div>
    </div>
  )
}
