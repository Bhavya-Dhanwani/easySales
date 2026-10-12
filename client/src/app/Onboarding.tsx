import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { human } from '../lib/format'
import { useAuth } from '../lib/auth'
import { PageHead, Spinner, useLoad, useToast } from '../components/ui'

interface Status {
  currentStep: string | null
  steps: { step: string; done: boolean; issues: string[] }[]
  activatedAt: string | null
  subscription: { planKey: string; status: string; currentPeriodEnd: string }
  testRun: { leadId: string; messageStatus: string | null } | null
}

const COPY: Record<string, [string, string]> = {
  organization: ['Your workspace', 'Name, industry and timezone (quiet hours and schedules use it).'],
  business: ['What you sell', 'A short description and your services with prices. Proposals are priced only from this list.'],
  icp: ['Who you sell to', 'Industries, regions, company sizes or signals. Every lead is scored against this.'],
  voice: ['How you sound', 'Brand voice and the claims the agents may (and may never) make.'],
  email: ['Your mailbox', 'Send from your own address with an app password, or skip and send from easySales mail.'],
  limits: ['Your limits', 'Monthly spend, daily and hourly sending caps, and whether messages wait for your approval.'],
  test_run: ['A safe rehearsal', 'The agents research a sample lead and write the first email to you, and only you.'],
  activation: ['Go live', 'Nothing is sent to a real prospect until you activate.'],
}

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

function StepForm({ step, onSaved }: { step: string; onSaved: () => void }) {
  const toast = useToast()
  const { org, user } = useAuth()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<Record<string, string>>({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, name: org?.name ?? '', brandVoice: 'warm, concise, practical', spend: '5000', perDay: '20', perHour: '10', autoSend: '' })
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const save = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); onSaved() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }
  const field = (k: string, label: string, ph = '', type = 'text') => <label className="field"><span>{label}</span><input className="input" type={type} placeholder={ph} value={f[k] ?? ''} onChange={set(k)} /></label>

  if (step === 'organization') return (
    <div className="stack">
      <div className="grid-3">{field('name', 'Workspace name')}{field('industry', 'Your industry', 'Web agency')}{field('timezone', 'Timezone', 'Asia/Kolkata')}</div>
      <div><button className="btn" disabled={busy} onClick={() => save(() => api('/v1/onboarding/organization', { method: 'PUT', body: { name: f.name, industry: f.industry, timezone: f.timezone } }), 'Saved')}>Save and continue</button></div>
    </div>
  )
  if (step === 'business' || step === 'voice') return (
    <div className="stack">
      <div className="grid-2">{field('businessName', 'Business name', org?.name)}{field('website', 'Website (optional)', 'https://')}</div>
      <label className="field"><span>What you do</span><textarea className="textarea" value={f.description ?? ''} onChange={set('description')} placeholder="Who you help, how, and what makes you different." /></label>
      <div className="grid-2">{field('service', 'Main service', 'Booking website')}{field('price', 'Starting price (₹)', '50000', 'number')}</div>
      {field('brandVoice', 'Brand voice')}
      <div className="grid-2">{field('approved', 'Claims the agents may make (comma separated)', 'Built 40 clinic websites')}{field('prohibited', 'Never say (comma separated)', 'guaranteed results')}</div>
      <div><button className="btn" disabled={busy || !f.description || !f.service} onClick={() => save(() => api('/v1/onboarding/business-profile', { method: 'PUT', body: {
        businessName: f.businessName || org?.name, description: f.description, ...(f.website ? { website: f.website } : {}),
        services: [{ name: f.service, basePriceMinor: Math.round(Number(f.price || 0) * 100) }], brandVoice: f.brandVoice,
        approvedClaims: csv(f.approved ?? ''), prohibitedClaims: csv(f.prohibited ?? ''),
      } }), 'Saved')}>Save and continue</button> <Link className="small" to="/app/business">More services and details in Business brain</Link></div>
    </div>
  )
  if (step === 'icp') return (
    <div className="stack">
      <div className="grid-2">{field('industries', 'Industries', 'Healthcare, Education')}{field('regions', 'Regions', 'India')}</div>
      <div className="grid-2">{field('sizes', 'Company sizes', '10-50, 51-200')}{field('signals', 'Buying signals', 'phone-only booking')}</div>
      {field('disqualifiers', 'Never a fit', 'government body')}
      <div><button className="btn" disabled={busy} onClick={() => save(() => api('/v1/onboarding/icp', { method: 'PUT', body: { idealCustomerProfile: {
        industries: csv(f.industries ?? ''), regions: csv(f.regions ?? ''), companySizes: csv(f.sizes ?? ''), requiredSignals: csv(f.signals ?? ''), disqualifiers: csv(f.disqualifiers ?? ''),
      } } }), 'Saved')}>Save and continue</button></div>
    </div>
  )
  if (step === 'email') return <div><Link className="btn" to="/app/email">Connect your mailbox</Link> <span className="small muted">Come back here afterwards; your progress is kept.</span></div>
  if (step === 'limits') return (
    <div className="stack">
      <div className="grid-3">{field('spend', 'Monthly spend limit (₹)', '5000', 'number')}{field('perDay', 'New contacts per day', '20', 'number')}{field('perHour', 'Emails per hour', '10', 'number')}</div>
      <label className="check"><input type="checkbox" checked={f.autoSend === 'yes'} onChange={(e) => setF({ ...f, autoSend: e.target.checked ? 'yes' : '' })} /> Send in-policy messages without asking me (you can change this any time)</label>
      <div><button className="btn" disabled={busy} onClick={() => save(() => api('/v1/onboarding/limits', { method: 'PUT', body: {
        monthlySpendMinor: Math.round(Number(f.spend) * 100), maxNewContactsPerDay: Number(f.perDay), maxPerHour: Math.max(1, Number(f.perHour)), autoSend: f.autoSend === 'yes',
      } }), 'Limits saved')}>Save and continue</button></div>
    </div>
  )
  if (step === 'test_run') return (
    <div className="row-flex"><button className="btn" disabled={busy} onClick={() => save(() => api('/v1/onboarding/test-run', { method: 'POST' }), 'Rehearsal started')}>Run the rehearsal</button><span className="small muted">The email goes to {user?.email} only.</span></div>
  )
  return (
    <div className="row-flex"><button className="btn lime" disabled={busy} onClick={() => save(() => api('/v1/onboarding/activate', { method: 'POST' }), 'Workspace is live')}>Activate workspace</button><span className="small muted">Policies, caps and approvals keep applying after this.</span></div>
  )
}

// resumable setup: the server derives every step from the real configuration
export default function Onboarding() {
  const { org } = useAuth()
  const { data, reload } = useLoad(() => api<Status>('/v1/onboarding/status'), [org?.id], (d) => Boolean(d.testRun && !d.testRun.messageStatus))
  const [open, setOpen] = useState<string | null>(null)
  if (!data) return <Spinner label="Loading setup" />
  const current = open ?? data.currentStep
  const done = data.steps.filter((s) => s.done).length

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 900 }}>
      <PageHead index={`Setup · ${done}/${data.steps.length}`} title={data.activatedAt ? <>You are <span className="hl">live.</span></> : <>Eight steps to a <span className="hl">safe launch.</span></>}>
        <Link className="btn ghost" to="/app/billing">{human(data.subscription.planKey)} · {human(data.subscription.status)}</Link>
      </PageHead>
      <div className="onboard-steps">
        {data.steps.map((s, i) => (
          <div key={s.step} className={`onboard-step ${s.done ? 'done' : ''}`} style={{ alignItems: 'start' }}>
            <span className="n">{s.done ? '✓' : `0${i + 1}`}</span>
            <div className="stack sm" style={{ flex: 1 }}>
              <div className="h3">{COPY[s.step][0]}</div>
              <div className="small muted">{COPY[s.step][1]}</div>
              {!s.done && s.issues.map((x) => <div key={x} className="small" style={{ color: 'var(--warn, #b26a00)' }}>• {x}</div>)}
              {s.step === 'test_run' && data.testRun && <div className="small">Rehearsal email: <b>{data.testRun.messageStatus ? human(data.testRun.messageStatus) : 'being written…'}</b></div>}
              {current === s.step && !(s.done && s.step === 'activation') && <div style={{ marginTop: 10 }}><StepForm step={s.step} onSaved={() => { setOpen(null); reload() }} /></div>}
            </div>
            {current !== s.step && s.step !== 'activation' && <button className="btn ghost sm" onClick={() => setOpen(s.step)}>{s.done ? 'Edit' : 'Open'}</button>}
          </div>
        ))}
      </div>
      {data.activatedAt && <div className="card"><p className="h2">Next: bring leads.</p><p className="muted">Import a CSV, run the agents, and watch the Analytics page. Your plan runs until {new Date(data.subscription.currentPeriodEnd).toLocaleDateString()}.</p><Link className="btn" to="/app/leads/import">Import leads</Link></div>}
    </div>
  )
}
