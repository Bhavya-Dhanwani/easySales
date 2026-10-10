import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import Papa from 'papaparse'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import { STAGES, type Lead } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

const CONSENT = [
  ['legitimate_interest', 'Legitimate interest (B2B)'],
  ['opt_in', 'Opted in'],
  ['existing_customer', 'Existing customer'],
  ['none', 'No basis recorded'],
] as const

// maps loose CSV headers onto the import fields
const HEADER_MAP: Record<string, string> = {
  company: 'companyName', companyname: 'companyName', 'company name': 'companyName', organization: 'companyName', business: 'companyName',
  website: 'website', url: 'website', domain: 'website', site: 'website',
  industry: 'industry', size: 'size', 'company size': 'size', country: 'country', location: 'country',
  name: 'contactName', contact: 'contactName', 'contact name': 'contactName', 'full name': 'contactName', 'first name': 'contactName',
  title: 'contactTitle', role: 'contactTitle', 'job title': 'contactTitle', position: 'contactTitle',
  email: 'contactEmail', 'email address': 'contactEmail', 'contact email': 'contactEmail', 'work email': 'contactEmail',
  phone: 'contactPhone', mobile: 'contactPhone', consent: 'consentBasis',
}

function AddLead({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [mode, setMode] = useState<'one' | 'csv'>('one')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ companyName: '', website: '', industry: '', country: '', contactName: '', contactTitle: '', contactEmail: '', consentBasis: 'legitimate_interest' })
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([])
  const [csvConsent, setCsvConsent] = useState('legitimate_interest')
  const [result, setResult] = useState<{ created: number; duplicates: unknown[]; invalid: { row: number; error: string }[] } | null>(null)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })

  async function addOne(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/v1/leads', { body: form })
      toast('Lead added')
      onDone()
    } catch (err) { toast((err as Error).message, true) } finally { setBusy(false) }
  }

  function parse(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => HEADER_MAP[h.trim().toLowerCase()] ?? h.trim(),
      complete: (r) => setCsvRows(r.data.slice(0, 500)),
      error: (err) => toast(err.message, true),
    })
  }

  async function importCsv() {
    setBusy(true)
    try {
      const leads = csvRows.map((r) => ({
        companyName: r.companyName ?? '', website: r.website, industry: r.industry, size: r.size, country: r.country,
        contactName: r.contactName, contactTitle: r.contactTitle, contactEmail: r.contactEmail, contactPhone: r.contactPhone,
        consentBasis: CONSENT.some(([v]) => v === r.consentBasis) ? r.consentBasis : csvConsent,
      }))
      const res = await api<{ created: number; duplicates: unknown[]; invalid: { row: number; error: string }[] }>('/v1/leads/import', { body: { leads } })
      setResult(res)
      toast(`${res.created} leads imported`)
      if (res.created) onDone()
    } catch (err) { toast((err as Error).message, true) } finally { setBusy(false) }
  }

  return (
    <div className="card fade-in">
      <div className="tabs" style={{ marginTop: -8 }}>
        <button className={mode === 'one' ? 'active' : ''} onClick={() => setMode('one')}>One lead</button>
        <button className={mode === 'csv' ? 'active' : ''} onClick={() => setMode('csv')}>CSV import</button>
      </div>
      {mode === 'one' ? (
        <form className="stack" onSubmit={addOne}>
          <div className="grid-3">
            <label className="field"><span>Company *</span><input className="input" required value={form.companyName} onChange={set('companyName')} /></label>
            <label className="field"><span>Website</span><input className="input" placeholder="acme.com" value={form.website} onChange={set('website')} /></label>
            <label className="field"><span>Industry</span><input className="input" value={form.industry} onChange={set('industry')} /></label>
            <label className="field"><span>Contact name</span><input className="input" value={form.contactName} onChange={set('contactName')} /></label>
            <label className="field"><span>Title</span><input className="input" value={form.contactTitle} onChange={set('contactTitle')} /></label>
            <label className="field"><span>Email</span><input className="input" type="email" value={form.contactEmail} onChange={set('contactEmail')} /></label>
            <label className="field"><span>Country</span><input className="input" value={form.country} onChange={set('country')} /></label>
            <label className="field"><span>Consent basis</span>
              <select className="select" value={form.consentBasis} onChange={set('consentBasis')}>{CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
          </div>
          <div><button className="btn" disabled={busy}>Add lead</button></div>
        </form>
      ) : (
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>Columns like <span className="mono">company, website, name, title, email, country, industry</span> are recognised automatically. Up to 500 rows; duplicates are skipped.</p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && parse(e.target.files[0])} />
          {csvRows.length > 0 && (
            <>
              <div className="row-flex">
                <span className="badge accent">{csvRows.length} rows</span>
                <label className="field" style={{ minWidth: 260 }}><span>Default consent basis</span>
                  <select className="select" value={csvConsent} onChange={(e) => setCsvConsent(e.target.value)}>{CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
              </div>
              <div className="table-wrap"><table className="table"><thead><tr><th>Company</th><th>Contact</th><th>Email</th><th>Website</th></tr></thead>
                <tbody>{csvRows.slice(0, 5).map((r, i) => <tr key={i}><td>{r.companyName}</td><td>{r.contactName}</td><td className="mono">{r.contactEmail}</td><td className="mono">{r.website}</td></tr>)}</tbody></table></div>
              <div><button className="btn" disabled={busy} onClick={importCsv}>{busy ? 'Importing…' : `Import ${csvRows.length} leads`}</button></div>
            </>
          )}
          {result && (
            <div className="small">
              <b>{result.created}</b> created · {result.duplicates.length} duplicates skipped · {result.invalid.length} invalid
              {result.invalid.slice(0, 5).map((i) => <div key={i.row} className="form-error">Row {i.row}: {i.error}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Leads() {
  const { org } = useAuth()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const stage = params.get('stage') ?? ''
  const adding = params.get('add') === '1'

  const { data, loading, reload } = useLoad(
    () => api<{ leads: Lead[]; nextCursor: string | null }>(`/v1/leads?limit=100${stage ? `&stage=${stage}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    [org?.id, stage, q],
  )

  const update = (k: string, v: string | null) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v); else next.delete(k)
    setParams(next, { replace: true })
  }

  return (
    <div className="stack lg fade-in">
      <PageHead index="02 / Leads" title={<>Every prospect, <span className="serif">one place.</span></>}>
        <button className="btn" onClick={() => update('add', adding ? null : '1')}>{adding ? 'Close' : 'Add leads'}</button>
      </PageHead>

      {adding && <AddLead onDone={() => { reload(); update('add', null) }} />}

      <div className="row-flex between">
        <div className="tabs" style={{ marginBottom: 0, border: 0 }}>
          <button className={!stage ? 'active' : ''} onClick={() => update('stage', null)}>All</button>
          {STAGES.map((s) => <button key={s} className={stage === s ? 'active' : ''} onClick={() => update('stage', s)}>{s}</button>)}
        </div>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search company, contact, email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search leads" />
      </div>

      {loading ? <Spinner label="Loading leads" /> : !data?.leads.length ? (
        <Empty title={stage || q ? 'No matches.' : 'No leads yet.'} action={!stage && !q && <button className="btn" onClick={() => update('add', '1')}>Add your first lead</button>}>
          {stage || q ? 'Try another filter.' : 'Add a lead by hand or import a CSV. The agents take it from there.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Company</th><th>Contact</th><th>Fit</th><th>Qualification</th><th>Outreach</th><th>Stage</th><th>Updated</th></tr></thead>
            <tbody>
              {data.leads.map((l) => (
                <tr key={l._id} className="row" onClick={() => nav(`/app/leads/${l._id}`)}>
                  <td><Link to={`/app/leads/${l._id}`} style={{ textDecoration: 'none', fontWeight: 600 }}>{l.company.name}</Link><div className="small muted">{l.company.domain}</div></td>
                  <td>{l.contact?.name ?? '—'}<div className="small muted mono">{l.contact?.email}</div></td>
                  <td className="mono">{l.qualification?.score ?? '—'}</td>
                  <td><Badge status={l.qualification?.status} /></td>
                  <td><Badge status={l.outreachStatus} /></td>
                  <td><Badge status={l.opportunityStage} /></td>
                  <td className="small muted">{ago(l.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
