import { useState } from 'react'
import { api } from '../lib/api'
import { ago, human, money } from '../lib/format'
import { useAuth } from '../lib/auth'
import { Badge, Empty, PageHead, Spinner, Stat, useLoad, useToast } from '../components/ui'

interface Metrics {
  api: { last5m: { requests: number; errorRate: number; p95Ms: number }; last15m: { requests: number; errorRate: number; p95Ms: number } }
  queue: { byStatus: Record<string, number>; oldestDueAgeSec: number }
  failures24h: { workflowsByType: Record<string, number>; email: Record<string, number> }
  model24h: { calls: number; failed: number; p95Ms: number }
  usage24h: Record<string, { quantity: number; costMinor: number; tokens: number }>
  prototypes7d: { built: number; failed: number; avgBuildMs: number }
  spendThisMonth: { costMinor: number; topTenants: { organizationId: string; costMinor: number }[] }
  costPerQualifiedOpportunityMinor: number | null
}
interface Flag { _id: string; key: string; organizationId: string | null; enabled: boolean; note?: string; updatedAt: string }
interface DeadLetters {
  workflows: { _id: string; organizationId: string; type: string; failureCode?: string; lastError?: string; updatedAt: string }[]
  events: { _id: string; type: string; error?: string; updatedAt: string }[]
  uncertainMessages: { _id: string; organizationId: string; to: string; error?: string; updatedAt: string }[]
}

interface Capacity {
  types: { type: string; queued: number; running: number; oldestDueSec: number; runs24h: number; p50Ms: number; p95Ms: number; failed24h: number }[]
  process: { rssMb: number; heapUsedMb: number; load1: number; cpus: number }
  database: { pingMs: number; poolMax: number | null }
  recommendations: string[]
}
interface OrgRow { id: string; name: string; industry?: string; activatedAt: string | null; plan: string | null; subscriptionStatus: string | null; periodEnd: string | null; email: string; members: number; failedJobs24h: number }
interface EvalRun { _id: { runId: string; taskType: string; modelVersion: string; promptVersion: string; datasetVersion: string }; total: number; passed: number; at: string; failures: { id: string; category: string; detail?: string }[] }

const FLAGS = ['live_email', 'auto_send', 'prototypes']

// platform operators: health of the whole system, rollout switches and failed work
export default function Ops() {
  const { isPlatformAdmin, isSupport } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState({ key: 'live_email', organizationId: '', enabled: false, note: '' })
  const { data, reload } = useLoad(async () => {
    const [metrics, flags, dead, capacity, evals, orgs] = await Promise.all([
      api<Metrics>('/admin/metrics/summary'),
      api<{ flags: Flag[]; defaults: Record<string, boolean> }>('/admin/feature-flags'),
      api<DeadLetters>('/admin/dead-letters'),
      api<Capacity>('/admin/analytics/worker-capacity'),
      api<{ runs: EvalRun[] }>('/admin/evaluations/results'),
      api<{ organizations: OrgRow[] }>('/admin/organizations'),
    ])
    return { metrics, flags, dead, capacity, evals: evals.runs, orgs: orgs.organizations }
  }, [])
  if (!isPlatformAdmin && !isSupport) return <Empty title="Operators only.">Add your email to ADMIN_EMAILS (or SUPPORT_EMAILS for read-only) on the server to see this page.</Empty>
  if (!data) return <Spinner label="Loading operations" />
  const { metrics: m, flags, dead, capacity: cap, evals, orgs } = data
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); await reload() } catch (e) { toast((e as Error).message, true) } }

  return (
    <div className="stack lg fade-in">
      <PageHead index="Platform · live" title={<>Operations <span className="hl">console.</span></>} />

      <div className="grid-4">
        <Stat label="API p95 · 5 min" value={`${m.api.last5m.p95Ms} ms`} hint={`${m.api.last5m.requests} requests · ${(m.api.last5m.errorRate * 100).toFixed(1)}% errors (this instance)`} />
        <Stat label="Queue" value={m.queue.byStatus.queued ?? 0} hint={`${m.queue.byStatus.running ?? 0} running · oldest due ${Math.round(m.queue.oldestDueAgeSec / 60)} min`} />
        <Stat label="Model · 24 h" value={m.model24h.calls} hint={`${m.model24h.failed} failed · p95 ${(m.model24h.p95Ms / 1000).toFixed(1)} s`} />
        <Stat label="Spend · month" value={money(m.spendThisMonth.costMinor)} hint={m.costPerQualifiedOpportunityMinor === null ? 'no qualified opportunities yet' : `${money(m.costPerQualifiedOpportunityMinor)} per qualified opportunity`} />
      </div>

      <div className="grid-2">
        <section className="card stack">
          <span className="h2">Failures · 24 h</span>
          {Object.keys(m.failures24h.workflowsByType).length === 0 && <span className="small muted">No failed jobs.</span>}
          {Object.entries(m.failures24h.workflowsByType).map(([t, n]) => <div key={t} className="row-flex between small"><span className="mono">{t}</span><Badge status="failed">{n}</Badge></div>)}
          <div className="label">Email</div>
          <div className="chips">{Object.entries(m.failures24h.email).map(([s, n]) => <span key={s} className="badge plain">{human(s)} {n}</span>)}</div>
          <div className="label">Demo builds · 7 d</div>
          <span className="small">{m.prototypes7d.built} built · {m.prototypes7d.failed} failed · avg {(m.prototypes7d.avgBuildMs / 1000).toFixed(1)} s</span>
        </section>
        <section className="card stack">
          <span className="h2">Top spend this month</span>
          {m.spendThisMonth.topTenants.length === 0 && <span className="small muted">Nothing metered yet.</span>}
          {m.spendThisMonth.topTenants.map((t) => <div key={t.organizationId} className="row-flex between small"><span className="mono">{t.organizationId}</span><span className="mono">{money(t.costMinor)}</span></div>)}
        </section>
      </div>

      <section className="card stack">
        <span className="h2">Workspaces</span>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Workspace</th><th>Plan</th><th>Live</th><th>Email</th><th>Members</th><th>Failed 24 h</th><th /></tr></thead>
          <tbody>{orgs.map((o) => (
            <tr key={o.id}>
              <td><b>{o.name}</b><br /><span className="mono small muted">{o.id}</span></td>
              <td>{o.plan ?? '—'} <Badge status={o.subscriptionStatus === 'active' ? 'approved' : o.subscriptionStatus === 'trialing' ? 'pending' : 'failed'}>{o.subscriptionStatus ?? 'none'}</Badge></td>
              <td>{o.activatedAt ? '✓' : 'setup'}</td><td>{human(o.email)}</td><td>{o.members}</td><td>{o.failedJobs24h}</td>
              <td>{isPlatformAdmin && <button className="linkish" onClick={() => {
                const planKey = window.prompt('Plan for this workspace (starter, growth, scale)', o.plan ?? 'growth')
                const days = planKey && window.prompt('Active for how many days?', '30')
                const note = days && window.prompt('Reason (recorded in their audit log)')
                if (planKey && days && note) run(() => api(`/admin/organizations/${o.id}/subscription`, { body: { planKey, status: 'active', periodDays: Number(days), note } }), 'Subscription updated')
              }}>Set plan</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <span className="small muted">{isPlatformAdmin ? 'Changes are written to the workspace’s own audit log.' : 'Read-only support access. Opening a workspace’s health is recorded in its audit log.'}</span>
      </section>

      <section className="card stack">
        <span className="h2">Worker capacity</span>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Job type</th><th>Queued</th><th>Running</th><th>Oldest due</th><th>Runs 24 h</th><th>p50 / p95</th><th>Failed</th></tr></thead>
          <tbody>{cap.types.map((t) => <tr key={t.type}><td className="mono">{t.type}</td><td>{t.queued}</td><td>{t.running}</td><td>{Math.round(t.oldestDueSec / 60)} min</td><td>{t.runs24h}</td><td className="mono">{(t.p50Ms / 1000).toFixed(1)} / {(t.p95Ms / 1000).toFixed(1)} s</td><td>{t.failed24h}</td></tr>)}</tbody>
        </table></div>
        <span className="small muted">This instance: {cap.process.rssMb} MB RSS · load {cap.process.load1.toFixed(2)} on {cap.process.cpus} CPUs · database round trip {cap.database.pingMs} ms</span>
        {cap.recommendations.map((r) => <div key={r} className="small">→ {r}</div>)}
      </section>

      <section className="card stack">
        <div className="row-flex between"><span className="h2">AI evaluations</span>
          <span className="row-flex">
            <button className="btn ghost sm" onClick={() => run(() => api('/admin/evaluations/run', { body: { live: false } }), 'Deterministic checks done')}>Run checks</button>
            <button className="btn sm" onClick={() => run(() => api('/admin/evaluations/run', { body: { live: true } }), 'Model evaluation done')}>Run with model</button>
          </span>
        </div>
        <span className="small muted">Run after any model, prompt, scoring or workflow change. The prompt version changes whenever the prompt code does.</span>
        {evals.length === 0 && <span className="small muted">No runs yet.</span>}
        {evals.slice(0, 12).map((r) => (
          <div key={r._id.runId + r._id.taskType} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
            <span><b className="mono">{r._id.taskType}</b> · {r._id.modelVersion} · prompt {r._id.promptVersion} · dataset {r._id.datasetVersion}{r.failures.length ? ` · ✗ ${r.failures.map((f) => `${f.id} (${f.detail ?? f.category})`).join(', ')}` : ''}</span>
            <Badge status={r.passed === r.total ? 'approved' : 'failed'}>{r.passed}/{r.total}</Badge>
          </div>
        ))}
      </section>

      <section className="card stack">
        <span className="h2">Feature flags</span>
        <p className="small muted" style={{ margin: 0 }}>Defaults: {Object.entries(flags.defaults).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(' · ')}. A tenant row overrides the global row.</p>
        {flags.flags.map((f) => (
          <div key={f._id} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <span><b className="mono">{f.key}</b> · {f.organizationId ?? 'all tenants'}{f.note ? ` · ${f.note}` : ''}</span>
            <span className="row-flex"><Badge status={f.enabled ? 'approved' : 'rejected'}>{f.enabled ? 'on' : 'off'}</Badge><span className="muted">{ago(f.updatedAt)}</span>
              <button className="linkish" onClick={() => run(() => api(`/admin/feature-flags/${f._id}`, { method: 'DELETE' }), 'Flag removed')}>Remove</button></span>
          </div>
        ))}
        <div className="grid-4" style={{ alignItems: 'end' }}>
          <label className="field"><span>Flag</span><select className="select" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}>{FLAGS.map((f) => <option key={f}>{f}</option>)}</select></label>
          <label className="field"><span>Organization id (empty = all)</span><input className="input mono" value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value.trim() })} /></label>
          <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
          <button className="btn sm" onClick={() => run(() => api('/admin/feature-flags', { body: { key: form.key, enabled: form.enabled, note: form.note || undefined, organizationId: form.organizationId || null } }), 'Flag saved')}>Save flag</button>
        </div>
      </section>

      <section className="card stack">
        <span className="h2">Dead letters</span>
        {dead.workflows.length + dead.events.length + dead.uncertainMessages.length === 0 && <span className="small muted">Nothing failed. Good.</span>}
        {dead.workflows.map((w) => (
          <div key={w._id} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <span><b className="mono">{w.type}</b> · {w.failureCode}: {w.lastError?.slice(0, 120)} · <span className="muted">{ago(w.updatedAt)}</span></span>
            <button className="btn ghost sm" onClick={() => run(() => api(`/admin/workflows/${w._id}/retry`, { method: 'POST' }), 'Requeued')}>Retry</button>
          </div>
        ))}
        {dead.events.map((e) => <div key={e._id} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>provider event <b>{e.type}</b> · {e.error} · {ago(e.updatedAt)}</div>)}
        {dead.uncertainMessages.map((x) => <div key={x._id} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>uncertain send to <span className="mono">{x.to}</span> · reconcile it from the tenant’s review queue · {ago(x.updatedAt)}</div>)}
      </section>
    </div>
  )
}
