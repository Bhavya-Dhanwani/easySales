import { Fragment, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, idempotencyKey } from '../lib/api'
import { ago, human, money } from '../lib/format'
import type { AgentTask, Approval, AuditEvent, Conversation, Message, Workflow } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

const INBOX_FILTERS = [['', 'All'], ['needs_review', 'Needs review'], ['open', 'Replied'], ['waiting', 'Waiting'], ['mine', 'Assigned to me'], ['closed', 'Closed']] as const

const intentTone = (i?: string) => (['interested', 'meeting_request'].includes(i ?? '') ? 'ok' : ['opt_out', 'not_interested', 'complaint'].includes(i ?? '') ? 'bad' : ['pricing_question', 'objection', 'unclear'].includes(i ?? '') ? 'pending' : '')

function Thread({ id, onChange }: { id: string; onChange: () => void }) {
  const toast = useToast()
  const [reply, setReply] = useState('')
  const [logged, setLogged] = useState('')
  const [showActivity, setShowActivity] = useState(false)
  const { data, reload } = useLoad(
    () => api<{ conversation: Conversation; messages: Message[] }>(`/v1/conversations/${id}`),
    [id],
    (d) => d.messages.some((m) => ['queued', 'sending'].includes(m.status)),
  )
  const activity = useLoad(() => (showActivity ? api<{ events: AuditEvent[] }>(`/v1/conversations/${id}/activity`) : Promise.resolve({ events: [] })), [id, showActivity])
  if (!data) return <Spinner />
  const { conversation: c, messages } = data
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); await reload(); onChange() } catch (e) { toast((e as Error).message, true) }
  }
  return (
    <div className="stack">
      <div className="row-flex between">
        <div>
          <div className="h2">{c.lead?.company.name}</div>
          <div className="small muted">{c.lead?.contact?.name} · {c.subject}</div>
        </div>
        <div className="row-flex">
          <Badge status={c.status}>{human(c.status)}</Badge>
          {c.conversationState && <span className="badge plain">{human(c.conversationState)}</span>}
        </div>
      </div>
      {c.summary && <div className="card tight small"><b>AI summary · </b>{c.summary}</div>}
      <div className="row-flex">
        <Link className="btn sm ghost" to={`/app/leads/${c.leadId}`}>Open lead</Link>
        {!c.assignedTo
          ? <button className="btn sm ghost" onClick={() => act(() => api(`/v1/conversations/${c._id}/assign`, { body: {} }), 'Assigned to you — automation paused')}>Assign to me</button>
          : <button className="btn sm ghost" onClick={() => act(() => api(`/v1/conversations/${c._id}/assign`, { body: { userId: null } }), 'Unassigned')}>Unassign</button>}
        {!['closed', 'suppressed'].includes(c.status) && <button className="btn sm ghost" onClick={() => act(() => api(`/v1/conversations/${c._id}/close`, { method: 'POST' }), 'Closed')}>Close</button>}
        {c.status !== 'suppressed' && <button className="btn sm danger" onClick={() => window.confirm('Never contact this person again?') && act(() => api(`/v1/recipients/${c.leadId}/suppress`, { method: 'POST' }), 'Suppressed')}>Suppress</button>}
        <button className="linkish" onClick={() => setShowActivity(!showActivity)}>{showActivity ? 'Hide activity' : 'Activity'}</button>
      </div>
      {showActivity && (
        <div className="card tight stack sm">
          {(activity.data?.events ?? []).map((e) => <div key={e._id} className="row-flex between small"><span>{human(e.action)}{(e.metadata as { reason?: string })?.reason ? ` — ${(e.metadata as { reason?: string }).reason}` : ''}</span><span className="muted">{ago(e.createdAt)}</span></div>)}
          {!activity.data?.events.length && <span className="small muted">No events.</span>}
        </div>
      )}
      <div className="thread">
        {messages.map((m) => (
          <div key={m._id} className={`msg ${m.direction === 'inbound' ? 'in' : 'out'}`}>
            <div className="msg-head">
              <span className="label">{m.direction === 'inbound' ? 'Prospect' : human(m.kind)}</span>
              <span className="row-flex">
                {m.intent && <Badge status={intentTone(m.intent)}>{human(m.intent)}{m.classification?.confidence != null ? ` · ${Math.round(m.classification.confidence * 100)}%` : ''}</Badge>}
                {m.direction === 'outbound' && <Badge status={m.status} />}
                <span className="small muted">{ago(m.sentAt ?? m.createdAt)}</span>
              </span>
            </div>
            {m.subject && <div style={{ fontWeight: 600, marginBottom: 6 }}>{m.subject}</div>}
            <pre className="body">{m.body}</pre>
            {m.error && <div className="small form-error" style={{ marginTop: 8 }}>{m.error}</div>}
          </div>
        ))}
      </div>
      {c.status !== 'suppressed' && (
        <div className="grid-2">
          <div className="card stack">
            <div className="label">Your reply</div>
            <textarea className="textarea" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply. Suppression and claim rules still apply." />
            <div><button className="btn sm" disabled={!reply.trim()} onClick={() => act(async () => { await api(`/v1/conversations/${c._id}/reply`, { body: { body: reply }, headers: { 'Idempotency-Key': idempotencyKey() } }); setReply('') }, 'Reply queued')}>Send reply</button></div>
          </div>
          <div className="card stack">
            <div className="label">Log a reply from your mailbox</div>
            <textarea className="textarea" value={logged} onChange={(e) => setLogged(e.target.value)} placeholder="Paste a reply that arrived outside the webhook; the agent will classify it." />
            <div><button className="btn sm ghost" disabled={!logged.trim()} onClick={() => act(async () => { await api(`/v1/conversations/${c._id}/inbound`, { body: { body: logged }, headers: { 'Idempotency-Key': idempotencyKey() } }); setLogged('') }, 'Logged — the agent is on it')}>Log reply</button></div>
          </div>
        </div>
      )}
    </div>
  )
}

export function Inbox() {
  const { org } = useAuth()
  const [params, setParams] = useSearchParams()
  const filter = params.get('filter') ?? ''
  const selected = params.get('c')
  const q = filter === 'mine' ? '?assigned=me' : filter ? `?status=${filter}` : ''
  const { data, loading, reload } = useLoad(() => api<{ conversations: Conversation[] }>(`/v1/conversations${q}`), [org?.id, q])
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }) }
  const convs = data?.conversations ?? []

  return (
    <div className="stack lg fade-in">
      <PageHead index="Inbox" title={<>Every conversation, <span className="hl">in context.</span></>} />
      <div className="status-tabs">{INBOX_FILTERS.map(([v, l]) => <button key={v} className={`status-tab ${filter === v ? 'active' : ''}`} onClick={() => set('filter', v || null)}>{l}</button>)}</div>
      {loading ? <Spinner /> : !convs.length ? <Empty title="Nothing here.">Conversations open when the first email to a lead is drafted.</Empty> : (
        <div className="inbox">
          <div className="inbox-list">
            {convs.map((c) => (
              <button key={c._id} className={`inbox-item ${selected === c._id ? 'active' : ''}`} onClick={() => set('c', c._id)}>
                <div className="row-flex between" style={{ gap: 6 }}><b>{c.lead?.company.name ?? 'Lead'}</b><span className="small muted">{ago(c.lastMessageAt)}</span></div>
                <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.summary || c.subject || 'No messages yet'}</div>
                <div className="row-flex" style={{ gap: 6, marginTop: 6 }}>
                  <Badge status={c.status}>{human(c.status)}</Badge>
                  {c.lastIntent && <Badge status={intentTone(c.lastIntent)}>{human(c.lastIntent)}</Badge>}
                  {c.assignedTo && <span className="badge plain">assigned</span>}
                </div>
              </button>
            ))}
          </div>
          <div className="inbox-pane">{selected ? <Thread id={selected} onChange={reload} /> : <Empty title="Pick a conversation.">Threads that need you are under “Needs review”.</Empty>}</div>
        </div>
      )}
    </div>
  )
}

/* ---------------------------- review queue ----------------------------- */

interface Queue { approvals: number; threads: Conversation[]; uncertain: Message[]; blocked: Message[] }

export function ReviewQueue() {
  const { org } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState<'approvals' | 'threads' | 'uncertain' | 'blocked'>('approvals')
  const { data, reload } = useLoad(() => api<Queue>('/v1/review-queue'), [org?.id, tab])
  const counts = { approvals: data?.approvals ?? 0, threads: data?.threads.length ?? 0, uncertain: data?.uncertain.length ?? 0, blocked: data?.blocked.length ?? 0 }
  const reconcile = (id: string, outcome: 'was_sent' | 'not_sent') => api(`/v1/outbound-actions/${id}/reconcile`, { body: { outcome } }).then(() => { toast(outcome === 'was_sent' ? 'Marked as sent' : 'Queued again'); reload() }).catch((e) => toast(e.message, true))
  const leadName = (m: { lead?: { company: { name: string } } | null }) => m.lead?.company.name ?? 'Lead'

  return (
    <div className="stack lg fade-in">
      <PageHead index="Review queue" title={<>Everything that <span className="hl">needs a human.</span></>} />
      <div className="status-tabs">
        {([['approvals', 'Approvals'], ['threads', 'Escalated threads'], ['uncertain', 'Uncertain sends'], ['blocked', 'Blocked by policy']] as const).map(([k, l]) => (
          <button key={k} className={`status-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l} <b>{counts[k]}</b></button>
        ))}
      </div>
      {tab === 'approvals' && <Approvals embedded />}
      {tab === 'threads' && (!data?.threads.length ? <Empty title="No escalations.">Unclear replies, pricing questions and complaints land here.</Empty> : (
        <div className="stack">{data.threads.map((c) => (
          <div key={c._id} className="card row-flex between">
            <div><b>{leadName(c)}</b> <Badge status={intentTone(c.lastIntent)}>{human(c.lastIntent)}</Badge><div className="small muted" style={{ marginTop: 6 }}>{c.summary}</div></div>
            <Link className="btn sm" to={`/app/inbox?filter=needs_review&c=${c._id}`}>Open thread</Link>
          </div>
        ))}</div>
      ))}
      {tab === 'uncertain' && (!data?.uncertain.length ? <Empty title="No uncertain sends.">If the connection drops mid-send we never resend blindly — confirm with your provider and resolve it here.</Empty> : (
        <div className="stack">{data.uncertain.map((m) => (
          <div key={m._id} className="card row-flex between">
            <div><b>{leadName(m)}</b> · {m.subject}<div className="small form-error">{m.error}</div></div>
            <div className="row-flex"><button className="btn sm ghost" onClick={() => reconcile(m._id, 'was_sent')}>It was sent</button><button className="btn sm" onClick={() => reconcile(m._id, 'not_sent')}>Not sent — retry</button></div>
          </div>
        ))}</div>
      ))}
      {tab === 'blocked' && (!data?.blocked.length ? <Empty title="Nothing blocked this week." /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Lead</th><th>Message</th><th>Why it was stopped</th><th>When</th></tr></thead>
          <tbody>{data.blocked.map((m) => <tr key={m._id}><td>{leadName(m)}</td><td className="small">{human(m.kind)} · {m.subject}</td><td className="small form-error">{m.error}</td><td className="small muted">{ago(m.createdAt)}</td></tr>)}</tbody></table></div>
      ))}
    </div>
  )
}

/* ------------------------------ approvals ------------------------------ */

function ApprovalCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(a.payload.subject ?? '')
  const [body, setBody] = useState(a.payload.body ?? '')
  const [hash, setHash] = useState(a.payloadHash)
  const [busy, setBusy] = useState(false)
  const isMessage = a.targetType === 'message'

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); onDone() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  return (
    <article className="card stack fade-in">
      <div className="row-flex between">
        <div className="row-flex">
          <Badge status="pending">{human(a.actionType)}</Badge>
          {a.lead && <Link to={`/app/leads/${a.lead._id}`} style={{ fontWeight: 600, textDecoration: 'none' }}>{a.lead.company.name}</Link>}
        </div>
        <span className="small muted">requested {ago(a.createdAt)} · expires {ago(a.expiresAt).replace(' ago', '')}</span>
      </div>
      <div className="chips">{a.reasons.map((r) => <span key={r} className="badge warn plain">{r}</span>)}</div>
      {isMessage ? (
        editing ? (
          <div className="stack">
            <label className="field"><span>Subject</span><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
            <label className="field"><span>Body</span><textarea className="textarea" style={{ minHeight: 220 }} value={body} onChange={(e) => setBody(e.target.value)} /></label>
            <div className="row-flex">
              <button className="btn sm" disabled={busy} onClick={() => run(async () => {
                const res = await api<{ approval: Approval }>(`/v1/approvals/${a._id}`, { method: 'PATCH', body: { subject, body } })
                setHash(res.approval.payloadHash)
                setEditing(false)
              }, 'Draft updated')}>Save draft</button>
              <button className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="card tight" style={{ background: 'var(--bg)' }}>
            <div className="small muted mono">To: {a.payload.to}</div>
            <div style={{ fontWeight: 600, margin: '6px 0 8px' }}>{subject}</div>
            <pre className="body">{body}</pre>
          </div>
        )
      ) : a.targetType === 'decision' ? (
        <div className="card tight" style={{ background: 'var(--bg)' }}>
          <div className="small">Next best action: <b>{human(a.payload.action)}</b>{a.payload.params?.discountPercent !== undefined ? ` · ${String(a.payload.params.discountPercent)}% discount (priced by your pricing rules)` : ''}</div>
          {Array.isArray(a.payload.params?.questions) && <ol className="small" style={{ margin: '6px 0 0' }}>{(a.payload.params!.questions as string[]).map((q) => <li key={q}>{q}</li>)}</ol>}
          <div className="small muted" style={{ marginTop: 6 }}>Runs only if the opportunity is still in the state you are looking at; otherwise it is re-evaluated.</div>
        </div>
      ) : a.targetType === 'prototype' ? (
        <div className="card tight" style={{ background: 'var(--bg)' }}>
          <div className="row-flex between"><span className="small">Demo build · {human(a.payload.templateId)} · requirements v{a.payload.requirementsVersion}</span><span className="mono">budget {money(a.payload.budgetMinorUnits ?? 0, a.payload.currency)}</span></div>
        </div>
      ) : (
        <div className="card tight" style={{ background: 'var(--bg)' }}>
          <div className="row-flex between"><span className="small muted mono">To: {a.payload.to}</span><span className="mono">{money(a.payload.totalMinor ?? 0)} · {a.payload.discountPercent ?? 0}% off</span></div>
          <pre className="body" style={{ marginTop: 10, maxHeight: 280, overflow: 'auto' }}>{a.payload.body}</pre>
        </div>
      )}
      {!editing && (
        <div className="row-flex">
          <button className="btn lime" disabled={busy} onClick={() => run(() => api(`/v1/approvals/${a._id}/approve`, { body: { payloadHash: hash } }), a.targetType === 'prototype' ? 'Approved, building now' : a.targetType === 'decision' ? 'Approved, running now' : 'Approved, sending shortly')}>{a.targetType === 'prototype' ? 'Approve build' : a.targetType === 'decision' ? 'Approve action' : 'Approve & send'}</button>
          {isMessage && <button className="btn ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
          <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/v1/approvals/${a._id}/reject`, { body: {} }), 'Rejected')}>Reject</button>
          <span className="small muted mono" title="The approval only authorizes this exact content">#{hash.slice(0, 8)}</span>
        </div>
      )}
    </article>
  )
}

export function Approvals({ embedded = false }: { embedded?: boolean }) {
  const { org } = useAuth()
  const [status, setStatus] = useState('pending')
  const { data, loading, reload } = useLoad(() => api<{ approvals: Approval[] }>(`/v1/approvals?status=${status}`), [org?.id, status])
  return (
    <div className="stack lg fade-in">
      {!embedded && <PageHead index="Approvals" title={<>Nothing leaves <span className="hl">without you.</span></>} />}
      <div className="tabs">{['pending', 'approved', 'rejected', 'expired'].map((s) => <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>{s}</button>)}</div>
      {loading ? <Spinner label="Loading" /> : !data?.approvals.length ? (
        <Empty title={status === 'pending' ? 'All clear.' : `No ${status} approvals.`}>{status === 'pending' ? 'When an agent wants to do something your policy reserves for humans, it waits here.' : ''}</Empty>
      ) : status === 'pending' ? (
        <div className="stack">{data.approvals.map((a) => <ApprovalCard key={a._id} a={a} onDone={reload} />)}</div>
      ) : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Action</th><th>Lead</th><th>Status</th><th>Reasons</th><th>When</th></tr></thead>
          <tbody>{data.approvals.map((a) => <tr key={a._id}><td className="mono">{human(a.actionType)}</td><td>{a.lead?.company.name}</td><td><Badge status={a.status} /></td><td className="small muted">{a.reasons.join('; ')}</td><td className="small muted">{ago(a.createdAt)}</td></tr>)}</tbody></table></div>
      )}
    </div>
  )
}

/* -------------------------------- runs --------------------------------- */

function RunDetail({ id }: { id: string }) {
  const { data } = useLoad(() => api<{ workflow: Workflow; tasks: AgentTask[] }>(`/v1/workflows/${id}`), [id], (d) => ['queued', 'running'].includes(d.workflow.status))
  if (!data) return <Spinner />
  return (
    <div className="stack sm" style={{ padding: '6px 0 4px' }}>
      {data.tasks.length === 0 && <span className="small muted">No agent calls recorded yet.</span>}
      {data.tasks.map((t) => (
        <details key={t._id} className="card tight">
          <summary className="row-flex between" style={{ cursor: 'pointer' }}>
            <span className="row-flex"><Badge status={t.status === 'completed' ? 'ok' : 'failed'}>{t.agent}</Badge><span className="small muted mono">{t.model}</span></span>
            <span className="small muted mono">{t.inputTokens + t.outputTokens} tok · {((t.durationMs ?? 0) / 1000).toFixed(1)}s</span>
          </summary>
          {t.error ? <div className="form-error small" style={{ marginTop: 10 }}>{t.error}</div> : <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 10, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(t.output, null, 2)}</pre>}
        </details>
      ))}
    </div>
  )
}

export function Runs() {
  const { org } = useAuth()
  const toast = useToast()
  const [open, setOpen] = useState<string | null>(null)
  const { data, loading, reload } = useLoad(() => api<{ workflows: Workflow[] }>('/v1/workflows?limit=50'), [org?.id], (d) => d.workflows.some((w) => ['queued', 'running'].includes(w.status)))
  return (
    <div className="stack lg fade-in">
      <PageHead index="Agent runs" title={<>Every step, <span className="hl">on the record.</span></>} />
      {loading ? <Spinner label="Loading" /> : !data?.workflows.length ? <Empty title="No runs yet.">Open a lead and press Run agent.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Workflow</th><th>Step</th><th>Status</th><th>Outcome</th><th>Tries</th><th>Started</th><th /></tr></thead>
            <tbody>
              {data.workflows.map((w) => (
                <Fragment key={w._id}>
                  <tr className="row" onClick={() => setOpen(open === w._id ? null : w._id)}>
                    <td className="mono">{human(w.type)}<div className="small muted">{w.entityType === 'lead' ? <Link to={`/app/leads/${w.entityId}`} onClick={(e) => e.stopPropagation()}>open lead</Link> : w.entityType}</div></td>
                    <td className="small">{human(w.currentStep)}</td>
                    <td><Badge status={w.status} /></td>
                    <td className="small">{w.result?.outcome ? human(w.result.outcome) : w.failureCode ? <span className="form-error">{w.failureCode}</span> : '—'}</td>
                    <td className="mono">{w.attempts}</td>
                    <td className="small muted">{ago(w.createdAt)}</td>
                    <td>{['queued', 'waiting_approval'].includes(w.status) && <button className="linkish" onClick={(e) => { e.stopPropagation(); api(`/v1/workflows/${w._id}/cancel`, { method: 'POST' }).then(() => { toast('Cancelled'); reload() }).catch((err) => toast(err.message, true)) }}>Cancel</button>}</td>
                  </tr>
                  {open === w._id && <tr><td colSpan={7}>{w.lastError && <div className="small form-error" style={{ marginBottom: 8 }}>{w.lastError}</div>}<RunDetail id={w._id} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
