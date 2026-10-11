import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../lib/api'
import { money } from '../lib/format'
import { Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { CONSENT } from './Leads'

interface Source { id: string; label: string; enabled: boolean; paid: boolean }
interface Candidate { name: string; website?: string; domain?: string; email?: string; phone?: string; address?: string; country?: string; industry?: string; employeeCount?: number; sources: string[]; alreadyLead?: boolean }
interface Result { candidates: Candidate[]; queries: { what: string; where: string }[]; disqualified: number; sources: { source: string; ok: boolean; count: number; error?: string }[]; costMinor: number; currency: string }

const KEY_HINT: Record<string, string> = { google_places: 'GOOGLE_PLACES_API_KEY', apollo: 'APOLLO_API_KEY', web_search: 'BRAVE_SEARCH_API_KEY', openstreetmap: 'DISCOVERY_OSM=true' }

// search several lead sources at once, pick the businesses worth contacting, import them into research
export default function FindLeads() {
  const nav = useNavigate()
  const toast = useToast()
  const { data: meta } = useLoad(() => api<{ sources: Source[]; niche: { searchTerms: string[]; searchAreas: string[] } }>('/v1/leads/discover/sources'), [])
  const sources = meta?.sources
  const [form, setForm] = useState({ what: '', where: '' })
  const [use, setUse] = useState<string[] | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [consent, setConsent] = useState('')
  const [research, setResearch] = useState(true)
  const [busy, setBusy] = useState(false)

  const enabled = (sources ?? []).filter((s) => s.enabled).map((s) => s.id)
  const chosen = use ?? enabled
  const keyOf = (c: Candidate) => c.domain ?? c.name

  async function search(e: FormEvent | null, auto = false) {
    e?.preventDefault()
    setBusy(true)
    try {
      const r = await api<Result>('/v1/leads/discover', { body: auto ? { auto: true, sources: chosen } : { ...form, sources: chosen } })
      setResult(r)
      setPicked(r.candidates.filter((c) => !c.alreadyLead).map(keyOf))
    } catch (err) { toast((err as Error).message, true) } finally { setBusy(false) }
  }

  async function importPicked() {
    if (!result || !consent) return
    setBusy(true)
    try {
      const rows = result.candidates.filter((c) => picked.includes(keyOf(c))).map((c) => ({
        companyName: c.name, website: c.website ?? '', contactEmail: c.email ?? '', contactPhone: c.phone, industry: c.industry, country: c.country,
        employeeCount: c.employeeCount ?? '', description: c.address ? `Address: ${c.address}` : undefined,
        consentBasis: consent, consentSource: `Found via ${c.sources.join(', ')} search: ${label}`,
      }))
      const r = await api<{ job: { createdRows: number; duplicateRows: number; invalidRows: number } }>('/v1/leads/import', { body: { fileName: `Search: ${label}`, rows, source: 'discovery', research } })
      toast(`${r.job.createdRows} leads added${r.job.duplicateRows ? `, ${r.job.duplicateRows} already existed` : ''}${research ? ' and queued for research' : ''}`)
      nav('/app/leads')
    } catch (err) { toast((err as Error).message, true) } finally { setBusy(false) }
  }

  const fresh = result?.candidates.filter((c) => !c.alreadyLead) ?? []
  const label = result?.queries.map((q) => `${q.what} in ${q.where}`).join('; ') ?? ''
  const niche = meta?.niche
  const noNiche = niche && (!niche.searchTerms.length || !niche.searchAreas.length)

  return (
    <div className="stack lg fade-in">
      <PageHead index="Lead pipeline" title={<>Find <span className="hl">new leads.</span></>}>
        <Link className="btn ghost" to="/app/leads">Back to leads</Link>
      </PageHead>

      {noNiche && (
        <Empty title="Set your niche first." action={<Link className="btn lime" to="/app/business#icp">Add search terms & areas</Link>}>
          Lead search only runs inside your niche: add the kinds of business to look for and the places, under Ideal customer profile.
        </Empty>
      )}

      {niche && !noNiche && <form className="card stack" onSubmit={(e) => search(e)}>
        <div className="grid-4">
          <label className="field" style={{ gridColumn: 'span 2' }}><span>What kind of business *</span>
            <select className="select" required value={form.what} onChange={(e) => setForm({ ...form, what: e.target.value })}>
              <option value="" disabled>Choose from your niche</option>
              {niche.searchTerms.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}><span>Where *</span>
            <select className="select" required value={form.where} onChange={(e) => setForm({ ...form, where: e.target.value })}>
              <option value="" disabled>Choose an area</option>
              {niche.searchAreas.map((a) => <option key={a}>{a}</option>)}
            </select>
          </label>
        </div>
        <fieldset className="row-flex" style={{ border: 0, padding: 0, margin: 0, flexWrap: 'wrap' }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>Search in</legend>
          {!sources ? <Spinner label="Loading sources" /> : sources.map((s) => (
            <label key={s.id} className="row-flex small" style={{ gap: 6, opacity: s.enabled ? 1 : 0.55 }} title={s.enabled ? undefined : `Set ${KEY_HINT[s.id]} on the server to enable`}>
              <input type="checkbox" disabled={!s.enabled} checked={chosen.includes(s.id)} onChange={(e) => setUse(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))} />
              {s.label} <span className="muted">{s.enabled ? (s.paid ? 'paid' : 'free') : 'needs API key'}</span>
            </label>
          ))}
        </fieldset>
        <div className="row-flex">
          <button className="btn lime" disabled={busy || !chosen.length}>{busy ? 'Searching…' : 'Search'}</button>
          <button type="button" className="btn ghost" disabled={busy || !chosen.length} onClick={() => search(null, true)} title="The agent picks the next term and area pairs you haven't searched lately">Search my whole niche</button>
          <Link className="small muted" to="/app/business#icp">Edit niche</Link>
        </div>
      </form>}

      {result && (
        <>
          <div className="row-flex small" style={{ flexWrap: 'wrap' }}>
            {result.sources.map((s) => (
              <span key={s.source} className={`badge ${s.ok ? 'ok' : 'bad'} plain`} title={s.error}>{sources?.find((x) => x.id === s.source)?.label ?? s.source}: {s.ok ? s.count : 'failed'}</span>
            ))}
            <span className="muted">Searched {label} · cost {money(result.costMinor, result.currency)}{result.disqualified ? ` · ${result.disqualified} removed by your disqualifiers` : ''}</span>
          </div>

          {!result.candidates.length ? <Empty title="No businesses found.">Try a broader description or a bigger area.</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all" checked={fresh.length > 0 && fresh.every((c) => picked.includes(keyOf(c)))} onChange={(e) => setPicked(e.target.checked ? fresh.map(keyOf) : [])} /></th>
                  <th>Business</th><th>Contact</th><th>Found in</th>
                </tr></thead>
                <tbody>
                  {result.candidates.map((c) => (
                    <tr key={keyOf(c)} className={`row ${picked.includes(keyOf(c)) ? 'selected' : ''}`}>
                      <td><input type="checkbox" aria-label={`Select ${c.name}`} disabled={c.alreadyLead} checked={picked.includes(keyOf(c))} onChange={(e) => setPicked(e.target.checked ? [...picked, keyOf(c)] : picked.filter((k) => k !== keyOf(c)))} /></td>
                      <td><b>{c.name}</b>{c.alreadyLead && <span className="badge plain" style={{ marginLeft: 6 }}>already a lead</span>}
                        <div className="small muted">{[c.industry, c.address].filter(Boolean).join(' · ')}</div></td>
                      <td className="small">{c.website ? <a href={c.website} target="_blank" rel="noopener noreferrer nofollow">{c.domain}</a> : <span className="muted">no website</span>}
                        <div className="muted">{c.email ?? (c.website ? 'email found during research' : 'no email')}{c.phone ? ` · ${c.phone}` : ''}</div></td>
                      <td className="small muted">{c.sources.map((s) => sources?.find((x) => x.id === s)?.label ?? s).join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {picked.length > 0 && (
            <div className="card stack">
              <div className="h2">Add {picked.length} lead{picked.length === 1 ? '' : 's'}</div>
              <label className="field"><span>Why may you contact them? *</span>
                <select className="select" required value={consent} onChange={(e) => setConsent(e.target.value)}>
                  <option value="" disabled>Choose a basis</option>
                  {CONSENT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <p className="small muted" style={{ margin: 0 }}>These businesses haven't opted in. Contact them only where the law allows it (for example legitimate interest for business contacts), and every email includes an opt-out. Leads with no basis are never emailed.</p>
              <label className="row-flex small" style={{ gap: 6 }}><input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} /> Research them right away (reads their website, scores fit and finds a public contact email)</label>
              <div><button className="btn lime" disabled={busy || !consent} onClick={importPicked}>Add to leads</button></div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
