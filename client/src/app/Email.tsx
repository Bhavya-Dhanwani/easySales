import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { ago } from '../lib/format'
import type { EmailIntegration } from '../lib/types'
import { Badge, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

const PRESETS = [
  ['Gmail / Google Workspace', 'smtp.gmail.com', 587],
  ['Outlook / Microsoft 365', 'smtp.office365.com', 587],
  ['Zoho Mail', 'smtp.zoho.in', 587],
  ['Amazon SES', 'email-smtp.ap-south-1.amazonaws.com', 587],
] as const

// shows the one-time webhook secret with a copy button
function SecretOnce({ secret, url }: { secret: string; url: string }) {
  const toast = useToast()
  const copy = (v: string) => navigator.clipboard.writeText(v).then(() => toast('Copied'))
  return (
    <div className="card stack" style={{ borderColor: 'var(--lime-2)', background: 'rgba(200,241,105,.12)' }}>
      <div className="h3">Save this webhook secret now — it is shown only once</div>
      <p className="small muted" style={{ margin: 0 }}>Optional when replies are read from the inbox; needed for delivery and bounce events. Point your mail provider's inbound / event webhook at the URL below and sign each request body with HMAC-SHA256 using this secret (header <span className="mono">X-EasySales-Signature</span>).</p>
      <div className="row-flex"><code className="mono" style={{ flex: 1, overflowWrap: 'anywhere' }}>{url}</code><button className="btn sm ghost" onClick={() => copy(url)}>Copy URL</button></div>
      <div className="row-flex"><code className="mono" style={{ flex: 1, overflowWrap: 'anywhere' }}>{secret}</code><button className="btn sm" onClick={() => copy(secret)}>Copy secret</button></div>
    </div>
  )
}

export default function Email() {
  const { org } = useAuth()
  const toast = useToast()
  const { data, error, reload } = useLoad(() => api<{ integration: EmailIntegration | null }>('/v1/integrations/email'), [org?.id])
  const [form, setForm] = useState({ fromName: '', fromEmail: '', replyTo: '', host: '', port: 587, secure: false, user: '', password: '', readInbox: true, imapHost: '' })
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : k === 'port' ? Number(e.target.value) : e.target.value })

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast(ok); await reload() } catch (e) { toast((e as Error).message, true) } finally { setBusy(false) }
  }

  async function connect(e: FormEvent) {
    e.preventDefault()
    await run(async () => {
      const r = await api<{ webhookSecret: string }>('/v1/integrations/email/connect', { body: { ...form, replyTo: form.replyTo || undefined, imapHost: form.imapHost || undefined } })
      setSecret(r.webhookSecret)
      setForm({ ...form, password: '' })
    }, 'Email account connected')
  }

  if (error) return <div className="empty"><p className="h2">Only owners and admins manage email accounts.</p></div>
  if (!data) return <Spinner label="Loading" />
  const i = data.integration

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 860 }}>
      <PageHead index="Email account" title={<>Send from <span className="hl">your own address.</span></>} />
      {secret && i && <SecretOnce secret={secret} url={i.webhookUrl} />}

      {i ? (
        <div className="card stack">
          <div className="row-flex between">
            <div>
              <div className="h2">{i.fromName} &lt;{i.fromEmail}&gt;</div>
              <div className="small muted">{i.smtp.user} · {i.smtp.host}:{i.smtp.port}{i.replyTo ? ` · replies to ${i.replyTo}` : ''}</div>
            </div>
            <Badge status={i.status === 'connected' ? 'ok' : 'failed'}>{i.status}</Badge>
          </div>
          {i.lastError && <div className="form-error small">{i.lastError}</div>}
          {i.imap?.lastError && <div className="form-error small">Reading the inbox failed: {i.imap.lastError}</div>}
          <dl className="kv">
            <dt>Last verified</dt><dd>{ago(i.lastVerifiedAt)}</dd>
            <dt>Replies</dt><dd>{i.imap?.enabled ? <>read from the inbox at {i.imap.host} · checked {i.imap.lastPolledAt ? ago(i.imap.lastPolledAt) : 'soon'}</> : 'only through the webhook below'}</dd>
            <dt>Webhook URL</dt><dd className="mono">{i.webhookUrl}</dd>
          </dl>
          <div className="row-flex">
            <button className="btn ghost sm" disabled={busy} onClick={() => run(() => api('/v1/integrations/email/test', { method: 'POST' }), 'Checked the connection')}>Test connection</button>
            <button className="btn ghost sm" disabled={busy} onClick={() => run(async () => setSecret((await api<{ webhookSecret: string }>('/v1/integrations/email/rotate-secret', { method: 'POST' })).webhookSecret), 'New webhook secret created')}>Rotate webhook secret</button>
            <button className="btn danger sm" disabled={busy} onClick={() => window.confirm('Disconnect this account? Outreach stops until you connect another.') && run(() => api('/v1/integrations/email', { method: 'DELETE' }), 'Disconnected')}>Disconnect</button>
          </div>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>Connect the mailbox your outreach should come from. We sign in once to verify, then store the password encrypted; it is never shown again.</p>
      )}

      <form className="card stack" onSubmit={connect}>
        <div className="row-flex between"><div className="h2">{i ? 'Replace account' : 'Connect via SMTP'}</div>
          <select className="select" style={{ width: 240 }} defaultValue="" aria-label="Provider preset" onChange={(e) => { const p = PRESETS.find(([n]) => n === e.target.value); if (p) setForm({ ...form, host: p[1], port: p[2] }) }}>
            <option value="">Provider preset…</option>
            {PRESETS.map(([n]) => <option key={n}>{n}</option>)}
          </select>
        </div>
        <div className="grid-3">
          <label className="field"><span>Sender name</span><input className="input" required value={form.fromName} onChange={set('fromName')} placeholder="Priya at Pixel Forge" /></label>
          <label className="field"><span>Sender email</span><input className="input" type="email" required value={form.fromEmail} onChange={set('fromEmail')} /></label>
          <label className="field"><span>Reply-to (optional)</span><input className="input" type="email" value={form.replyTo} onChange={set('replyTo')} /></label>
          <label className="field"><span>SMTP host</span><input className="input" required value={form.host} onChange={set('host')} placeholder="smtp.gmail.com" /></label>
          <label className="field"><span>Port</span>
            <select className="select" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value), secure: e.target.value === '465' })}>{[587, 465, 2525, 25].map((p) => <option key={p}>{p}</option>)}</select>
          </label>
          <label className="check" style={{ alignSelf: 'end', paddingBottom: 10 }}><input type="checkbox" checked={form.secure} onChange={set('secure')} /> TLS from the start (port 465)</label>
          <label className="field"><span>Username</span><input className="input" required autoComplete="off" value={form.user} onChange={set('user')} /></label>
          <label className="field"><span>Password / app password</span><input className="input" type="password" required autoComplete="new-password" value={form.password} onChange={set('password')} /><small>Gmail and Outlook need an app password.</small></label>
        </div>
        <label className="check"><input type="checkbox" checked={form.readInbox} onChange={set('readInbox')} /> Read replies from this inbox (IMAP, same login)</label>
        {form.readInbox && (
          <div className="grid-3">
            <label className="field"><span>IMAP host (optional)</span><input className="input" value={form.imapHost} onChange={set('imapHost')} placeholder={form.host ? form.host.replace(/^(smtp|mail)\./, 'imap.') : 'imap.gmail.com'} /><small>Left empty, it is worked out from the SMTP host.</small></label>
            <p className="small muted" style={{ gridColumn: 'span 2', margin: 0, alignSelf: 'center' }}>Checked every minute, read-only. Only replies from your leads are opened and stored; other mail is never downloaded. Turn IMAP on in Gmail or Outlook settings first.</p>
          </div>
        )}
        <div><button className="btn lime" disabled={busy}>{busy ? 'Verifying…' : 'Verify & connect'}</button></div>
      </form>
    </div>
  )
}
