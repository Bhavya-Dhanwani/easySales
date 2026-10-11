import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api } from '../lib/api'
import { ago, human } from '../lib/format'
import { useAuth } from '../lib/auth'
import { Badge, PageHead, Spinner, useLoad, useToast } from '../components/ui'

interface Integration {
  kind: string; provider: string; status: string; account?: string; scopes: string[]; lastHealthCheckAt: string | null; lastSyncAt?: string | null; lastError?: string | null
  settings?: { stageOwner?: string; timezone?: string; workStart?: string; workEnd?: string; workDays?: number[]; meetingMinutes?: number; bufferMinutes?: number; minNoticeHours?: number }
}
interface SyncStatus { lastSyncAt: string | null; checkpoints: Record<string, string>; mapped: { entityType: string; status: string; count: number }[]; syncRunning: boolean; pendingPushes: number; pendingEvents: number }
interface SyncError { kind: string; id: string; at: string; message: string; action: string }

const tone = (s: string) => (s === 'connected' ? 'approved' : s === 'degraded' ? 'failed' : 'plain')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function HubSpotCard({ i, ownership, onChange }: { i: Integration; ownership: { field: string; owner: string }[]; onChange: () => void }) {
  const toast = useToast()
  const connected = i.status !== 'disconnected'
  const { data, reload } = useLoad(async () => connected ? {
    status: (await api<{ status: SyncStatus }>('/v1/integrations/hubspot/sync-status')).status,
    errors: (await api<{ errors: SyncError[] }>('/v1/integrations/hubspot/errors')).errors,
  } : null, [i.status], (d) => Boolean(d?.status?.syncRunning))
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); onChange(); reload() } catch (e) { toast((e as Error).message, true) } }
  return (
    <section className="card stack">
      <div className="row-flex between">
        <span className="row-flex"><span className="h2">HubSpot CRM</span><Badge status={tone(i.status)}>{i.status}</Badge>{i.account && <span className="small muted">{i.account}</span>}</span>
        <span className="row-flex">
          {!connected || i.status === 'degraded'
            ? <button className="btn sm" onClick={() => run(async () => { window.location.href = (await api<{ authorizeUrl: string }>('/v1/integrations/hubspot/connect', { method: 'POST' })).authorizeUrl }, 'Opening HubSpot…')}>{i.status === 'degraded' ? 'Reconnect' : 'Connect'}</button>
            : <button className="btn sm" disabled={data?.status?.syncRunning} onClick={() => run(() => api('/v1/integrations/hubspot/sync', { method: 'POST' }), 'Sync started')}>{data?.status?.syncRunning ? <><span className="spinner" /> Syncing…</> : 'Sync now'}</button>}
          {connected && <button className="linkish" style={{ color: 'var(--bad)' }} onClick={() => window.confirm('Disconnect HubSpot? Access is revoked and stored tokens deleted. Records stay.') && run(() => api('/v1/integrations/hubspot', { method: 'DELETE' }), 'Disconnected')}>Disconnect</button>}
        </span>
      </div>
      <span className="small muted">Contacts and companies come in without duplicates (matched by HubSpot id, then email). Qualified leads, deals and stage changes go out automatically. Imported contacts are never emailed until you record a consent basis.</span>
      {i.lastError && <div className="small form-error">{i.lastError}</div>}
      {connected && data?.status && <>
        <div className="row-flex small" style={{ flexWrap: 'wrap' }}>
          <span>Last sync <b>{data.status.lastSyncAt ? ago(data.status.lastSyncAt) : 'never'}</b></span>
          {data.status.mapped.filter((m) => m.status === 'success').map((m) => <span key={m.entityType} className="badge plain">{m.count} {m.entityType}s linked</span>)}
          {data.status.pendingPushes > 0 && <span className="badge plain">{data.status.pendingPushes} updates queued</span>}
          {data.status.pendingEvents > 0 && <span className="badge plain">{data.status.pendingEvents} webhook events pending</span>}
        </div>
        <label className="field" style={{ maxWidth: 360 }}><span>Who owns the pipeline stage?</span>
          <select className="select" value={i.settings?.stageOwner ?? 'platform'} onChange={(e) => run(() => api('/v1/integrations/hubspot/settings', { method: 'PATCH', body: { stageOwner: e.target.value } }), 'Saved')}>
            <option value="platform">easySales (we update the deal stage)</option>
            <option value="crm">HubSpot (stage changes there flow back here)</option>
          </select>
        </label>
        <details><summary className="small muted">Field ownership: who wins when both sides change</summary>
          <div className="stack sm" style={{ marginTop: 8 }}>{ownership.map((o) => <div key={o.field} className="row-flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 4 }}><span>{o.field}</span><span className="mono">{o.owner}</span></div>)}</div>
        </details>
        {data.errors.length > 0 && (
          <div className="stack sm">
            <span className="label">Needs attention</span>
            {data.errors.slice(0, 8).map((e) => <div key={e.kind + e.id} className="small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}><b>{human(e.kind)}</b> · {e.message} <span className="muted">→ {e.action}</span></div>)}
          </div>
        )}
      </>}
    </section>
  )
}

function CalendarCard({ i, onChange }: { i: Integration; onChange: () => void }) {
  const toast = useToast()
  const connected = i.status !== 'disconnected'
  const s = i.settings ?? {}
  const [f, setF] = useState({ timezone: s.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, workStart: s.workStart ?? '10:00', workEnd: s.workEnd ?? '18:00', workDays: s.workDays ?? [1, 2, 3, 4, 5], meetingMinutes: s.meetingMinutes ?? 30, bufferMinutes: s.bufferMinutes ?? 15, minNoticeHours: s.minNoticeHours ?? 12 })
  const { data: av, reload } = useLoad(async () => connected && i.status === 'connected' ? api<{ timezone: string; slots: { start: string; label: string }[] }>('/v1/calendar/availability?days=5').catch(() => null) : null, [i.status])
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); onChange(); reload() } catch (e) { toast((e as Error).message, true) } }
  return (
    <section className="card stack">
      <div className="row-flex between">
        <span className="row-flex"><span className="h2">Google Calendar</span><Badge status={tone(i.status)}>{i.status}</Badge>{i.account && <span className="small muted">{i.account}</span>}</span>
        <span className="row-flex">
          {(!connected || i.status === 'degraded') && <button className="btn sm" onClick={() => run(async () => { window.location.href = (await api<{ authorizeUrl: string }>('/v1/integrations/google_calendar/connect', { method: 'POST' })).authorizeUrl }, 'Opening Google…')}>{i.status === 'degraded' ? 'Reconnect' : 'Connect'}</button>}
          {connected && <button className="linkish" style={{ color: 'var(--bad)' }} onClick={() => window.confirm('Disconnect Google Calendar?') && run(() => api('/v1/integrations/google_calendar', { method: 'DELETE' }), 'Disconnected')}>Disconnect</button>}
        </span>
      </div>
      <span className="small muted">The agents only ever offer times that are free on your calendar. Bookings are re-checked at the last moment; cancellations and moves you make in Google Calendar are picked up automatically.</span>
      {connected && <>
        <div className="grid-4">
          <label className="field"><span>Timezone</span><input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></label>
          <label className="field"><span>From</span><input className="input" type="time" value={f.workStart} onChange={(e) => setF({ ...f, workStart: e.target.value })} /></label>
          <label className="field"><span>Until</span><input className="input" type="time" value={f.workEnd} onChange={(e) => setF({ ...f, workEnd: e.target.value })} /></label>
          <label className="field"><span>Meeting (min)</span><input className="input" type="number" min={10} max={240} value={f.meetingMinutes} onChange={(e) => setF({ ...f, meetingMinutes: Number(e.target.value) })} /></label>
        </div>
        <div className="row-flex">{DAYS.map((d, n) => <label key={d} className="check"><input type="checkbox" checked={f.workDays.includes(n)} onChange={(e) => setF({ ...f, workDays: e.target.checked ? [...f.workDays, n].sort() : f.workDays.filter((x) => x !== n) })} /> {d}</label>)}</div>
        <div className="row-flex">
          <label className="field" style={{ width: 160 }}><span>Buffer (min)</span><input className="input" type="number" min={0} value={f.bufferMinutes} onChange={(e) => setF({ ...f, bufferMinutes: Number(e.target.value) })} /></label>
          <label className="field" style={{ width: 160 }}><span>Notice (hours)</span><input className="input" type="number" min={0} value={f.minNoticeHours} onChange={(e) => setF({ ...f, minNoticeHours: Number(e.target.value) })} /></label>
          <button className="btn sm" onClick={() => run(() => api('/v1/integrations/google_calendar/settings', { method: 'PATCH', body: f }), 'Saved')}>Save hours</button>
        </div>
        {av && <div className="small"><span className="label">Next free slots · </span>{av.slots.slice(0, 4).map((x) => x.label).join(' · ') || 'none in the next 5 days'}</div>}
      </>}
    </section>
  )
}

// one place for every connected system: status, sync state and what needs attention
export default function Integrations() {
  const toast = useToast()
  const { org } = useAuth()
  const [params, setParams] = useSearchParams()
  const { data, reload } = useLoad(() => api<{ integrations: Integration[]; fieldOwnership: { field: string; owner: string }[] }>('/v1/integrations'), [org?.id])
  useEffect(() => {
    if (params.get('connected')) toast(`${human(params.get('connected')!)} connected`)
    if (params.get('error')) toast(`Connection failed: ${params.get('error')}`, true)
    if (params.get('connected') || params.get('error')) setParams({}, { replace: true })
  }, [params, setParams, toast])
  if (!data) return <Spinner label="Loading integrations" />
  const by = (p: string) => data.integrations.find((i) => i.provider === p)!
  const email = by('email')
  return (
    <div className="stack lg fade-in">
      <PageHead index="Integrations" title={<>Work inside the tools <span className="hl">you already use.</span></>} />
      <section className="card row-flex between">
        <span className="row-flex"><span className="h2">Email</span><Badge status={tone(email.status)}>{email.status}</Badge></span>
        <Link className="btn ghost sm" to="/app/email">Manage mailbox</Link>
      </section>
      <HubSpotCard i={by('hubspot')} ownership={data.fieldOwnership} onChange={reload} />
      <CalendarCard i={by('google_calendar')} onChange={reload} />
    </div>
  )
}
