import { Link } from 'react-router'
import { api } from '../lib/api'
import type { BusinessProfile, PolicyConfig } from '../lib/types'
import { PageHead, Spinner, useLoad } from '../components/ui'

export default function Onboarding() {
  const { data } = useLoad(async () => {
    const [p, pol, leads] = await Promise.all([
      api<{ profile: BusinessProfile | null }>('/v1/business-profile'),
      api<{ current: { version: number; config: PolicyConfig } }>('/v1/policies'),
      api<{ leads: unknown[] }>('/v1/leads?limit=1'),
    ])
    return { profile: p.profile, policyVersion: pol.current.version, hasLeads: leads.leads.length > 0 }
  }, [])
  if (!data) return <Spinner label="Loading" />

  const steps = [
    { done: Boolean(data.profile?.description && data.profile.services.length), title: 'Describe your business', copy: 'What you sell, at what price, in what voice, and which claims the agents may make.', to: '/app/business', cta: 'Open business brain' },
    { done: Boolean(data.profile?.idealCustomerProfile?.industries?.length || data.profile?.idealCustomerProfile?.regions?.length), title: 'Define your ideal customer', copy: 'Industries, regions, signals and hard disqualifiers. The qualification agent scores against this.', to: '/app/business#icp', cta: 'Set ICP' },
    { done: data.policyVersion > 1, title: 'Set the limits', copy: 'Approval mode or automatic sending, daily caps, follow-ups, quiet hours, discount limits and AI budget.', to: '/app/policies', cta: 'Review policy' },
    { done: data.hasLeads, title: 'Bring your first leads', copy: 'Paste a CSV or add one by hand. Record the consent basis for each contact.', to: '/app/leads?add=1', cta: 'Add leads' },
  ]
  const next = steps.findIndex((s) => !s.done)

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 860 }}>
      <PageHead index="00 / Setup" title={<>Four steps to a <span className="serif">working pipeline.</span></>} />
      <div className="onboard-steps">
        {steps.map((s, i) => (
          <div key={s.title} className={`onboard-step ${s.done ? 'done' : ''}`}>
            <span className="n">{s.done ? '✓' : `0${i + 1}`}</span>
            <div>
              <div className="h3">{s.title}</div>
              <div className="small muted" style={{ marginTop: 4 }}>{s.copy}</div>
            </div>
            <Link className={`btn sm ${i === next ? '' : 'ghost'}`} to={s.to}>{s.done ? 'Edit' : s.cta}</Link>
          </div>
        ))}
      </div>
      {next === -1 && <div className="card"><p className="h2">You're set.</p><p className="muted">Open a lead and press <b>Run agent</b>. Drafts land in Approvals until you switch on automatic sending.</p><Link className="btn" to="/app/leads">Go to leads</Link></div>}
    </div>
  )
}
