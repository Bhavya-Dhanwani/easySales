import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { human, money } from '../lib/format'
import { useAuth } from '../lib/auth'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'

const STAGES = ['discovered', 'researched', 'icp_qualified', 'contacted', 'delivered', 'positive_reply', 'qualified_opportunity', 'proposal_sent', 'won', 'lost'] as const
type Counts = Partial<Record<(typeof STAGES)[number], number>>
type Rates = Record<string, number | null>
interface Funnel {
  definitions: Record<string, string>
  deliveryReported: boolean
  totals: { counts: Counts; rates: Rates }
  cohorts: { cohort: string; segment: string | null; counts: Counts; rates: Rates; incomplete: boolean }[]
}
interface Costs {
  totalMinor: number
  byStage: { stage: string; costMinor: number; units: number }[]
  costPerQualifiedOpportunityMinor: number | null
  qualifiedOpportunities: number
  waste: { disqualifiedLeadsMinor: number; failedPrototypesMinor: number; failedAgentCalls: number }
  topOpportunities: { leadId: string; company: string; costMinor: number; stagesReached: string[] }[]
}
interface Quality {
  bands: { priority: string; leads: number; avgScore: number; avgEvidenceCoverage: number; contacted: number; positiveReplies: number; qualifiedOpportunities: number; won: number; positiveReplyRate: number | null }[]
  evidenceGaps: { criterion: string; unknownRate: number | null }[]
}

const RATE_LABEL: Record<string, string> = {
  icpQualificationRate: 'ICP qualification', deliveryRate: 'Delivery', positiveReplyRate: 'Positive reply',
  qualificationRate: 'Qualification', proposalRate: 'Proposal', winRate: 'Win',
}
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`)

// funnel, cost and lead-quality analytics: computed on the server from recorded stage events
export default function Analytics() {
  const { org } = useAuth()
  const [groupBy, setGroupBy] = useState<'month' | 'week'>('month')
  const [bySegment, setBySegment] = useState(false)
  const { data, error } = useLoad(async () => {
    const [funnel, costs, quality] = await Promise.all([
      api<Funnel>(`/v1/analytics/funnel?groupBy=${groupBy}&bySegment=${bySegment}`),
      api<Costs>('/v1/analytics/costs?days=30'),
      api<Quality>('/v1/analytics/lead-quality'),
    ])
    return { funnel, costs, quality }
  }, [org?.id, groupBy, bySegment])
  if (error) return <Empty title="You don't have access to analytics." />
  if (!data) return <Spinner label="Crunching the funnel" />
  const { funnel: f, costs: c, quality: q } = data
  const max = Math.max(1, ...STAGES.map((s) => f.totals.counts[s] ?? 0))

  return (
    <div className="stack lg fade-in">
      <PageHead index="Analytics · from real events" title={<>Where deals <span className="hl">come from.</span></>}>
        <select className="select" style={{ width: 140 }} value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'month' | 'week')} aria-label="Cohort"><option value="month">By month</option><option value="week">By week</option></select>
        <label className="check"><input type="checkbox" checked={bySegment} onChange={(e) => setBySegment(e.target.checked)} /> By industry</label>
      </PageHead>

      <section className="card stack">
        <span className="h2">Funnel</span>
        {STAGES.map((s) => (
          <div key={s} className="row-flex" style={{ gap: 12 }}>
            <span className="small" style={{ width: 170 }}>{human(s)}</span>
            <span className="meter" style={{ flex: 1 }}><i style={{ width: `${((f.totals.counts[s] ?? 0) / max) * 100}%` }} /></span>
            <span className="mono" style={{ width: 50, textAlign: 'right' }}>{f.totals.counts[s] ?? 0}</span>
          </div>
        ))}
        <div className="funnel">{Object.entries(f.totals.rates).map(([k, v]) => <div key={k} title={f.definitions[k]}><div className="score">{pct(v)}</div><span className="small muted">{RATE_LABEL[k]}</span></div>)}</div>
        {!f.deliveryReported && <span className="small muted">Your mail provider does not report deliveries, so reply rates use contacted prospects.</span>}
      </section>

      <section className="card stack">
        <span className="h2">Cohorts</span>
        {f.cohorts.length === 0 ? <span className="small muted">No events yet. Import leads and run the agents.</span> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Cohort</th>{bySegment && <th>Industry</th>}<th>Leads</th><th>ICP</th><th>Contacted</th><th>Positive</th><th>Qualified</th><th>Won</th><th>Reply rate</th><th /></tr></thead>
            <tbody>{f.cohorts.map((r) => (
              <tr key={`${r.cohort}${r.segment}`}>
                <td className="mono">{r.cohort}</td>{bySegment && <td>{r.segment}</td>}
                <td>{r.counts.discovered ?? 0}</td><td>{r.counts.icp_qualified ?? 0}</td><td>{r.counts.contacted ?? 0}</td>
                <td>{r.counts.positive_reply ?? 0}</td><td>{r.counts.qualified_opportunity ?? 0}</td><td>{r.counts.won ?? 0}</td>
                <td className="mono">{pct(r.rates.positiveReplyRate)}</td>
                <td>{r.incomplete && <span className="badge plain" title="Less than 30 days old: replies and deals are still coming in">still maturing</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <div className="grid-2">
        <section className="card stack">
          <div className="row-flex between"><span className="h2">Cost · 30 days</span><span className="mono">{money(c.totalMinor)}</span></div>
          <div className="row-flex between"><span className="small">Per qualified opportunity</span><b className="mono">{c.costPerQualifiedOpportunityMinor === null ? '—' : money(c.costPerQualifiedOpportunityMinor)}</b></div>
          {c.byStage.map((s) => <div key={s.stage} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}><span>{human(s.stage)}</span><span className="mono">{money(s.costMinor)}</span></div>)}
          <div className="label">Spend that bought nothing</div>
          <div className="small">Disqualified leads {money(c.waste.disqualifiedLeadsMinor)} · failed demos {money(c.waste.failedPrototypesMinor)} · {c.waste.failedAgentCalls} failed AI calls</div>
        </section>
        <section className="card stack">
          <span className="h2">Does the score predict outcomes?</span>
          {q.bands.length === 0 && <span className="small muted">No scored leads yet.</span>}
          {q.bands.map((b) => (
            <div key={b.priority} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
              <span><Badge status={b.priority === 'high' ? 'approved' : b.priority === 'medium' ? 'pending' : 'plain'}>{b.priority}</Badge> {b.leads} leads · fit {b.avgScore} · evidence {b.avgEvidenceCoverage}%</span>
              <span className="mono">{b.positiveReplies}/{b.contacted} replied · {b.won} won</span>
            </div>
          ))}
          {!!q.evidenceGaps.length && <><div className="label">Most often unknown</div><div className="chips">{q.evidenceGaps.slice(0, 4).map((g) => <span key={g.criterion} className="badge plain">{human(g.criterion)} {pct(g.unknownRate)}</span>)}</div></>}
        </section>
      </div>

      <section className="card stack">
        <span className="h2">Most expensive opportunities</span>
        {c.topOpportunities.map((o) => (
          <div key={o.leadId} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
            <Link to={`/app/leads/${o.leadId}`}>{o.company}</Link>
            <span className="row-flex"><span className="muted">{o.stagesReached.length ? human(o.stagesReached[o.stagesReached.length - 1]) : '—'}</span><span className="mono">{money(o.costMinor)}</span></span>
          </div>
        ))}
      </section>
    </div>
  )
}

interface Experiment {
  _id: string; name: string; hypothesis: string; variable: string; status: string; primaryMetric: string; minSamplePerVariant: number
  variants: { id: string; label: string; instruction: string }[]
}
interface Results {
  stoppingRuleMet: boolean; note: string
  variants: { id: string; label: string; assigned: number; counts: Counts; rates: Rates; zVsControl: number | null }[]
}

function ExperimentRow({ e, onChange }: { e: Experiment; onChange: () => void }) {
  const toast = useToast()
  const [results, setResults] = useState<Results | null>(null)
  const post = async (action: string) => {
    try { await api(`/v1/experiments/${e._id}/${action}`, { method: 'POST' }); toast(`Experiment ${action === 'start' ? 'running' : action === 'pause' ? 'paused' : 'completed'}`); onChange() } catch (err) { toast((err as Error).message, true) }
  }
  return (
    <div className="card stack">
      <div className="row-flex between">
        <span className="row-flex"><Badge status={e.status === 'running' ? 'approved' : e.status === 'completed' ? 'plain' : 'pending'}>{e.status}</Badge><b>{e.name}</b><span className="small muted">{human(e.variable)} · {human(e.primaryMetric)}</span></span>
        <span className="row-flex">
          {['draft', 'paused'].includes(e.status) && <button className="btn sm" onClick={() => post('start')}>Start</button>}
          {e.status === 'running' && <button className="btn ghost sm" onClick={() => post('pause')}>Pause</button>}
          {['running', 'paused'].includes(e.status) && <button className="linkish" onClick={() => post('complete')}>Complete</button>}
          <button className="linkish" onClick={async () => setResults(results ? null : await api<Results>(`/v1/experiments/${e._id}/results`))}>{results ? 'Hide results' : 'Results'}</button>
        </span>
      </div>
      <span className="small muted">{e.hypothesis}</span>
      {results && (
        <div className="stack sm">
          {results.variants.map((v, i) => (
            <div key={v.id} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
              <span><b>{v.id}</b> {v.label}{i === 0 ? ' (control)' : ''}</span>
              <span className="mono">{v.assigned} assigned · {v.counts.contacted ?? 0} contacted · {pct(v.rates.positiveReplyRate)} positive · {pct(v.rates.qualificationRate)} qualified{v.zVsControl !== null ? ` · z ${v.zVsControl}` : ''}</span>
            </div>
          ))}
          <span className="small muted">{results.note}</span>
        </div>
      )}
    </div>
  )
}

// controlled outreach tests: approved variants of one element; every send still passes policy
export function Experiments() {
  const toast = useToast()
  const { org } = useAuth()
  const blank = { name: '', hypothesis: '', variable: 'subject_line', minSamplePerVariant: 50, variants: [{ label: 'Control', instruction: '' }, { label: 'Variant B', instruction: '' }] }
  const [form, setForm] = useState(blank)
  const [open, setOpen] = useState(false)
  const { data, reload } = useLoad(() => api<{ experiments: Experiment[] }>('/v1/experiments'), [org?.id])
  if (!data) return <Spinner />
  return (
    <div className="stack lg fade-in">
      <PageHead index="Experiments" title={<>Test one thing <span className="hl">at a time.</span></>}>
        <button className="btn" onClick={() => setOpen(!open)}>{open ? 'Close' : 'New experiment'}</button>
      </PageHead>
      {open && (
        <section className="card stack">
          <div className="grid-2">
            <label className="field"><span>Name</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>What changes</span><select className="select" value={form.variable} onChange={(e) => setForm({ ...form, variable: e.target.value })}>{['subject_line', 'opening', 'value_proposition', 'call_to_action'].map((v) => <option key={v} value={v}>{human(v)}</option>)}</select></label>
          </div>
          <label className="field"><span>Hypothesis</span><input className="input" placeholder="A question in the subject line gets more positive replies" value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} /></label>
          {form.variants.map((v, i) => (
            <label key={i} className="field"><span>{i === 0 ? 'Control' : `Variant ${String.fromCharCode(65 + i)}`} · instruction for the writer</span>
              <input className="input" placeholder={i === 0 ? 'Subject line: Online booking for your clinic' : 'Subject line: Still taking bookings by phone?'} value={v.instruction} onChange={(e) => setForm({ ...form, variants: form.variants.map((x, j) => (j === i ? { ...x, instruction: e.target.value, label: x.label } : x)) })} />
            </label>
          ))}
          <div className="row-flex">
            {form.variants.length < 4 && <button className="btn ghost sm" onClick={() => setForm({ ...form, variants: [...form.variants, { label: `Variant ${String.fromCharCode(65 + form.variants.length)}`, instruction: '' }] })}>Add variant</button>}
            <label className="field" style={{ width: 200 }}><span>Contacted per variant before a verdict</span><input className="input" type="number" min={10} value={form.minSamplePerVariant} onChange={(e) => setForm({ ...form, minSamplePerVariant: Math.max(10, Number(e.target.value) || 10) })} /></label>
            <button className="btn" onClick={async () => {
              try { await api('/v1/experiments', { body: form }); toast('Experiment drafted. Start it when ready.'); setForm(blank); setOpen(false); reload() } catch (e) { toast((e as Error).message, true) }
            }}>Save draft</button>
          </div>
          <span className="small muted">Variants only change the first email’s wording. Caps, consent, opt-outs and approvals apply exactly as usual, and each prospect only ever sees one variant.</span>
        </section>
      )}
      {data.experiments.length === 0 && !open && <Empty title="No experiments yet.">Pick one element of your first email and test an approved alternative against it.</Empty>}
      {data.experiments.map((e) => <ExperimentRow key={e._id} e={e} onChange={reload} />)}
    </div>
  )
}
