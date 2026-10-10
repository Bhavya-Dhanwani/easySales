import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api } from '../lib/api'
import { ago, human } from '../lib/format'
import { LEAD_STATUSES, type Campaign, type CampaignAnalytics, type Lead } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, Stat, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

type Form = { name: string; objective: string; statuses: string[]; minScore: number; industries: string; countries: string; delays: string; dailyLimit: number; autoSend: boolean }

const blank: Form = { name: '', objective: '', statuses: ['qualified'], minScore: 70, industries: '', countries: '', delays: '3, 4', dailyLimit: 20, autoSend: false }

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
const toBody = (f: Form) => ({
  name: f.name, objective: f.objective,
  audience: { statuses: f.statuses, minScore: f.minScore, industries: list(f.industries), countries: list(f.countries) },
  followUpDelaysDays: list(f.delays).map(Number).filter((n) => n > 0).slice(0, 5),
  dailyLimit: f.dailyLimit, autoSend: f.autoSend,
})
const fromCampaign = (c: Campaign): Form => ({
  name: c.name, objective: c.objective, statuses: c.audience.statuses, minScore: c.audience.minScore,
  industries: c.audience.industries.join(', '), countries: c.audience.countries.join(', '),
  delays: c.followUpDelaysDays.join(', '), dailyLimit: c.dailyLimit, autoSend: c.autoSend,
})

function CampaignForm({ initial, onSave, busy }: { initial: Form; onSave: (f: Form) => void; busy: boolean }) {
  const [f, setF] = useState(initial)
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v })
  return (
    <form className="card stack" onSubmit={(e: FormEvent) => { e.preventDefault(); onSave(f) }}>
      <div className="grid-2">
        <label className="field"><span>Name</span><input className="input" required minLength={2} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Clinics in Pune — Q4" /></label>
        <label className="field"><span>Objective (guides the writing)</span><input className="input" value={f.objective} onChange={(e) => set('objective', e.target.value)} placeholder="Book a 20-minute discovery call" /></label>
      </div>
      <div className="label">Audience</div>
      <div className="chips">
        {LEAD_STATUSES.filter((s) => !['research_queued', 'researching', 'research_failed'].includes(s)).map((s) => (
          <label key={s} className="check tag" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={f.statuses.includes(s)} onChange={(e) => set('statuses', e.target.checked ? [...f.statuses, s] : f.statuses.filter((x) => x !== s))} /> {human(s)}
          </label>
        ))}
      </div>
      <div className="grid-3">
        <label className="field"><span>Minimum fit score · {f.minScore}</span><input type="range" min={0} max={100} value={f.minScore} onChange={(e) => set('minScore', Number(e.target.value))} /></label>
        <label className="field"><span>Industries (comma separated)</span><input className="input" value={f.industries} onChange={(e) => set('industries', e.target.value)} placeholder="Healthcare, Education" /></label>
        <label className="field"><span>Countries</span><input className="input" value={f.countries} onChange={(e) => set('countries', e.target.value)} placeholder="India" /></label>
      </div>
      <div className="label">Sequence & limits</div>
      <div className="grid-3">
        <label className="field"><span>Follow-up gaps (business days)</span><input className="input" value={f.delays} onChange={(e) => set('delays', e.target.value)} /><small>“3, 4” = two follow-ups, 3 then 4 business days apart. Empty = none.</small></label>
        <label className="field"><span>New contacts per day</span><input className="input" type="number" min={1} max={1000} value={f.dailyLimit} onChange={(e) => set('dailyLimit', Number(e.target.value))} /></label>
        <label className="check" style={{ alignSelf: 'center' }}><input type="checkbox" checked={f.autoSend} onChange={(e) => set('autoSend', e.target.checked)} /><span><b>Send without approval</b><br /><span className="small muted">Only if your policy also allows automatic sending.</span></span></label>
      </div>
      <div><button className="btn" disabled={busy || !f.statuses.length}>{busy ? 'Saving…' : 'Save campaign'}</button></div>
    </form>
  )
}

export default function Campaigns() {
  const { org } = useAuth()
  const nav = useNavigate()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data, loading } = useLoad(() => api<{ campaigns: Campaign[] }>('/v1/campaigns'), [org?.id])

  async function create(f: Form) {
    setBusy(true)
    try {
      const r = await api<{ campaign: Campaign }>('/v1/campaigns', { body: toBody(f) })
      nav(`/app/campaigns/${r.campaign._id}`)
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  return (
    <div className="stack lg fade-in">
      <PageHead index="Campaigns" title={<>Outreach that <span className="hl">knows when to stop.</span></>}>
        <button className="btn" onClick={() => setCreating(!creating)}>{creating ? 'Close' : 'New campaign'}</button>
      </PageHead>
      {creating && <CampaignForm initial={blank} onSave={create} busy={busy} />}
      {loading ? <Spinner /> : !data?.campaigns.length ? (
        !creating && <Empty title="No campaigns yet." action={<button className="btn lime" onClick={() => setCreating(true)}>Create your first campaign</button>}>A campaign picks qualified leads, writes to them within your daily limit and follows up on a cadence until they reply.</Empty>
      ) : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th>Enrolled</th><th>Per day</th><th>Mode</th><th>Created</th></tr></thead>
          <tbody>{data.campaigns.map((c) => (
            <tr key={c._id} className="row" onClick={() => nav(`/app/campaigns/${c._id}`)}>
              <td><Link to={`/app/campaigns/${c._id}`} style={{ fontWeight: 600, textDecoration: 'none' }}>{c.name}</Link><div className="small muted">{c.objective}</div></td>
              <td><Badge status={c.status === 'active' ? 'ok' : c.status === 'paused' ? 'pending' : c.status === 'completed' ? '' : 'draft'}>{c.status}</Badge></td>
              <td className="small">{c.audience.statuses.map(human).join(', ')} · fit ≥ {c.audience.minScore}</td>
              <td className="num">{c.enrolled ?? 0}</td>
              <td>{c.dailyLimit}</td>
              <td className="small">{c.autoSend ? 'Automatic' : 'Approve each'}</td>
              <td className="small muted">{ago(c.createdAt)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}

const pct = (r?: { value: number | null; of: string }) => (r?.value == null ? '—' : `${r.value}%`)

export function CampaignDetail() {
  const { id } = useParams()
  const toast = useToast()
  const [days, setDays] = useState(0)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const { data, reload } = useLoad(
    () => api<{ campaign: Campaign; analytics: CampaignAnalytics; audience: { eligible: number; sample: Lead[] } }>(`/v1/campaigns/${id}${days ? `?days=${days}` : ''}`),
    [id, days],
    (d) => d.campaign.status === 'active',
  )
  if (!data) return <Spinner label="Loading campaign" />
  const { campaign: c, analytics: a, audience } = data
  const act = async (path: string, ok: string) => {
    setBusy(true)
    try { await api(`/v1/campaigns/${c._id}/${path}`, { method: 'POST' }); toast(ok); await reload() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  return (
    <div className="stack lg fade-in">
      <PageHead index={`Campaign · ${c.status}`} title={c.name}>
        <Link className="btn ghost" to="/app/campaigns">All campaigns</Link>
        {c.status !== 'completed' && <button className="btn ghost" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>}
        {c.status === 'active'
          ? <button className="btn danger" disabled={busy} onClick={() => act('pause', 'Paused — pending sends cancelled')}>Pause</button>
          : c.status !== 'completed' && <button className="btn lime" disabled={busy} onClick={() => act('start', 'Campaign started')}>{c.status === 'paused' ? 'Resume' : 'Start'}</button>}
        {c.status !== 'completed' && c.status !== 'draft' && <button className="linkish" onClick={() => window.confirm('Complete this campaign? It cannot be restarted.') && act('complete', 'Completed')}>Complete</button>}
      </PageHead>

      {editing && <CampaignForm initial={fromCampaign(c)} busy={busy} onSave={async (f) => {
        setBusy(true)
        try { await api(`/v1/campaigns/${c._id}`, { method: 'PATCH', body: toBody(f) }); toast('Saved'); setEditing(false); await reload() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
      }} />}

      <div className="row-flex between">
        <span className="h2">Results</span>
        <div className="status-tabs">{[[0, 'All time'], [7, '7 days'], [30, '30 days']].map(([d, l]) => <button key={d} className={`status-tab ${days === d ? 'active' : ''}`} onClick={() => setDays(d as number)}>{l}</button>)}</div>
      </div>
      <div className="grid-4">
        <Stat label="Enrolled leads" value={a.enrolled} hint={`${audience.eligible} more eligible now`} />
        <Stat label="Accepted by provider" value={a.accepted} hint={`${a.delivered} delivered · ${pct(a.rates.deliveryRate)} of accepted`} />
        <Stat label="Replied threads" value={a.repliedThreads} hint={`${pct(a.rates.replyRate)} of ${a.threads} threads contacted`} />
        <Stat label="Meetings pending" value={a.meetings} hint={`${a.optedOut} opted out · ${a.complaints} complaints`} />
      </div>
      <div className="grid-4">
        <Stat label="Awaiting approval" value={a.pendingApproval} hint={a.pendingApproval ? <Link to="/app/review">Review now →</Link> : 'Nothing waiting'} />
        <Stat label="Queued" value={a.queued} hint="respecting quiet hours and caps" />
        <Stat label="Bounced" value={a.bounced} hint={`${pct(a.rates.bounceRate)} of accepted`} />
        <Stat label="Blocked by policy" value={a.blockedByPolicy} hint={`${a.failed} failed / uncertain`} />
      </div>

      <div className="grid-2">
        <section className="card stack">
          <span className="h2">Setup</span>
          <dl className="kv">
            <dt>Audience</dt><dd>{c.audience.statuses.map(human).join(', ')} · fit ≥ {c.audience.minScore}</dd>
            <dt>Industries</dt><dd>{c.audience.industries.join(', ') || 'Any'}</dd>
            <dt>Countries</dt><dd>{c.audience.countries.join(', ') || 'Any'}</dd>
            <dt>Sequence</dt><dd>First email{c.followUpDelaysDays.map((d, i) => ` → follow-up ${i + 1} after ${d} business days`).join('')}</dd>
            <dt>Daily limit</dt><dd>{c.dailyLimit} new contacts</dd>
            <dt>Mode</dt><dd>{c.autoSend ? 'Automatic within policy' : 'Every message waits for approval'}</dd>
            <dt>Started</dt><dd>{c.startedAt ? ago(c.startedAt) : 'Not yet'}</dd>
          </dl>
        </section>
        <section className="card stack">
          <div className="row-flex between"><span className="h2">Next in line</span><span className="badge accent">{audience.eligible} eligible</span></div>
          {audience.sample.length ? audience.sample.map((l) => (
            <Link key={l._id} to={`/app/leads/${l._id}`} className="row-flex between" style={{ textDecoration: 'none', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <span><b>{l.company.name}</b> <span className="small muted">{l.contact?.name}</span></span><span className="num">{l.qualification?.score ?? '—'}</span>
            </Link>
          )) : <p className="small muted" style={{ margin: 0 }}>No leads match yet. Research and qualify more leads, or widen the audience.</p>}
        </section>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Rates show their denominator. A campaign is only working if replies and meetings grow, not just sends.</p>
    </div>
  )
}
