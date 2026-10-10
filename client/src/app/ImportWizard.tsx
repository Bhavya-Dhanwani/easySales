import { useState } from 'react'
import { Link } from 'react-router'
import Papa from 'papaparse'
import { api, download, idempotencyKey } from '../lib/api'
import { ago } from '../lib/format'
import type { ImportJob } from '../lib/types'
import { Badge, PageHead, useLoad, useToast } from '../components/ui'
import { CONSENT } from './Leads'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_ROWS = 2000

const FIELDS = [
  ['companyName', 'Company *', ['company', 'company name', 'companyname', 'organization', 'business', 'account']],
  ['website', 'Website', ['website', 'url', 'domain', 'site', 'web']],
  ['industry', 'Industry', ['industry', 'sector', 'vertical']],
  ['employeeCount', 'Employees', ['employees', 'employee count', 'headcount', 'company size', 'size']],
  ['country', 'Country', ['country', 'location', 'region']],
  ['contactName', 'Contact name', ['name', 'contact', 'contact name', 'full name', 'first name']],
  ['contactTitle', 'Title', ['title', 'role', 'job title', 'position', 'designation']],
  ['contactEmail', 'Email', ['email', 'email address', 'work email', 'contact email', 'e-mail']],
  ['contactPhone', 'Phone', ['phone', 'mobile', 'phone number', 'contact number']],
  ['description', 'Description', ['description', 'about', 'notes']],
] as const

type Field = (typeof FIELDS)[number][0]

function guessMapping(headers: string[]) {
  const map: Partial<Record<Field, string>> = {}
  for (const [field, , aliases] of FIELDS) {
    const hit = headers.find((h) => (aliases as readonly string[]).includes(h.trim().toLowerCase()))
    if (hit) map[field] = hit
  }
  return map
}

export default function ImportWizard() {
  const toast = useToast()
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState<string[]>([])
  const [raw, setRaw] = useState<Record<string, string>[]>([])
  const [mapping, setMapping] = useState<Partial<Record<Field, string>>>({})
  const [consent, setConsent] = useState('legitimate_interest')
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [result, setResult] = useState<ImportJob | null>(null)
  const [key] = useState(idempotencyKey)
  const history = useLoad(() => api<{ imports: ImportJob[] }>('/v1/imports'), [result?._id])

  function load(file: File) {
    if (file.size > MAX_BYTES) return toast('File is larger than 5 MB', true)
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      complete: (r) => {
        const fields = (r.meta.fields ?? []).filter(Boolean)
        if (!fields.length) return toast('No header row found', true)
        if (r.data.length > MAX_ROWS) toast(`Only the first ${MAX_ROWS} rows will be imported`)
        setFileName(file.name)
        setHeaders(fields)
        setRaw(r.data.slice(0, MAX_ROWS))
        setMapping(guessMapping(fields))
        setStep(2)
      },
      error: (err) => toast(err.message, true),
    })
  }

  const rows = raw.map((r) => {
    const out: Record<string, string> = { consentBasis: consent }
    for (const [field] of FIELDS) {
      const col = mapping[field]
      if (col) out[field] = (r[col] ?? '').trim()
    }
    return out
  })
  const missingCompany = rows.filter((r) => !r.companyName).length

  async function submit() {
    setBusy(true)
    try {
      const r = await api<{ job: ImportJob }>('/v1/leads/import', { body: { fileName, rows }, headers: { 'Idempotency-Key': key } })
      setResult(r.job)
      setStep(4)
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  const steps = ['Upload', 'Map columns', 'Preview', 'Done']

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 1040 }}>
      <PageHead index="Import wizard" title={<>Bring your <span className="hl">leads.</span></>}>
        <Link className="btn ghost" to="/app/leads">Back to pipeline</Link>
      </PageHead>
      <div className="wizard-steps">{steps.map((s, i) => <span key={s} className={i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}>{i + 1 < step ? '✓' : i + 1} {s}</span>)}</div>

      {step === 1 && (
        <label className={`dropzone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) load(f) }}>
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
          <div className="h2">Drop a CSV here, or click to choose</div>
          <p className="muted" style={{ margin: '8px 0 0' }}>Up to 5 MB and {MAX_ROWS} rows. Duplicates are skipped, and spreadsheet formulas are neutralised.</p>
        </label>
      )}

      {step === 2 && (
        <div className="card stack">
          <div className="row-flex between"><div className="h2">Map columns</div><span className="badge accent">{fileName} · {raw.length} rows</span></div>
          <div className="grid-3">
            {FIELDS.map(([field, label]) => (
              <label key={field} className="field"><span>{label}</span>
                <select className="select" value={mapping[field] ?? ''} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value || undefined })}>
                  <option value="">— not imported —</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
            <label className="field"><span>Consent basis for these contacts</span>
              <select className="select" value={consent} onChange={(e) => setConsent(e.target.value)}>{CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
          </div>
          <div className="row-flex"><button className="btn ghost" onClick={() => setStep(1)}>Back</button><button className="btn" disabled={!mapping.companyName} onClick={() => setStep(3)}>Preview</button></div>
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          <div className="row-flex">
            <span className="badge accent">{rows.length} rows</span>
            {missingCompany > 0 && <span className="badge bad">{missingCompany} without a company (will be reported)</span>}
            <span className="small muted">Duplicates (same email, domain or name) are detected on import, against your existing leads too.</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Company</th><th>Website</th><th>Contact</th><th>Email</th><th>Industry</th><th>Country</th></tr></thead>
              <tbody>{rows.slice(0, 10).map((r, i) => (
                <tr key={i}><td className="muted">{i + 1}</td><td>{r.companyName || <span className="form-error">missing</span>}</td><td className="mono">{r.website}</td><td>{r.contactName}</td><td className="mono">{r.contactEmail}</td><td>{r.industry}</td><td>{r.country}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {rows.length > 10 && <span className="small muted">Showing the first 10 of {rows.length}.</span>}
          <div className="row-flex"><button className="btn ghost" onClick={() => setStep(2)}>Back</button><button className="btn lime" disabled={busy} onClick={submit}>{busy ? 'Importing…' : `Import ${rows.length} rows`}</button></div>
        </div>
      )}

      {step === 4 && result && (
        <div className="card stack">
          <div className="row-flex between"><div className="h2">Import finished</div><Badge status={result.status} /></div>
          <div className="grid-4">
            <div><div className="label">Rows</div><div className="num" style={{ fontSize: 30 }}>{result.totalRows}</div></div>
            <div><div className="label">Created</div><div className="num" style={{ fontSize: 30, color: 'var(--ok)' }}>{result.createdRows}</div></div>
            <div><div className="label">Duplicates</div><div className="num" style={{ fontSize: 30, color: 'var(--warn)' }}>{result.duplicateRows}</div></div>
            <div><div className="label">Invalid</div><div className="num" style={{ fontSize: 30, color: 'var(--bad)' }}>{result.invalidRows}</div></div>
          </div>
          <div className="row-flex">
            <Link className="btn lime" to="/app/leads?status=new">Research the new leads</Link>
            {(result.duplicateRows > 0 || result.invalidRows > 0) && <button className="btn ghost" onClick={() => downloadReport(result._id)}>Download error report</button>}
            <button className="btn ghost" onClick={() => { setStep(1); setResult(null) }}>Import another file</button>
          </div>
        </div>
      )}

      {!!history.data?.imports.length && (
        <section className="stack">
          <div className="h2">Recent imports</div>
          <div className="table-wrap"><table className="table"><thead><tr><th>File</th><th>Status</th><th>Created</th><th>Duplicates</th><th>Invalid</th><th>When</th><th /></tr></thead>
            <tbody>{history.data.imports.map((i) => (
              <tr key={i._id}><td>{i.fileName ?? 'Upload'}</td><td><Badge status={i.status} /></td><td>{i.createdRows}</td><td>{i.duplicateRows}</td><td>{i.invalidRows}</td><td className="small muted">{ago(i.createdAt)}</td>
                <td>{(i.duplicateRows + i.invalidRows) > 0 && <button className="linkish" onClick={() => downloadReport(i._id)}>Error report</button>}</td></tr>
            ))}</tbody></table></div>
        </section>
      )}
    </div>
  )
}

const downloadReport = (id: string) => download(`/v1/imports/${id}/errors.csv`, `import-${id}-errors.csv`)
