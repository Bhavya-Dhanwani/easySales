import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { ago, human, money } from '../lib/format'
import type { AgentTask, Approval, Conversation, Workflow } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

/* -------------------------------- inbox -------------------------------- */

export function Inbox() {
  const { org } = useAuth()
  const { data, loading } = useLoad(() => api<{ conversations: Conversation[] }>('/v1/conversations'), [org?.id])
  return (
    <div className="stack lg fade-in">
      <PageHead index="03 / Inbox" title={<>Conversations, <span className="serif">in context.</span></>} />
      {loading ? <Spinner label="Loading" /> : !data?.conversations.length ? (
        <Empty title="No conversations yet.">A conversation opens when the outreach agent drafts the first email to a lead.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Lead</th><th>Subject</th><th>Last intent</th><th>Status</th><th>Activity</th></tr></thead>
            <tbody>
              {data.conversations.map((c) => (
                <tr key={c._id}>
                  <td><Link to={`/app/leads/${c.leadId}`} style={{ fontWeight: 600, textDecoration: 'none' }}>{c.lead?.company.name ?? 'Lead'}</Link><div className="small muted">{c.lead?.contact?.name}</div></td>
                  <td className="small">{c.subject ?? '—'}{c.summary && <div className="small muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.summary}</div>}</td>
                  <td>{c.lastIntent ? <Badge status={c.lastIntent === 'interested' || c.lastIntent === 'meeting_request' ? 'ok' : c.lastIntent === 'opt_out' || c.lastIntent === 'not_interested' ? 'bad' : ''}>{human(c.lastIntent)}</Badge> : <span className="muted">—</span>}</td>
                  <td><Badge status={c.status} /></td>
                  <td className="small muted">{ago(c.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
          <div className="card tight" style={{ background: 'var(--paper)' }}>
            <div className="small muted mono">To: {a.payload.to}</div>
            <div style={{ fontWeight: 600, margin: '6px 0 8px' }}>{subject}</div>
            <pre className="body">{body}</pre>
          </div>
        )
      ) : (
        <div className="card tight" style={{ background: 'var(--paper)' }}>
          <div className="row-flex between"><span className="small muted mono">To: {a.payload.to}</span><span className="mono">{money(a.payload.totalMinor ?? 0)} · {a.payload.discountPercent ?? 0}% off</span></div>
          <pre className="body" style={{ marginTop: 10, maxHeight: 280, overflow: 'auto' }}>{a.payload.body}</pre>
        </div>
      )}
      {!editing && (
        <div className="row-flex">
          <button className="btn accent" disabled={busy} onClick={() => run(() => api(`/v1/approvals/${a._id}/approve`, { body: { payloadHash: hash } }), 'Approved, sending shortly')}>Approve & send</button>
          {isMessage && <button className="btn ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
          <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/v1/approvals/${a._id}/reject`, { body: {} }), 'Rejected')}>Reject</button>
          <span className="small muted mono" title="The approval only authorizes this exact content">#{hash.slice(0, 8)}</span>
        </div>
      )}
    </article>
  )
}

export function Approvals() {
  const { org } = useAuth()
  const [status, setStatus] = useState('pending')
  const { data, loading, reload } = useLoad(() => api<{ approvals: Approval[] }>(`/v1/approvals?status=${status}`), [org?.id, status])
  return (
    <div className="stack lg fade-in">
      <PageHead index="04 / Approvals" title={<>Nothing leaves <span className="serif">without you.</span></>} />
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
      <PageHead index="05 / Agent runs" title={<>Every step, <span className="serif">on the record.</span></>} />
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
