import { useEffect, useState, type KeyboardEvent } from 'react'
import { api } from '../lib/api'
import { ago, human, money } from '../lib/format'
import type { AuditEvent, BusinessProfile, PolicyConfig, Role, Service } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

/* ------------------------------ helpers ------------------------------ */

function Chips({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v && !value.includes(v)) onChange([...value, v])
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add() }
    if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
  }
  return (
    <div className="chip-input">
      {value.map((v) => <span className="chip" key={v}>{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>×</button></span>)}
      <input value={draft} placeholder={value.length ? '' : placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} />
    </div>
  )
}

const EMPTY_PROFILE: BusinessProfile = {
  businessName: '', businessType: '', description: '', website: '', services: [],
  idealCustomerProfile: { industries: [], companySizes: [], regions: [], requiredSignals: [], disqualifiers: [] },
  brandVoice: 'professional, concise, warm', approvedClaims: [], prohibitedClaims: [], caseStudies: [],
}

/* --------------------------- business brain --------------------------- */

export function Business() {
  const toast = useToast()
  const { org } = useAuth()
  const [p, setP] = useState<BusinessProfile | null>(null)
  const [busy, setBusy] = useState(false)

  const [criteria, setCriteria] = useState<{ id: string; label: string }[]>([])
  const [defaults, setDefaults] = useState<Record<string, number>>({})

  useEffect(() => {
    api<{ profile: BusinessProfile | null; criteria: { id: string; label: string }[]; defaultWeights: Record<string, number> }>('/v1/business-profile').then((d) => {
      setCriteria(d.criteria)
      setDefaults(d.defaultWeights)
      const prof = { ...EMPTY_PROFILE, ...(d.profile ?? {}) }
      setP({ ...prof, idealCustomerProfile: { ...EMPTY_PROFILE.idealCustomerProfile, ...prof.idealCustomerProfile } })
    })
  }, [org?.id])

  if (!p) return <Spinner label="Loading" />
  const weights: Record<string, number> = { ...defaults, ...(p.scoringWeights ?? {}) }
  const set = <K extends keyof BusinessProfile>(k: K, v: BusinessProfile[K]) => setP({ ...p, [k]: v })
  const icp = (k: keyof BusinessProfile['idealCustomerProfile'], v: string[]) => setP({ ...p, idealCustomerProfile: { ...p.idealCustomerProfile, [k]: v } })
  const svc = (i: number, patch: Partial<Service>) => set('services', p.services.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  async function save() {
    setBusy(true)
    try {
      const body = {
        businessName: p!.businessName, businessType: p!.businessType, description: p!.description, website: p!.website, meetingLink: p!.meetingLink || '',
        services: p!.services.map((s) => ({ name: s.name, description: s.description ?? '', basePriceMinor: Math.round(s.basePriceMinor), ...(s.deliveryDaysMin ? { deliveryDaysMin: s.deliveryDaysMin } : {}), ...(s.deliveryDaysMax ? { deliveryDaysMax: s.deliveryDaysMax } : {}) })),
        idealCustomerProfile: p!.idealCustomerProfile, brandVoice: p!.brandVoice,
        approvedClaims: p!.approvedClaims, prohibitedClaims: p!.prohibitedClaims,
        caseStudies: p!.caseStudies.filter((c) => c.title || c.summary),
        terms: p!.terms ?? '', revisionRounds: p!.revisionRounds ?? 2,
        ...(p!.paymentSchedule?.length ? { paymentSchedule: p!.paymentSchedule.filter((x) => x.label && x.percent > 0) } : {}),
        ...(criteria.length ? { scoringWeights: Object.fromEntries(criteria.map((c) => [c.id, weights[c.id] ?? 0])) } : {}),
      }
      await api('/v1/business-profile', { method: 'PUT', body })
      toast('Saved as a new profile version. Re-qualify leads to apply new weights.')
    } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 980 }}>
      <PageHead index="Business brain" title={<>What the agents <span className="hl">know.</span></>}>
        <button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </PageHead>

      <section className="card stack">
        <div className="label">Identity</div>
        <div className="grid-3">
          <label className="field"><span>Business name</span><input className="input" value={p.businessName} onChange={(e) => set('businessName', e.target.value)} /></label>
          <label className="field"><span>Type</span><input className="input" placeholder="Web & app agency" value={p.businessType} onChange={(e) => set('businessType', e.target.value)} /></label>
          <label className="field"><span>Website</span><input className="input" placeholder="https://" value={p.website} onChange={(e) => set('website', e.target.value)} /></label>
        </div>
        <label className="field"><span>What you do</span><textarea className="textarea" placeholder="Who you help, how, and what makes you different." value={p.description} onChange={(e) => set('description', e.target.value)} /></label>
        <label className="field"><span>Brand voice</span><input className="input" value={p.brandVoice} onChange={(e) => set('brandVoice', e.target.value)} /></label>
        <label className="field"><span>Meeting booking link</span><input className="input" placeholder="https://cal.com/you/20min" value={p.meetingLink ?? ''} onChange={(e) => set('meetingLink', e.target.value)} /><small>Shared when a prospect asks to meet.</small></label>
      </section>

      <section className="card stack">
        <div className="label">Proposal terms</div>
        <label className="field"><span>Approved commercial terms</span><textarea className="textarea" style={{ minHeight: 120 }} placeholder="Copied word for word into every proposal. The AI never edits it." value={p.terms ?? ''} onChange={(e) => set('terms', e.target.value)} /></label>
        <div className="grid-3">
          <label className="field"><span>Revision rounds included</span><input className="input" type="number" min={0} max={20} value={p.revisionRounds ?? 2} onChange={(e) => set('revisionRounds', Math.max(0, Math.round(Number(e.target.value) || 0)))} /></label>
          <label className="field" style={{ gridColumn: 'span 2' }}><span>Payment schedule (label:percent, comma separated)</span>
            <input className="input" placeholder="On signing:50, On delivery:50" defaultValue={(p.paymentSchedule ?? []).map((x) => `${x.label}:${x.percent}`).join(', ')}
              onBlur={(e) => set('paymentSchedule', e.target.value.split(',').map((x) => x.split(':')).filter((x) => x.length === 2).map(([l, n]) => ({ label: l.trim(), percent: Math.round(Number(n)) })))} />
            <small>Must add up to 100. Amounts are computed from the final total; the last instalment takes any rounding.</small>
          </label>
        </div>
      </section>

      <section className="card stack">
        <div className="row-flex between"><div className="label">Services & base prices</div><button className="btn ghost sm" onClick={() => set('services', [...p.services, { name: '', description: '', basePriceMinor: 0 }])}>Add service</button></div>
        {p.services.length === 0 && <p className="small muted" style={{ margin: 0 }}>Proposals are priced only from this catalogue. Agents never quote prices in emails.</p>}
        {p.services.map((s, i) => (
          <div key={i} className="grid-4" style={{ alignItems: 'end', borderTop: i ? '1px solid var(--line)' : 0, paddingTop: i ? 14 : 0 }}>
            <label className="field"><span>Name</span><input className="input" value={s.name} onChange={(e) => svc(i, { name: e.target.value })} /></label>
            <label className="field"><span>Base price (₹)</span><input className="input" type="number" min={0} step="1" value={s.basePriceMinor / 100} onChange={(e) => svc(i, { basePriceMinor: Math.round(Number(e.target.value) * 100) })} /></label>
            <label className="field"><span>Delivery days (min–max)</span>
              <span className="row-flex" style={{ flexWrap: 'nowrap', gap: 6 }}>
                <input className="input" type="number" min={0} value={s.deliveryDaysMin ?? ''} onChange={(e) => svc(i, { deliveryDaysMin: Number(e.target.value) || undefined })} />
                <input className="input" type="number" min={0} value={s.deliveryDaysMax ?? ''} onChange={(e) => svc(i, { deliveryDaysMax: Number(e.target.value) || undefined })} />
              </span>
            </label>
            <div className="row-flex" style={{ justifyContent: 'flex-end' }}><span className="mono small muted">{money(s.basePriceMinor)}</span><button className="linkish" onClick={() => set('services', p.services.filter((_, j) => j !== i))}>Remove</button></div>
            <label className="field" style={{ gridColumn: '1 / -1' }}><span>Description</span><input className="input" value={s.description} onChange={(e) => svc(i, { description: e.target.value })} /></label>
          </div>
        ))}
      </section>

      <section id="icp" className="card stack">
        <div className="label">Ideal customer profile</div>
        <div className="grid-2">
          <label className="field"><span>Industries</span><Chips value={p.idealCustomerProfile.industries} onChange={(v) => icp('industries', v)} placeholder="Healthcare, Education… (Enter)" /></label>
          <label className="field"><span>Regions</span><Chips value={p.idealCustomerProfile.regions} onChange={(v) => icp('regions', v)} placeholder="India, UAE…" /></label>
          <label className="field"><span>Company sizes</span><Chips value={p.idealCustomerProfile.companySizes} onChange={(v) => icp('companySizes', v)} placeholder="11-50, 51-200…" /></label>
          <label className="field"><span>Buying signals</span><Chips value={p.idealCustomerProfile.requiredSignals} onChange={(v) => icp('requiredSignals', v)} placeholder="Outdated website, hiring…" /></label>
        </div>
        <label className="field"><span>Hard disqualifiers</span><Chips value={p.idealCustomerProfile.disqualifiers} onChange={(v) => icp('disqualifiers', v)} placeholder="Government body, competitor…" /><small>A lead that matches any of these is never contacted.</small></label>
      </section>

      <section className="card stack">
        <div className="row-flex between"><div className="label">Scoring weights</div><span className="small muted">Total {Object.values(weights).reduce((a, b) => a + b, 0)} · normalised automatically</span></div>
        <p className="small muted" style={{ margin: 0 }}>How much each ICP criterion counts towards the fit score. Unknown criteria earn nothing but never count as a mismatch.</p>
        <div className="grid-2">
          {criteria.map((c) => (
            <label key={c.id} className="field"><span>{c.label} · <b>{weights[c.id]}</b></span>
              <input type="range" min={0} max={50} value={weights[c.id]} onChange={(e) => set('scoringWeights', { ...weights, [c.id]: Number(e.target.value) })} />
            </label>
          ))}
        </div>
      </section>

      <section className="card stack">
        <div className="label">Claims</div>
        <label className="field"><span>Approved claims (the only things agents may assert)</span><Chips value={p.approvedClaims} onChange={(v) => set('approvedClaims', v)} placeholder="We have shipped 40+ products…" /></label>
        <label className="field"><span>Prohibited phrases (force human review)</span><Chips value={p.prohibitedClaims} onChange={(v) => set('prohibitedClaims', v)} placeholder="guaranteed, #1, cheapest…" /></label>
      </section>

      <section className="card stack">
        <div className="row-flex between"><div className="label">Case studies</div><button className="btn ghost sm" onClick={() => set('caseStudies', [...p.caseStudies, { title: '', summary: '' }])}>Add</button></div>
        {p.caseStudies.map((c, i) => (
          <div key={i} className="grid-2">
            <label className="field"><span>Title</span><input className="input" value={c.title} onChange={(e) => set('caseStudies', p.caseStudies.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /></label>
            <label className="field"><span>Summary</span><input className="input" value={c.summary} onChange={(e) => set('caseStudies', p.caseStudies.map((x, j) => (j === i ? { ...x, summary: e.target.value } : x)))} /></label>
          </div>
        ))}
      </section>
      <div><button className="btn lg" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save business brain'}</button></div>
    </div>
  )
}

/* ------------------------------ policies ------------------------------ */

export function Policies() {
  const toast = useToast()
  const { org } = useAuth()
  const { data, reload } = useLoad(() => api<{ current: { version: number; config: PolicyConfig }; versions: { version: number; createdAt: string }[] }>('/v1/policies'), [org?.id])
  const [c, setC] = useState<PolicyConfig | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (data) setC(structuredClone(data.current.config)) }, [data])
  if (!data || !c) return <Spinner label="Loading" />

  const o = c.outreach
  const setO = (patch: Partial<PolicyConfig['outreach']>) => setC({ ...c, outreach: { ...o, ...patch } })
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0))

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 900 }}>
      <PageHead index={`Autonomy · v${data.current.version}`} title={<>Draw the <span className="hl">lines.</span></>}>
        <button className="btn" disabled={busy} onClick={async () => {
          setBusy(true)
          try { await api('/v1/policies', { method: 'PUT', body: c }); toast('New policy version published'); reload() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
        }}>{busy ? 'Publishing…' : 'Publish policy'}</button>
      </PageHead>

      <section className="card stack">
        <div className="label">Outreach</div>
        <label className="check"><input type="checkbox" checked={o.enabled} onChange={(e) => setO({ enabled: e.target.checked })} /> Outreach enabled</label>
        <label className="check"><input type="checkbox" checked={o.autoSend} onChange={(e) => setO({ autoSend: e.target.checked })} />
          <span><b>Send automatically</b> when every rule passes. <span className="muted">Off = every email waits in Approvals.</span></span></label>
        <label className="check"><input type="checkbox" checked={o.requireConsentBasis} onChange={(e) => setO({ requireConsentBasis: e.target.checked })} /> Require a recorded consent basis per contact</label>
        <div className="grid-3">
          <label className="field"><span>New contacts / day</span><input className="input" type="number" min={0} value={o.maxNewContactsPerDay} onChange={(e) => setO({ maxNewContactsPerDay: num(e.target.value) })} /></label>
          <label className="field"><span>Emails / hour (all outreach)</span><input className="input" type="number" min={1} max={500} value={o.maxPerHour ?? 10} onChange={(e) => setO({ maxPerHour: Math.max(1, num(e.target.value)) })} /></label>
          <label className="field"><span>Max follow-ups</span><input className="input" type="number" min={0} max={10} value={o.maxFollowUps} onChange={(e) => setO({ maxFollowUps: num(e.target.value) })} /></label>
          <label className="field"><span>Hours between follow-ups</span><input className="input" type="number" min={1} value={o.minimumFollowUpIntervalHours} onChange={(e) => setO({ minimumFollowUpIntervalHours: Math.max(1, num(e.target.value)) })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={o.quietHours.enabled} onChange={(e) => setO({ quietHours: { ...o.quietHours, enabled: e.target.checked } })} /> Quiet hours (no outreach sent)</label>
        {o.quietHours.enabled && (
          <div className="grid-3">
            <label className="field"><span>From</span><input className="input" type="time" value={o.quietHours.start} onChange={(e) => setO({ quietHours: { ...o.quietHours, start: e.target.value } })} /></label>
            <label className="field"><span>Until</span><input className="input" type="time" value={o.quietHours.end} onChange={(e) => setO({ quietHours: { ...o.quietHours, end: e.target.value } })} /></label>
            <label className="field"><span>Timezone</span><input className="input" value={o.quietHours.timezone} onChange={(e) => setO({ quietHours: { ...o.quietHours, timezone: e.target.value } })} /></label>
          </div>
        )}
      </section>

      <section className="card stack">
        <div className="label">Qualification & pricing</div>
        <div className="grid-3">
          <label className="field"><span>Qualified at fit ≥</span><input className="input" type="number" min={0} max={100} value={c.qualification.minimumScore} onChange={(e) => setC({ ...c, qualification: { ...c.qualification, minimumScore: Math.min(100, num(e.target.value)) } })} /></label>
          <label className="field"><span>…and evidence coverage ≥ (%)</span><input className="input" type="number" min={0} max={100} value={c.qualification.minimumEvidenceCoverage ?? 60} onChange={(e) => setC({ ...c, qualification: { ...c.qualification, minimumEvidenceCoverage: Math.min(100, num(e.target.value)) } })} /></label>
          <label className="field"><span>Review threshold (fit)</span><input className="input" type="number" min={0} max={100} value={c.qualification.reviewScore ?? 50} onChange={(e) => setC({ ...c, qualification: { ...c.qualification, reviewScore: Math.min(100, num(e.target.value)) } })} /></label>
          <label className="field"><span>Currency</span><input className="input" maxLength={3} value={c.pricing.currency} onChange={(e) => setC({ ...c, pricing: { ...c.pricing, currency: e.target.value.toUpperCase() } })} /></label>
          <label className="field"><span>Max discount without approval (%)</span><input className="input" type="number" min={0} max={100} value={c.pricing.maximumDiscountPercent} onChange={(e) => setC({ ...c, pricing: { ...c.pricing, maximumDiscountPercent: Math.min(100, Number(e.target.value) || 0) } })} /></label>
          <label className="field"><span>Minimum deal value</span><input className="input" type="number" min={0} value={c.pricing.minimumDealValueMinor / 100} onChange={(e) => setC({ ...c, pricing: { ...c.pricing, minimumDealValueMinor: num(e.target.value) * 100 } })} /></label>
          <label className="field"><span>Maximum deal value</span><input className="input" type="number" min={0} value={(c.pricing.maximumDealValueMinor ?? 0) / 100} onChange={(e) => setC({ ...c, pricing: { ...c.pricing, maximumDealValueMinor: num(e.target.value) * 100 } })} /></label>
          <label className="field"><span>Tax (%)</span><input className="input" type="number" min={0} max={100} step={0.01} value={(c.pricing.taxBasisPoints ?? 0) / 100} onChange={(e) => setC({ ...c, pricing: { ...c.pricing, taxBasisPoints: Math.min(10000, Math.round((Number(e.target.value) || 0) * 100)) } })} /></label>
          <label className="field"><span>Proposals valid for (days)</span><input className="input" type="number" min={1} max={180} value={c.pricing.proposalValidityDays ?? 30} onChange={(e) => setC({ ...c, pricing: { ...c.pricing, proposalValidityDays: Math.min(180, Math.max(1, num(e.target.value))) } })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={c.proposals.autoSend} onChange={(e) => setC({ ...c, proposals: { autoSend: e.target.checked } })} /> Send in-policy proposals without approval</label>
      </section>

      <section className="card stack">
        <div className="label">AI budget</div>
        <label className="field" style={{ maxWidth: 280 }}><span>Max AI calls per day</span><input className="input" type="number" min={0} value={c.budgets.maxLlmCallsPerDay} onChange={(e) => setC({ ...c, budgets: { maxLlmCallsPerDay: num(e.target.value) } })} /><small>Runs stop (and are marked failed) when the budget is used up.</small></label>
      </section>

      {c.prototypes && <section className="card stack">
        <div className="label">Demo prototypes</div>
        <label className="check"><input type="checkbox" checked={c.prototypes.enabled} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, enabled: e.target.checked } })} /> Allow demo builds from approved templates</label>
        <label className="check"><input type="checkbox" checked={c.prototypes.autoBuild} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, autoBuild: e.target.checked } })} /> Build without approval when inside budget</label>
        <div className="grid-3">
          <label className="field"><span>Cost per attempt</span><input className="input" type="number" min={0} value={c.prototypes.costPerAttemptMinor / 100} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, costPerAttemptMinor: num(e.target.value) * 100 } })} /></label>
          <label className="field"><span>Attempts (incl. repairs)</span><input className="input" type="number" min={1} max={3} value={c.prototypes.maxAttempts} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, maxAttempts: Math.min(3, Math.max(1, num(e.target.value))) } })} /></label>
          <label className="field"><span>Preview link lifetime (days)</span><input className="input" type="number" min={1} max={30} value={c.prototypes.previewDays} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, previewDays: Math.min(30, Math.max(1, num(e.target.value))) } })} /></label>
          <label className="field"><span>Limit per prototype</span><input className="input" type="number" min={0} value={c.prototypes.maxPerPrototypeMinor / 100} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, maxPerPrototypeMinor: num(e.target.value) * 100 } })} /><small>Above this a human approves the build.</small></label>
          <label className="field"><span>Monthly budget</span><input className="input" type="number" min={0} value={c.prototypes.monthlyBudgetMinor / 100} onChange={(e) => setC({ ...c, prototypes: { ...c.prototypes, monthlyBudgetMinor: num(e.target.value) * 100 } })} /><small>Builds are refused once it is used up.</small></label>
        </div>
      </section>}

      <section className="card stack">
        <div className="label">Data retention</div>
        <div className="grid-2">
          <label className="field"><span>Delete message bodies after (days)</span><input className="input" type="number" min={30} max={3650} value={c.retention?.messageDays ?? 365} onChange={(e) => setC({ ...c, retention: { ...(c.retention ?? { auditDays: 730 }), messageDays: Math.max(30, num(e.target.value)) } })} /></label>
          <label className="field"><span>Delete audit events after (days)</span><input className="input" type="number" min={90} max={3650} value={c.retention?.auditDays ?? 730} onChange={(e) => setC({ ...c, retention: { ...(c.retention ?? { messageDays: 365 }), auditDays: Math.max(90, num(e.target.value)) } })} /></label>
        </div>
      </section>

      <section className="stack">
        <div className="label">Version history</div>
        <div className="chips">{data.versions.map((v) => <span key={v.version} className="tag">v{v.version} · {ago(v.createdAt)}</span>)}</div>
      </section>
    </div>
  )
}

/* -------------------------------- team -------------------------------- */

const ROLES: Role[] = ['owner', 'admin', 'sales_manager', 'sales_rep', 'developer', 'viewer']

export function Team() {
  const toast = useToast()
  const { org } = useAuth()
  const { data, error, reload } = useLoad(() => api<{ members: { _id: string; email: string; name: string | null; role: Role; status: string }[] }>('/v1/organization/members'), [org?.id])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('sales_rep')
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); reload() } catch (e) { toast((e as Error).message, true) } }

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 900 }}>
      <PageHead index="Team" title={<>People with <span className="hl">keys.</span></>} />
      {error ? <Empty title="Only owners and admins manage the team." /> : <>
        <form className="card row-flex" onSubmit={(e) => { e.preventDefault(); act(() => api('/v1/organization/members', { body: { email, role } }).then(() => setEmail('')), 'Invitation sent') }}>
          <input className="input" style={{ flex: 2, minWidth: 220 }} type="email" required placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="select" style={{ flex: 1, minWidth: 160 }} value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{human(r)}</option>)}</select>
          <button className="btn">Invite</button>
        </form>
        {!data ? <Spinner /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Member</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>{data.members.map((m) => (
              <tr key={m._id}>
                <td>{m.name ?? '—'}<div className="small muted mono">{m.email}</div></td>
                <td><select className="select" style={{ width: 170 }} value={m.role} onChange={(e) => act(() => api(`/v1/organization/members/${m._id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated')}>{ROLES.map((r) => <option key={r} value={r}>{human(r)}</option>)}</select></td>
                <td><Badge status={m.status === 'active' ? 'ok' : 'pending'}>{m.status}</Badge></td>
                <td style={{ textAlign: 'right' }}><button className="linkish" onClick={() => window.confirm(`Remove ${m.email}?`) && act(() => api(`/v1/organization/members/${m._id}`, { method: 'DELETE' }), 'Removed')}>Remove</button></td>
              </tr>
            ))}</tbody></table></div>
        )}
      </>}
    </div>
  )
}

/* ---------------------------- suppressions ---------------------------- */

export function Suppressions() {
  const toast = useToast()
  const { org } = useAuth()
  const { data, reload } = useLoad(() => api<{ suppressions: { _id: string; value: string; reason: string; source?: string; createdAt: string }[] }>('/v1/suppressions'), [org?.id])
  const [value, setValue] = useState('')
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); reload() } catch (e) { toast((e as Error).message, true) } }
  return (
    <div className="stack lg fade-in" style={{ maxWidth: 900 }}>
      <PageHead index="Do-not-contact" title={<>Stop <span className="hl">means stop.</span></>} />
      <p className="muted" style={{ margin: 0, maxWidth: 640 }}>Addresses here are never emailed again, by agents or humans. Opt-outs are added automatically the moment someone asks.</p>
      <form className="card row-flex" onSubmit={(e) => { e.preventDefault(); act(() => api('/v1/suppressions', { body: { value } }).then(() => setValue('')), 'Suppressed') }}>
        <input className="input" style={{ flex: 1, minWidth: 220 }} type="email" required placeholder="someone@company.com" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn">Add</button>
      </form>
      {!data ? <Spinner /> : !data.suppressions.length ? <Empty title="Nobody has opted out." /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Address</th><th>Reason</th><th>Since</th><th /></tr></thead>
          <tbody>{data.suppressions.map((s) => (
            <tr key={s._id}><td className="mono">{s.value}</td><td><Badge status={s.reason === 'manual' ? '' : 'bad'}>{human(s.reason)}</Badge></td><td className="small muted">{ago(s.createdAt)}</td>
              <td style={{ textAlign: 'right' }}><button className="linkish" onClick={() => window.confirm(`Allow contacting ${s.value} again?`) && act(() => api(`/v1/suppressions/${s._id}`, { method: 'DELETE' }), 'Removed')}>Remove</button></td></tr>
          ))}</tbody></table></div>
      )}
    </div>
  )
}

/* -------------------------------- audit ------------------------------- */

export function Audit() {
  const { org } = useAuth()
  const { data, error } = useLoad(() => api<{ events: AuditEvent[] }>('/v1/audit-events?limit=100'), [org?.id])
  return (
    <div className="stack lg fade-in">
      <PageHead index="Audit log" title={<>Who did what, <span className="hl">and why.</span></>} />
      {error ? <Empty title="You don't have access to the audit log." /> : !data ? <Spinner /> : !data.events.length ? <Empty title="No events yet." /> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Decision</th><th>Outcome</th><th>Policy</th><th>Details</th></tr></thead>
          <tbody>{data.events.map((e) => (
            <tr key={e._id}>
              <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleString()}</td>
              <td className="mono">{e.action}</td>
              <td className="small">{e.actorType}:{e.actorId.length > 12 ? `${e.actorId.slice(0, 8)}…` : e.actorId}</td>
              <td>{e.decision ? <Badge status={e.decision} /> : '—'}</td>
              <td><Badge status={e.outcome} /></td>
              <td className="mono">{e.policyVersion ? `v${e.policyVersion}` : '—'}</td>
              <td className="small muted" style={{ maxWidth: 360 }}>{Array.isArray(e.metadata?.reasons) ? (e.metadata!.reasons as string[]).join('; ') : e.metadata?.to ? String(e.metadata.to) : ''}</td>
            </tr>
          ))}</tbody></table></div>
      )}
    </div>
  )
}

/* -------------------------------- usage ------------------------------- */

interface UsageRow { _id: string | null; calls: number; inputTokens: number; outputTokens: number }

export function Usage() {
  const { org } = useAuth()
  const { data, error } = useLoad(() => api<{ byAgent: UsageRow[]; byModel: UsageRow[]; byDay: UsageRow[] }>('/v1/usage/summary'), [org?.id])
  if (error) return <Empty title="You don't have access to usage." />
  if (!data) return <Spinner />
  const total = data.byAgent.reduce((a, r) => ({ calls: a.calls + r.calls, tokens: a.tokens + r.inputTokens + r.outputTokens }), { calls: 0, tokens: 0 })
  const max = Math.max(1, ...data.byDay.map((d) => d.calls))
  const table = (rows: UsageRow[], label: string) => (
    <div className="card stack"><div className="label">{label}</div>
      {rows.length === 0 ? <span className="small muted">No usage yet.</span> : rows.map((r) => (
        <div key={r._id ?? 'none'} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <span className="mono">{r._id ?? '—'}</span><span className="muted">{r.calls} calls · {(r.inputTokens + r.outputTokens).toLocaleString()} tokens</span>
        </div>
      ))}
    </div>
  )
  return (
    <div className="stack lg fade-in">
      <PageHead index="AI usage · 30 days" title={<>What the agents <span className="hl">cost.</span></>} />
      <div className="grid-3">
        <div className="card"><div className="label">Calls</div><div className="score" style={{ marginTop: 10 }}>{total.calls}</div></div>
        <div className="card"><div className="label">Tokens</div><div className="score" style={{ marginTop: 10 }}>{total.tokens.toLocaleString()}</div></div>
        <div className="card"><div className="label">Avg tokens / call</div><div className="score" style={{ marginTop: 10 }}>{total.calls ? Math.round(total.tokens / total.calls).toLocaleString() : 0}</div></div>
      </div>
      <div className="card stack">
        <div className="label">Calls per day</div>
        {data.byDay.length === 0 ? <span className="small muted">No usage yet.</span> : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140 }} role="img" aria-label="AI calls per day">
            {data.byDay.map((d) => <div key={d._id} title={`${d._id}: ${d.calls} calls`} style={{ flex: 1, minWidth: 6, height: `${(d.calls / max) * 100}%`, background: 'var(--ink)', borderRadius: 4 }} />)}
          </div>
        )}
      </div>
      <div className="grid-2">{table(data.byAgent, 'By agent')}{table(data.byModel, 'By model')}</div>
    </div>
  )
}
