import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, idempotencyKey } from '../lib/api'
import { ago, human, money } from '../lib/format'
import { STAGES, type Approval, type BusinessProfile, type Conversation, type Lead, type Message, type Proposal, type Workflow } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'

interface LeadBundle {
  lead: Lead
  conversation: Conversation | null
  messages: Message[]
  workflows: Workflow[]
  proposals: Proposal[]
  approvals: Approval[]
}

const PIPELINE_STEPS = ['research', 'qualify', 'draft_outreach', 'policy_check', 'awaiting_approval', 'done']
const REPLY_STEPS = ['classify_reply', 'policy_check', 'awaiting_approval', 'done']

function Timeline({ wf }: { wf: Workflow }) {
  const steps = wf.type === 'conversation.reply' ? REPLY_STEPS : wf.type === 'lead.pipeline' ? PIPELINE_STEPS : ['queued', 'done']
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

function ProposalBuilder({ leadId, onCreated }: { leadId: string; onCreated: () => void }) {
  const toast = useToast()
  const { data } = useLoad(() => api<{ profile: BusinessProfile | null }>('/v1/business-profile'), [])
  const [picked, setPicked] = useState<string[]>([])
  const [discount, setDiscount] = useState(0)
  const [busy, setBusy] = useState(false)
  const services = data?.profile?.services ?? []
  if (!data) return <Spinner />
  if (!services.length) return <p className="small muted">Add services with prices in <Link to="/app/business">Business brain</Link> to build proposals.</p>
  const subtotal = services.filter((s) => picked.includes(s.name)).reduce((a, s) => a + s.basePriceMinor, 0)
  return (
    <div className="stack">
      {services.map((s) => (
        <label key={s.name} className="check">
          <input type="checkbox" checked={picked.includes(s.name)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.name] : picked.filter((p) => p !== s.name))} />
          <span style={{ flex: 1 }}>{s.name}</span><span className="mono">{money(s.basePriceMinor)}</span>
        </label>
      ))}
      <label className="field"><span>Discount %</span><input className="input" type="number" min={0} max={100} step={0.5} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></label>
      <div className="row-flex between">
        <span className="small muted">Estimated total <b className="mono" style={{ color: 'var(--ink)' }}>{money(Math.round(subtotal * (1 - discount / 100)))}</b></span>
        <button className="btn sm" disabled={!picked.length || busy} onClick={async () => {
          setBusy(true)
          try {
            await api(`/v1/leads/${leadId}/proposals`, { body: { services: picked, discountPercent: discount } })
            toast('Proposal agent is writing…')
            setPicked([])
            onCreated()
          } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
        }}>Generate proposal</button>
      </div>
    </div>
  )
}

export default function LeadDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const [inbound, setInbound] = useState('')
  const [reply, setReply] = useState('')
  const [showBuilder, setShowBuilder] = useState(false)

  const { data, loading, reload } = useLoad(
    () => api<LeadBundle>(`/v1/leads/${id}`),
    [id],
    (d) => d.workflows.some((w) => w.status === 'queued' || w.status === 'running') || d.proposals.some((p) => p.status === 'generating') || d.messages.some((m) => m.status === 'queued' || m.status === 'sending'),
  )

  if (loading) return <Spinner label="Loading lead" />
  if (!data) return <Empty title="Lead not found." action={<Link className="btn" to="/app/leads">Back to leads</Link>} />

  const { lead, conversation, messages, workflows, proposals, approvals } = data
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
        <button className="btn accent" disabled={Boolean(active)} onClick={() => act(() => api(`/v1/leads/${lead._id}/run`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() } }), 'Agents started')}>
          {active ? <><span className="spinner" style={{ borderTopColor: '#fff' }} /> Running</> : latest ? 'Run again' : 'Run agent'}
        </button>
      </PageHead>

      {approvals.length > 0 && (
        <div className="card row-flex between" style={{ borderColor: 'rgba(178,106,0,.35)', background: 'rgba(178,106,0,.05)' }}>
          <span><b>{approvals.length}</b> action{approvals.length > 1 ? 's' : ''} for this lead need{approvals.length > 1 ? '' : 's'} your approval.</span>
          <Link className="btn sm" to="/app/approvals">Review</Link>
        </div>
      )}

      <div className="split">
        <div className="stack lg">
          <section className="card stack">
            <div className="row-flex between"><span className="label">Research</span><Badge status={lead.research?.status} /></div>
            {lead.research?.summary ? <>
              <p style={{ margin: 0, fontSize: 16 }}>{lead.research.summary}</p>
              {!!lead.research.needs?.length && <div><div className="label" style={{ marginBottom: 8 }}>Likely needs</div><div className="chips">{lead.research.needs.map((n) => <span className="tag" key={n} style={{ textTransform: 'none', fontFamily: 'var(--sans)', fontSize: 13 }}>{n}</span>)}</div></div>}
              {!!lead.research.evidence?.length && (
                <div className="stack sm">
                  <div className="label">Evidence</div>
                  {lead.research.evidence.map((e, i) => (
                    <div key={i} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                      <span style={{ flex: 1, minWidth: 200 }}>{e.claim}</span>
                      <span className="row-flex">
                        {e.sourceUrl && <a className="mono small" href={e.sourceUrl} target="_blank" rel="noreferrer noopener">source ↗</a>}
                        <Badge status={e.verified ? 'approved' : 'pending'}>{e.verified ? 'verified' : 'unverified'}</Badge>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </> : <p className="muted small" style={{ margin: 0 }}>Not researched yet. Press <b>Run agent</b> to research, qualify and draft outreach.</p>}
          </section>

          <section className="card stack">
            <div className="row-flex between"><span className="label">Qualification</span><Badge status={lead.qualification?.status} /></div>
            {lead.qualification?.score !== undefined ? (
              <div className="row-flex" style={{ alignItems: 'flex-start', gap: 22 }}>
                <div><div className="score">{lead.qualification.score}</div><div className="label">/ 100</div></div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <p style={{ margin: 0 }}>{lead.qualification.rationale}</p>
                  {!!lead.qualification.flags?.length && <div className="chips" style={{ marginTop: 10 }}>{lead.qualification.flags.map((f) => <span key={f} className="badge warn plain">{f}</span>)}</div>}
                </div>
              </div>
            ) : <p className="muted small" style={{ margin: 0 }}>No score yet.</p>}
            {lead.qualification?.status && lead.qualification.status !== 'qualified' && lead.qualification.status !== 'unreviewed' && (
              <div><button className="btn ghost sm" onClick={() => act(() => api(`/v1/leads/${lead._id}`, { method: 'PATCH', body: { qualificationStatus: 'qualified' } }), 'Marked qualified')}>Override: mark qualified</button></div>
            )}
          </section>

          <section className="stack">
            <div className="row-flex between"><span className="label">Conversation</span>{conversation && <Badge status={conversation.status} />}</div>
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

          <section className="stack">
            <div className="row-flex between"><span className="label">Proposals</span><button className="btn ghost sm" onClick={() => setShowBuilder(!showBuilder)}>{showBuilder ? 'Close' : 'New proposal'}</button></div>
            {showBuilder && <div className="card"><ProposalBuilder leadId={lead._id} onCreated={() => { setShowBuilder(false); reload() }} /></div>}
            {proposals.length === 0 && !showBuilder && <p className="small muted" style={{ margin: 0 }}>No proposals yet. Prices come from your service catalogue; the agent writes the narrative.</p>}
            {proposals.map((p) => (
              <div key={p._id} className="card stack">
                <div className="row-flex between">
                  <span className="row-flex"><Badge status={p.status} /><span className="mono">{money(p.totalMinor, p.currency)}</span>{p.discountPercent > 0 && <span className="small muted">incl. {p.discountPercent}% discount</span>}</span>
                  <span className="row-flex">
                    {p.status === 'draft' && <button className="btn sm" onClick={() => act(() => api(`/v1/proposals/${p._id}/send`, { method: 'POST' }), 'Proposal submitted')}>Send</button>}
                    {p.status === 'sent' && <>
                      <button className="btn sm" onClick={() => act(() => api(`/v1/proposals/${p._id}`, { method: 'PATCH', body: { status: 'accepted' } }), 'Marked accepted')}>Accepted</button>
                      <button className="btn sm ghost" onClick={() => act(() => api(`/v1/proposals/${p._id}`, { method: 'PATCH', body: { status: 'rejected' } }), 'Marked rejected')}>Rejected</button>
                    </>}
                  </span>
                </div>
                {p.status === 'generating' ? <Spinner label="The proposal agent is writing" /> : <pre className="body">{p.body}</pre>}
              </div>
            ))}
          </section>
        </div>

        <aside className="stack lg" style={{ position: 'sticky', top: 20 }}>
          <section className="card stack">
            <div className="row-flex between"><span className="label">Agent run</span>{latest && <Link className="small" to="/app/runs">All runs</Link>}</div>
            {latest ? <>
              <div className="row-flex between"><span className="mono small">{human(latest.type)}</span><Badge status={latest.status} /></div>
              <Timeline wf={latest} />
              {latest.result?.outcome && <div className="small">Outcome: <b>{human(latest.result.outcome)}</b></div>}
              {latest.lastError && <div className="small form-error">{latest.failureCode}: {latest.lastError}</div>}
            </> : <p className="small muted" style={{ margin: 0 }}>No runs yet.</p>}
          </section>

          <section className="card stack">
            <span className="label">Contact</span>
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
              <span className="label">Captured requirements</span>
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
