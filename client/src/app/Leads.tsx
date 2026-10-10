import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { api } from '../lib/api'
import { ago, human } from '../lib/format'
import { LEAD_STATUSES, type Lead } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

export const CONSENT = [
  ['legitimate_interest', 'Legitimate interest (B2B)'],
  ['opt_in', 'Opted in'],
  ['existing_customer', 'Existing customer'],
  ['none', 'No basis recorded'],
] as const

interface Summary { total: number; counts: Record<string, number>; averageScore: number | null; averageEvidenceCoverage: number | null; qualifiedRate: number }
interface Estimate { requested: number; eligible: number; estimatedAiCalls: number; estimatedTokens: number | null; dailyBudget: number }

function AddLead({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ companyName: '', website: '', industry: '', country: '', contactName: '', contactTitle: '', contactEmail: '', consentBasis: 'legitimate_interest' })
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/v1/leads', { body: form })
      toast('Lead added')
      onDone()
    } catch (err) { toast((err as Error).message, true) } finally { setBusy(false) }
  }
  return (
    <form className="card stack fade-in" onSubmit={submit}>
      <div className="h2">Add a lead</div>
      <div className="grid-4">
        <label className="field"><span>Company *</span><input className="input" required value={form.companyName} onChange={set('companyName')} /></label>
        <label className="field"><span>Website</span><input className="input" placeholder="acme.com" value={form.website} onChange={set('website')} /></label>
        <label className="field"><span>Industry</span><input className="input" value={form.industry} onChange={set('industry')} /></label>
        <label className="field"><span>Country</span><input className="input" value={form.country} onChange={set('country')} /></label>
        <label className="field"><span>Contact name</span><input className="input" value={form.contactName} onChange={set('contactName')} /></label>
        <label className="field"><span>Title</span><input className="input" value={form.contactTitle} onChange={set('contactTitle')} /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={form.contactEmail} onChange={set('contactEmail')} /></label>
        <label className="field"><span>Consent basis</span>
          <select className="select" value={form.consentBasis} onChange={set('consentBasis')}>{CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
      </div>
      <div><button className="btn" disabled={busy}>Add lead</button></div>
    </form>
  )
}

export function FitCell({ score, coverage }: { score?: number; coverage?: number }) {
  if (score === undefined) return <span className="muted">—</span>
  return (
    <div style={{ minWidth: 110 }}>
      <div className="row-flex between" style={{ gap: 6 }}><b className="num" style={{ fontSize: 17 }}>{score}</b><span className="small muted">{coverage ?? 0}% evidence</span></div>
      <div className="meter" style={{ height: 6 }}><i style={{ width: `${score}%` }} /></div>
    </div>
  )
}

export default function Leads() {
  const { org } = useAuth()
  const nav = useNavigate()
  const toast = useToast()
  // filters live in the URL so they survive going to a lead and back
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string[]>([])
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const f = (k: string) => params.get(k) ?? ''
  const adding = f('add') === '1'
  const query = ['status', 'industry', 'country', 'minScore', 'q'].filter((k) => f(k)).map((k) => `&${k}=${encodeURIComponent(f(k))}`).join('')

  const { data, loading, reload } = useLoad(async () => {
    const [list, summary] = await Promise.all([
      api<{ leads: Lead[]; nextCursor: string | null }>(`/v1/leads?limit=100${query}`),
      api<Summary>('/v1/pipeline/summary'),
    ])
    return { ...list, summary }
  }, [org?.id, query], (d) => d.leads.some((l) => l.status === 'research_queued' || l.status === 'researching'))

  const update = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v); else next.delete(k)
    setParams(next, { replace: true })
  }

  const leads = data?.leads ?? []
  const allSelected = leads.length > 0 && leads.every((l) => selected.includes(l._id))

  async function openBulk() {
    try {
      setEstimate(await api<Estimate>('/v1/leads/bulk-research', { body: { leadIds: selected, dryRun: true } }))
      dialog.current?.showModal()
    } catch (e) { toast((e as Error).message, true) }
  }

  async function confirmBulk() {
    try {
      const r = await api<{ queued: number; skipped: number }>('/v1/leads/bulk-research', { body: { leadIds: selected } })
      toast(`${r.queued} research jobs queued${r.skipped ? `, ${r.skipped} skipped` : ''}`)
      dialog.current?.close()
      setSelected([])
      reload()
    } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <div className="stack lg fade-in">
      <PageHead index="Lead pipeline" title={<>Every prospect, <span className="hl">one place.</span></>}>
        <Link className="btn ghost" to="/app/research">Research activity</Link>
        <Link className="btn ghost" to="/app/leads/import">Import CSV</Link>
        <button className="btn" onClick={() => update('add', adding ? null : '1')}>{adding ? 'Close' : 'Add lead'}</button>
      </PageHead>

      {adding && <AddLead onDone={() => { reload(); update('add', null) }} />}

      {data?.summary && (
        <div className="status-tabs" role="tablist" aria-label="Filter by status">
          <button className={`status-tab ${!f('status') ? 'active' : ''}`} onClick={() => update('status', null)}>All <b>{data.summary.total}</b></button>
          {LEAD_STATUSES.map((s) => (
            <button key={s} className={`status-tab ${f('status') === s ? 'active' : ''}`} onClick={() => update('status', s)}>{human(s)} <b>{data.summary.counts[s] ?? 0}</b></button>
          ))}
        </div>
      )}

      <div className="row-flex">
        <input className="input" style={{ flex: 2, minWidth: 200 }} placeholder="Search company, contact or email" defaultValue={f('q')} onChange={(e) => update('q', e.target.value || null)} aria-label="Search" />
        <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Industry" defaultValue={f('industry')} onBlur={(e) => update('industry', e.target.value || null)} aria-label="Industry" />
        <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Country" defaultValue={f('country')} onBlur={(e) => update('country', e.target.value || null)} aria-label="Country" />
        <select className="select" style={{ flex: 1, minWidth: 140 }} value={f('minScore')} onChange={(e) => update('minScore', e.target.value || null)} aria-label="Minimum fit score">
          <option value="">Any fit score</option>
          {[50, 70, 85].map((n) => <option key={n} value={n}>Fit ≥ {n}</option>)}
        </select>
      </div>

      {loading ? <Spinner label="Loading leads" /> : !leads.length ? (
        <Empty title={query ? 'No matches.' : 'No leads yet.'} action={!query && <Link className="btn lime" to="/app/leads/import">Import your first CSV</Link>}>
          {query ? 'Try another filter.' : 'Import a CSV or add a lead by hand. Research and scoring take it from there.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? leads.map((l) => l._id) : [])} /></th>
              <th>Company</th><th>Industry</th><th>Fit</th><th>Status</th><th>Stage</th><th>Last activity</th>
            </tr></thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l._id} className={`row ${selected.includes(l._id) ? 'selected' : ''}`} onClick={() => nav(`/app/leads/${l._id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${l.company.name}`} checked={selected.includes(l._id)} onChange={(e) => setSelected(e.target.checked ? [...selected, l._id] : selected.filter((id) => id !== l._id))} />
                  </td>
                  <td><Link to={`/app/leads/${l._id}`} style={{ textDecoration: 'none', fontWeight: 600 }}>{l.company.name}</Link><div className="small muted">{l.contact?.name ?? l.company.domain}</div></td>
                  <td className="small">{l.company.industry ?? <span className="muted">—</span>}<div className="muted">{l.company.country}</div></td>
                  <td><FitCell score={l.qualification?.score} coverage={l.qualification?.evidenceCoverage} /></td>
                  <td>{l.status === 'researching' ? <span className="row-flex small" style={{ gap: 6 }}><span className="spinner" /> researching</span> : <Badge status={l.status} />}</td>
                  <td><Badge status={l.opportunityStage} /></td>
                  <td className="small muted">{ago(l.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected.length > 0 && (
        <div className="selection-bar">
          <span><b>{selected.length}</b> selected</span>
          <button className="btn sm lime" onClick={openBulk}>Research selected</button>
          <button className="btn sm ghost" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      <dialog ref={dialog} className="modal" aria-labelledby="bulk-title">
        {estimate && (
          <div className="stack">
            <h2 id="bulk-title" className="h2">Research {estimate.eligible} lead{estimate.eligible === 1 ? '' : 's'}?</h2>
            <p className="muted" style={{ margin: 0 }}>Each lead uses one AI research call; scoring is calculated by code, so it's free.</p>
            <dl className="kv">
              <dt>Selected</dt><dd>{estimate.requested}</dd>
              <dt>Will run</dt><dd>{estimate.eligible} <span className="muted small">(already-queued leads are skipped)</span></dd>
              <dt>AI calls</dt><dd>{estimate.estimatedAiCalls} of {estimate.dailyBudget} daily budget</dd>
              <dt>Est. tokens</dt><dd>{estimate.estimatedTokens ? `≈ ${estimate.estimatedTokens.toLocaleString()}` : 'not enough history yet'}</dd>
            </dl>
            <div className="row-flex" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => dialog.current?.close()}>Cancel</button>
              <button className="btn lime" disabled={!estimate.eligible} onClick={confirmBulk}>Queue research</button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  )
}
