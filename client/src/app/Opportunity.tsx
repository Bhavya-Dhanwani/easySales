import { useState } from 'react'
import { Link } from 'react-router'
import { api, idempotencyKey } from '../lib/api'
import { ago, human, money } from '../lib/format'
import type { AuditEvent, BusinessProfile, FeatureStatus, Proposal, Prototype, RequirementsDoc } from '../lib/types'
import { Badge, Spinner, useLoad, useToast } from '../components/ui'

interface Workspace {
  requirements: RequirementsDoc | null
  requirementVersions: Omit<RequirementsDoc, 'requirements'>[]
  prototypes: Prototype[]
  proposals: Proposal[]
  templates: { id: string; name: string }[]
  budget: { monthSpentMinor: number; monthlyBudgetMinor: number; currency: string }
}

const NEXT_STATUS: Record<FeatureStatus, FeatureStatus> = { confirmed: 'assumed', assumed: 'needs_clarification', needs_clarification: 'confirmed' }
const BUSY_PROTO = ['queued', 'building', 'testing']

// requirements: facts vs assumptions; clicking a status cycles it, saving makes a new version
function RequirementsCard({ leadId, doc, versions, onChange }: { leadId: string; doc: RequirementsDoc | null; versions: Workspace['requirementVersions']; onChange: () => void }) {
  const toast = useToast()
  const [draft, setDraft] = useState<RequirementsDoc['requirements'] | null>(null)
  const r = draft ?? doc?.requirements
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); onChange() } catch (e) { toast((e as Error).message, true) } }
  const edit = (fn: (d: RequirementsDoc['requirements']) => void) => { const next = structuredClone(r!); fn(next); setDraft(next) }

  return (
    <section className="card stack">
      <div className="row-flex between">
        <span className="h2">Requirements</span>
        <span className="row-flex">
          {doc && <span className="badge plain">v{doc.version} · {doc.createdBy.startsWith('agent') ? 'extracted by agent' : 'edited'} · {ago(doc.createdAt)}</span>}
          <button className="btn ghost sm" onClick={() => run(() => api(`/v1/opportunities/${leadId}/requirements/extract`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() } }), 'Requirements agent is reading the conversation')}>
            {doc ? 'Re-extract' : 'Extract from conversation'}
          </button>
        </span>
      </div>
      {!r ? <p className="small muted" style={{ margin: 0 }}>Once the prospect replies, the requirements agent turns the conversation into a scoped, versioned brief. Confirmed facts and assumptions are kept apart.</p> : <>
        <div>
          <div style={{ fontWeight: 600, fontSize: 17 }}>{r.title}</div>
          <div className="small muted">{human(r.projectType)} · {r.problemStatement}</div>
        </div>
        <div>
          <div className="crit label" style={{ borderTop: 0, gridTemplateColumns: '1.4fr .6fr 1fr' }}><span>Feature</span><span>Priority</span><span>Status (click to change)</span></div>
          {r.features.map((f, i) => (
            <div key={f.name} className="crit" style={{ gridTemplateColumns: '1.4fr .6fr 1fr' }}>
              <span><b>{f.name}</b><br /><span className="small muted">{f.description}</span></span>
              <span className="mono small">{f.priority}</span>
              <button className="linkish" style={{ justifySelf: 'start' }} onClick={() => edit((d) => { d.features[i].status = NEXT_STATUS[f.status] })}>
                <Badge status={f.status === 'confirmed' ? 'approved' : f.status === 'assumed' ? 'pending' : 'needs_review'}>{human(f.status)}</Badge>
              </button>
            </div>
          ))}
        </div>
        {!!r.acceptanceCriteria.length && <div><div className="label" style={{ marginBottom: 6 }}>Acceptance criteria</div>{r.acceptanceCriteria.map((a) => <div key={a} className="small">✓ {a}</div>)}</div>}
        {!!r.openQuestions.length && (
          <div className="stack sm">
            <span className="label">Open questions · ask before building</span>
            {r.openQuestions.map((q, i) => <div key={q} className="row-flex between small"><span>? {q}</span><button className="linkish" onClick={() => edit((d) => { d.openQuestions.splice(i, 1) })}>Answered</button></div>)}
          </div>
        )}
        <div className="small muted">
          Prospect budget {r.constraints.budgetMinorUnits !== null ? money(r.constraints.budgetMinorUnits, r.constraints.currency) : 'not stated'}
          {r.constraints.targetDate && ` · target ${r.constraints.targetDate}`} · from {r.sourceMessageIds.length} message{r.sourceMessageIds.length === 1 ? '' : 's'}
        </div>
        {draft && (
          <div className="row-flex">
            <button className="btn sm" onClick={() => {
              const changeSummary = window.prompt('What changed? (saved with the new version)')
              if (changeSummary) run(async () => { await api(`/v1/opportunities/${leadId}/requirements`, { method: 'PUT', body: { requirements: draft, changeSummary } }); setDraft(null) }, 'Saved as a new version')
            }}>Save as v{(doc?.version ?? 0) + 1}</button>
            <button className="btn ghost sm" onClick={() => setDraft(null)}>Discard changes</button>
          </div>
        )}
        {versions.length > 1 && <details><summary className="small muted">History ({versions.length} versions)</summary>{versions.map((v) => <div key={v._id} className="small" style={{ borderTop: '1px solid var(--line)', padding: '6px 0' }}>v{v.version} · {v.changeSummary || '—'} · {ago(v.createdAt)}</div>)}</details>}
      </>}
    </section>
  )
}

function QaChecks({ qa }: { qa: NonNullable<Prototype['qaReport']> }) {
  return (
    <div className="stack sm">
      <div className="row-flex">
        {(['buildPassed', 'testsPassed', 'securityPassed'] as const).map((k) => <Badge key={k} status={qa[k] ? 'approved' : 'failed'}>{k.replace('Passed', '')} {qa[k] ? '✓' : '✗'}</Badge>)}
      </div>
      {qa.findings.map((f) => <div key={f} className="small form-error">{f}</div>)}
    </div>
  )
}

function PrototypeRow({ p, onChange }: { p: Prototype; onChange: () => void }) {
  const toast = useToast()
  const [html, setHtml] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); onChange() } catch (e) { toast((e as Error).message, true) } }
  const post = (action: string, ok: string) => run(() => api(`/v1/prototypes/${p._id}/${action}`, { method: 'POST' }), ok)

  return (
    <div className="card tight stack">
      <div className="row-flex between">
        <span className="row-flex">
          <Badge status={p.status === 'needs_review' ? 'pending' : p.status}>{p.status === 'queued' && p.approvalId ? 'awaiting approval' : human(p.status)}</Badge>
          <b>{human(p.templateId)}</b>
          <span className="small muted">req v{p.requirementsVersion} · attempt {p.attempts}/{p.maxAttempts} · {money(p.costMinorUnits, p.currency)} of {money(p.budgetMinorUnits, p.currency)}</span>
        </span>
        <span className="row-flex">
          {BUSY_PROTO.includes(p.status) && <span className="spinner" />}
          {p.status === 'needs_review' && <>
            <button className="btn ghost sm" onClick={async () => { try { setHtml(html ? null : (await api<{ html: string }>(`/v1/prototypes/${p._id}/artifact`)).html) } catch (e) { toast((e as Error).message, true) } }}>{html ? 'Hide' : 'Review demo'}</button>
            <button className="btn sm lime" onClick={() => post('publish', 'Preview link is live')}>Publish preview</button>
          </>}
          {p.status === 'ready' && p.previewUrl && <>
            <a className="btn sm" href={p.previewUrl} target="_blank" rel="noreferrer noopener">Open preview ↗</a>
            <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(p.previewUrl!).then(() => toast('Link copied'))}>Copy link</button>
            <button className="btn danger sm" onClick={() => post('expire', 'Preview revoked')}>Revoke</button>
          </>}
          {p.status === 'failed' && p.failureCode !== 'REJECTED' && <button className="btn ghost sm" onClick={() => post('retry', 'Retrying build')}>Retry</button>}
          {[...BUSY_PROTO, 'needs_review'].includes(p.status) && <button className="linkish" onClick={() => post('cancel', 'Cancelled')}>Cancel</button>}
        </span>
      </div>
      {p.previewExpiresAt && p.status === 'ready' && <span className="small muted">Expires {new Date(p.previewExpiresAt).toLocaleDateString()} · sandboxed page, no scripts, sample data only</span>}
      {p.failureCode && <span className="small form-error">{human(p.failureCode)}</span>}
      {p.qaReport && (p.status === 'failed' || p.status === 'needs_review') && <QaChecks qa={p.qaReport} />}
      {/* sandbox="" : no scripts, no same-origin access, no forms; the page is inert */}
      {html && <iframe title="Demo preview" sandbox="" srcDoc={html} style={{ width: '100%', height: 520, border: '1px solid var(--line)', borderRadius: 12, background: '#fff' }} />}
    </div>
  )
}

function PrototypesCard({ leadId, ws, onChange }: { leadId: string; ws: Workspace; onChange: () => void }) {
  const toast = useToast()
  const [template, setTemplate] = useState('')
  const [busy, setBusy] = useState(false)
  const b = ws.budget
  return (
    <section className="card stack">
      <div className="row-flex between">
        <span className="h2">Demo prototype</span>
        <span className="small muted">{money(b.monthSpentMinor, b.currency)} of {money(b.monthlyBudgetMinor, b.currency)} used this month</span>
      </div>
      <div className="meter"><i style={{ width: `${Math.min(100, (b.monthSpentMinor / Math.max(1, b.monthlyBudgetMinor)) * 100)}%` }} /></div>
      <div className="row-flex">
        <select className="select" style={{ width: 220 }} value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Template">
          <option value="">Template from requirements</option>
          {ws.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn sm" disabled={busy || !ws.requirements} onClick={async () => {
          setBusy(true)
          try {
            const r = await api<{ decision: string; reasons: string[] }>(`/v1/opportunities/${leadId}/prototypes`, { body: template ? { templateId: template } : {}, headers: { 'Idempotency-Key': idempotencyKey() } })
            toast(r.decision === 'allow' ? 'Building the demo' : `Waiting for approval: ${r.reasons[0] ?? ''}`)
            onChange()
          } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
        }}>Build demo</button>
        <span className="small muted">Approved templates only · checked by QA before anyone can see it</span>
      </div>
      {ws.prototypes.map((p) => <PrototypeRow key={p._id} p={p} onChange={onChange} />)}
    </section>
  )
}

function ProposalBuilder({ leadId, ready, onCreated }: { leadId: string; ready: Prototype[]; onCreated: () => void }) {
  const toast = useToast()
  const { data } = useLoad(() => api<{ profile: BusinessProfile | null }>('/v1/business-profile'), [])
  const [picked, setPicked] = useState<string[]>([])
  const [discount, setDiscount] = useState(0)
  const [proto, setProto] = useState(ready[0]?._id ?? '')
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
      <div className="grid-2">
        <label className="field"><span>Discount %</span><input className="input" type="number" min={0} max={100} step={0.5} value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></label>
        {ready.length > 0 && <label className="field"><span>Attach live demo</span>
          <select className="select" value={proto} onChange={(e) => setProto(e.target.value)}><option value="">None</option>{ready.map((p) => <option key={p._id} value={p._id}>{human(p.templateId)} · {ago(p.createdAt)}</option>)}</select>
        </label>}
      </div>
      <div className="row-flex between">
        <span className="small muted">Before tax <b className="mono" style={{ color: 'var(--ink)' }}>{money(Math.round(subtotal * (1 - discount / 100)))}</b> · final numbers are computed by the server</span>
        <button className="btn sm" disabled={!picked.length || busy} onClick={async () => {
          setBusy(true)
          try {
            await api(`/v1/opportunities/${leadId}/proposals`, { body: { services: picked, discountPercent: discount, ...(proto ? { prototypeId: proto } : {}) } })
            toast('Proposal agent is writing…')
            setPicked([])
            onCreated()
          } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
        }}>Generate proposal</button>
      </div>
    </div>
  )
}

function ProposalCard({ p, onChange }: { p: Proposal; onChange: () => void }) {
  const toast = useToast()
  const [issues, setIssues] = useState<string[] | null>(null)
  const run = async (fn: () => Promise<{ decision?: string; reasons?: string[] } | unknown>, ok: string) => {
    try {
      const r = await fn() as { decision?: string; reasons?: string[] }
      toast(r?.decision === 'needs_approval' ? `Sent to review: ${r.reasons?.[0] ?? ''}` : ok)
      onChange()
    } catch (e) { toast((e as Error).message, true) }
  }
  const post = (path: string, ok: string, body?: unknown) => run(() => api(`/v1/proposals/${p._id}/${path}`, { method: 'POST', ...(body ? { body } : {}) }), ok)
  const final = ['accepted', 'rejected', 'expired', 'superseded'].includes(p.status)

  return (
    <div className="card stack" style={final && p.status !== 'accepted' ? { opacity: 0.7 } : undefined}>
      <div className="row-flex between">
        <span className="row-flex">
          <span className="badge plain mono">v{p.version}</span>
          <Badge status={p.status} />
          <span className="mono">{money(p.totalMinor, p.currency)}</span>
          {p.discountPercent > 0 && <span className="small muted">{p.discountPercent}% off</span>}
          {p.taxBasisPoints > 0 && <span className="small muted">incl. {p.taxBasisPoints / 100}% tax</span>}
        </span>
        <span className="row-flex">
          {p.status !== 'generating' && !final && <button className="linkish" onClick={async () => {
            try { const v = await api<{ issues: string[]; reasons: string[] }>(`/v1/proposals/${p._id}/validate`, { method: 'POST' }); setIssues([...v.issues, ...v.reasons.filter((r) => !v.issues.includes(r))]) } catch (e) { toast((e as Error).message, true) }
          }}>Validate</button>}
          {p.status === 'draft' && <button className="btn ghost sm" onClick={() => post('submit-approval', 'Approved by policy, ready to send')}>Submit for approval</button>}
          {(p.status === 'draft' || p.status === 'approved') && <button className="btn sm" onClick={() => post('send', 'Proposal queued for sending')}>Send</button>}
          {p.status === 'sent' && <>
            <button className="btn sm lime" onClick={() => {
              const acceptedBy = window.prompt('Who accepted? (name)')
              const evidence = acceptedBy && window.prompt('Evidence (e.g. "replied go ahead on 12 Oct")')
              if (acceptedBy && evidence) post('record-acceptance', 'Acceptance recorded', { acceptedBy, evidence })
            }}>Record acceptance</button>
            <button className="btn sm ghost" onClick={() => run(() => api(`/v1/proposals/${p._id}`, { method: 'PATCH', body: { status: 'rejected' } }), 'Marked rejected')}>Rejected</button>
          </>}
          {!final && p.status !== 'generating' && <button className="linkish" onClick={() => {
            const note = window.prompt('What should change in the revision?')
            if (!note) return
            const d = window.prompt('Discount % for the new version', String(p.discountPercent))
            post('revisions', 'Writing a new version', { note, ...(d !== null && d !== '' ? { discountPercent: Number(d) } : {}) })
          }}>Revise</button>}
        </span>
      </div>
      {p.revisionNote && <span className="small muted">Revision: {p.revisionNote}</span>}
      {issues && (issues.length ? <div className="chips">{issues.map((i) => <span key={i} className="badge warn plain">{i}</span>)}</div> : <span className="small" style={{ color: 'var(--forest-3)' }}>✓ Matches today’s price book, requirements and policy</span>)}
      {p.acceptance?.acceptedBy && (
        <div className="row-flex between">
          <span className="small">Accepted by <b>{p.acceptance.acceptedBy}</b> · {p.acceptance.evidence} · contract and payment are separate steps</span>
          <button className="btn sm lime" onClick={async () => {
            try {
              const r = await api<{ package: unknown }>(`/v1/opportunities/${p.leadId}/handoff`, { body: {} })
              // the handoff package goes to whatever delivery process the business uses
              const a = document.createElement('a')
              a.href = URL.createObjectURL(new Blob([JSON.stringify(r.package, null, 2)], { type: 'application/json' }))
              a.download = `handoff-v${p.version}.json`
              a.click()
              URL.revokeObjectURL(a.href)
              toast('Deal handed over · marked won')
              onChange()
            } catch (e) { toast((e as Error).message, true) }
          }}>Hand over to delivery</button>
        </div>
      )}
      {p.status === 'generating' ? <Spinner label="The proposal agent is writing" /> : (
        <details open={!final}>
          <summary className="small muted">Document · price book v{p.priceBookVersion} · requirements v{p.requirementsVersion || '—'}{p.expiresAt ? ` · valid until ${new Date(p.expiresAt).toLocaleDateString()}` : ''}</summary>
          <pre className="body" style={{ marginTop: 10 }}>{p.body}</pre>
        </details>
      )}
    </div>
  )
}

interface MeetingRow { _id: string; start: string; end: string; timezone: string; status: string; meetLink?: string; inviteProspect: boolean }

// book from real free slots only; the prospect is invited only when you tick it
function MeetingsCard({ leadId }: { leadId: string }) {
  const toast = useToast()
  const [invite, setInvite] = useState(true)
  const [busy, setBusy] = useState(false)
  const { data, reload } = useLoad(async () => {
    const meetings = (await api<{ meetings: MeetingRow[] }>(`/v1/calendar/events?leadId=${leadId}`)).meetings
    const av = await api<{ timezone: string; slots: { start: string; label: string }[] }>('/v1/calendar/availability?days=7').catch(() => null)
    return { meetings, av }
  }, [leadId])
  if (!data) return null
  if (!data.av && !data.meetings.length) return null
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); toast(ok); reload() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) } }
  const live = data.meetings.filter((m) => ['booked', 'rescheduled'].includes(m.status))
  return (
    <section className="card stack">
      <div className="row-flex between"><span className="h2">Meetings</span><label className="check small"><input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} /> Send the prospect a calendar invite</label></div>
      {live.map((m) => (
        <div key={m._id} className="row-flex between small">
          <span><Badge status="approved">{m.status}</Badge> {new Date(m.start).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}{m.meetLink && <> · <a href={m.meetLink} target="_blank" rel="noreferrer noopener">Meet link ↗</a></>}</span>
          <button className="linkish" style={{ color: 'var(--bad)' }} disabled={busy} onClick={() => run(() => api(`/v1/calendar/events/${m._id}`, { method: 'DELETE' }), 'Cancelled')}>Cancel</button>
        </div>
      ))}
      {data.av && <div className="chips">{data.av.slots.slice(0, 8).map((s) => (
        <button key={s.start} className="badge plain" style={{ cursor: 'pointer' }} disabled={busy} onClick={() => run(() => api('/v1/calendar/events', { body: { leadId, start: s.start, inviteProspect: invite } }), 'Booked')}>{s.label.replace(/ \(.+\)$/, '')}</button>
      ))}</div>}
      {data.av && <span className="small muted">Free times in {data.av.timezone}. Each is re-checked against your calendar when you click.</span>}
    </section>
  )
}

function OpportunityTimeline({ leadId }: { leadId: string }) {
  const { data } = useLoad(() => api<{ events: AuditEvent[] }>(`/v1/opportunities/${leadId}/timeline`), [leadId])
  if (!data?.events.length) return null
  return (
    <details className="card">
      <summary className="h3">Opportunity timeline</summary>
      <div className="stack sm" style={{ marginTop: 10 }}>
        {data.events.map((e) => <div key={e._id} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}><span>{human(e.action)}</span><span className="row-flex"><Badge status={e.decision ?? e.outcome} /><span className="muted">{ago(e.createdAt)}</span></span></div>)}
      </div>
    </details>
  )
}

// requirements → demo → proposal versions for one opportunity (the lead)
export default function OpportunityWorkspace({ leadId }: { leadId: string }) {
  const [showBuilder, setShowBuilder] = useState(false)
  const { data, reload } = useLoad(
    () => api<Workspace>(`/v1/opportunities/${leadId}`),
    [leadId],
    (d) => d.prototypes.some((p) => BUSY_PROTO.includes(p.status) && !p.approvalId) || d.proposals.some((p) => p.status === 'generating'),
  )
  if (!data) return <Spinner label="Loading opportunity" />
  const ready = data.prototypes.filter((p) => p.status === 'ready')

  return (
    <div className="stack lg">
      <RequirementsCard leadId={leadId} doc={data.requirements} versions={data.requirementVersions} onChange={reload} />
      <PrototypesCard leadId={leadId} ws={data} onChange={reload} />
      <section className="stack">
        <div className="row-flex between"><span className="h2">Proposals</span><button className="btn ghost sm" onClick={() => setShowBuilder(!showBuilder)}>{showBuilder ? 'Close' : 'New proposal'}</button></div>
        {showBuilder && <div className="card"><ProposalBuilder leadId={leadId} ready={ready} onCreated={() => { setShowBuilder(false); reload() }} /></div>}
        {data.proposals.length === 0 && !showBuilder && <p className="small muted" style={{ margin: 0 }}>No proposals yet. Prices, tax and payment schedule come from your configuration; the agent writes scope and narrative. Every revision is a new version.</p>}
        {data.proposals.map((p) => <ProposalCard key={p._id} p={p} onChange={reload} />)}
      </section>
      <MeetingsCard leadId={leadId} />
      <OpportunityTimeline leadId={leadId} />
    </div>
  )
}
