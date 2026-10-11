import { api } from '../lib/api'
import { human, money } from '../lib/format'
import { useAuth } from '../lib/auth'
import { Badge, PageHead, Spinner, useLoad, useToast } from '../components/ui'

interface Ent { maxMembers: number; researchJobsPerMonth: number; emailSendsPerMonth: number; prototypeBuildsPerMonth: number; analyticsLevel: string; apiAccess: boolean }
interface Plan { _id: string; key: string; name: string; version: number; priceMinorUnits: number; currency: string; billingInterval: string; entitlements: Ent }
interface Sub {
  subscription: { planKey: string; planVersion: number; status: string; currentPeriodStart: string; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; scheduledPlanKey?: string; pendingPlanKey?: string }
  entitlements: Ent
  suspended: boolean
  usage: { research: number; emails: number; prototypes: number; members: number }
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 100
  return (
    <div className="stack sm">
      <div className="row-flex between small"><span>{label}</span><span className="mono">{used.toLocaleString()} / {limit.toLocaleString()}</span></div>
      <span className="meter"><i style={{ width: `${pct}%`, background: pct >= 90 ? 'var(--bad)' : undefined }} /></span>
    </div>
  )
}

// plan, limits and usage; payment state only ever changes through the billing provider
export default function Billing() {
  const toast = useToast()
  const { org } = useAuth()
  const { data, reload } = useLoad(async () => ({
    plans: (await api<{ plans: Plan[] }>('/v1/plans')).plans,
    sub: await api<Sub>('/v1/organization/subscription'),
  }), [org?.id])
  if (!data) return <Spinner label="Loading plan" />
  const { plans, sub } = data
  const s = sub.subscription
  const run = async (fn: () => Promise<{ outcome?: string } | unknown>) => {
    try {
      const r = await fn() as { outcome?: string }
      toast(r?.outcome === 'payment_required' ? 'Upgrade recorded: it starts once payment is confirmed' : r?.outcome === 'scheduled' ? 'Change scheduled for the end of this period' : 'Done')
      reload()
    } catch (e) { toast((e as Error).message, true) }
  }

  return (
    <div className="stack lg fade-in">
      <PageHead index="Plan & billing" title={<>{human(s.planKey)} <span className="hl">plan.</span></>}>
        <Badge status={sub.suspended ? 'failed' : s.status === 'active' ? 'approved' : 'pending'}>{sub.suspended ? 'suspended' : human(s.status)}</Badge>
      </PageHead>
      {sub.suspended && <div className="card" style={{ borderColor: 'var(--bad)' }}>Your subscription is inactive. Research, sending and demo builds are paused; your data stays available and exportable.</div>}
      <section className="card stack">
        <div className="row-flex between">
          <span className="h2">This period</span>
          <span className="small muted">{new Date(s.currentPeriodStart).toLocaleDateString()} to {new Date(s.currentPeriodEnd).toLocaleDateString()}{s.cancelAtPeriodEnd ? ' · ends then' : ''}{s.scheduledPlanKey ? ` · switches to ${human(s.scheduledPlanKey)}` : ''}{s.pendingPlanKey ? ` · ${human(s.pendingPlanKey)} awaiting payment` : ''}</span>
        </div>
        <div className="grid-2">
          <Meter label="Research jobs" used={sub.usage.research} limit={sub.entitlements.researchJobsPerMonth} />
          <Meter label="Emails sent" used={sub.usage.emails} limit={sub.entitlements.emailSendsPerMonth} />
          <Meter label="Demo builds" used={sub.usage.prototypes} limit={sub.entitlements.prototypeBuildsPerMonth} />
          <Meter label="Team members" used={sub.usage.members} limit={sub.entitlements.maxMembers} />
        </div>
        <span className="small muted">Plan limits count work. Your spending limit (Autonomy & limits) separately caps what that work may cost. Either one stops spending on its own.</span>
      </section>
      <div className="grid-3">
        {plans.map((p) => (
          <section key={p._id} className="card stack" style={p.key === s.planKey ? { borderColor: 'var(--forest-3)', boxShadow: '0 0 0 1px var(--forest-3)' } : undefined}>
            <div className="row-flex between"><span className="h2">{p.name}</span>{p.key === s.planKey && <Badge status="approved">current</Badge>}</div>
            <div className="score">{money(p.priceMinorUnits, p.currency)}<span className="small muted"> / {p.billingInterval === 'yearly' ? 'year' : 'month'}</span></div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>{p.entitlements.maxMembers} team members</li>
              <li>{p.entitlements.researchJobsPerMonth.toLocaleString()} research jobs</li>
              <li>{p.entitlements.emailSendsPerMonth.toLocaleString()} emails</li>
              <li>{p.entitlements.prototypeBuildsPerMonth} demo builds</li>
              <li>{p.entitlements.analyticsLevel === 'advanced' ? 'Advanced analytics & experiments' : 'Funnel analytics'}</li>
            </ul>
            {p.key !== s.planKey && <button className="btn sm" onClick={() => run(() => api('/v1/organization/subscription', { body: { planKey: p.key } }))}>{s.status === 'trialing' ? 'Choose' : 'Switch'}</button>}
          </section>
        ))}
      </div>
      {!s.cancelAtPeriodEnd && s.status !== 'cancelled' && <div><button className="linkish" style={{ color: 'var(--bad)' }} onClick={() => window.confirm('Cancel at the end of this period? Your data stays available.') && run(() => api('/v1/organization/subscription/cancel', { method: 'POST' }))}>Cancel subscription</button></div>}
    </div>
  )
}
