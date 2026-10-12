import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
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
  const nav = useNavigate()
  const { data, error, reload } = useLoad(() => api<{ integration: EmailIntegration | null; platform: { from: string; name: string; readsReplies: boolean } | null }>('/v1/integrations/email'), [org?.id])
  const [form, setForm] = useState({ fromName: '', fromEmail: '', replyTo: '', host: '', port: 587, secure: false, user: '', password: '', readInbox: true, imapHost: '' })
  const [advanced, setAdvanced] = useState(false)
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
      // simple mode: just the email and app password; the server finds the mail servers
      const body = advanced
        ? { ...form, fromName: form.fromName || undefined, replyTo: form.replyTo || undefined, imapHost: form.imapHost || undefined, user: form.user || undefined }
        : { fromEmail: form.fromEmail, password: form.password, fromName: form.fromName || undefined, readInbox: form.readInbox }
      const r = await api<{ webhookSecret: string }>('/v1/integrations/email/connect', { body })
      setSecret(r.webhookSecret)
      setForm({ ...form, password: '' })
    }, 'Email account connected')
  }

  if (error) return <div className="empty"><p className="h2">Only owners and admins manage email accounts.</p></div>
  if (!data) return <Spinner label="Loading" />
  const i = data.integration
  const platform = data.platform
  const domain = form.fromEmail.split('@')[1]?.toLowerCase() ?? ''
  const help = /gmail|googlemail/.test(domain) ? ['Create a Gmail app password', 'https://myaccount.google.com/apppasswords']
    : /outlook|hotmail|live\.com/.test(domain) ? ['Create an Outlook app password', 'https://account.live.com/proofs/AppPassword']
    : /yahoo/.test(domain) ? ['Create a Yahoo app password', 'https://login.yahoo.com/account/security/app-passwords']
    : /zoho/.test(domain) ? ['Create a Zoho app password', 'https://accounts.zoho.com/home#security/app_password'] : null

  return (
    <div className="stack lg fade-in" style={{ maxWidth: 860 }}>
      <PageHead index="Email account" title={<>Where your emails <span className="hl">come from.</span></>} />
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
      ) : platform ? (
        <div className="card stack">
          <div className="row-flex between">
            <div>
              <div className="h2">Sending from easySales mail</div>
              <div className="small muted">{platform.name} &lt;{platform.from}&gt;</div>
            </div>
            <Badge status="ok">ready</Badge>
          </div>
          <p className="small muted" style={{ margin: 0 }}>{platform.readsReplies ? 'Replies come back here automatically and the agent answers them.' : 'Replies go to the easySales address.'} Connect your own mailbox below if you want emails to come from your address instead. It's optional.</p>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>Connect the mailbox your outreach should come from. We sign in once to verify, then store the password encrypted; it is never shown again.</p>
      )}

      <form className="card stack" onSubmit={connect}>
        <div className="h2">{i ? 'Replace your email' : platform ? 'Use your own email (optional)' : 'Connect your email'}</div>
        <div className="grid-3">
          <label className="field"><span>Your email *</span><input className="input" type="email" required value={form.fromEmail} onChange={set('fromEmail')} placeholder="you@yourbusiness.com" autoComplete="email" /></label>
          <label className="field"><span>App password *</span><input className="input" type="password" required autoComplete="new-password" value={form.password} onChange={set('password')} />
            <small>Not your normal password. {help ? <a href={help[1]} target="_blank" rel="noopener noreferrer">{help[0]}</a> : 'Most providers call it an "app password".'}</small></label>
          <label className="field"><span>Sender name (optional)</span><input className="input" value={form.fromName} onChange={set('fromName')} placeholder="Priya at Pixel Forge" /></label>
        </div>
        <label className="check"><input type="checkbox" checked={form.readInbox} onChange={set('readInbox')} /> Let the agent read replies from this inbox (read-only; only replies from your leads are opened)</label>
        <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>{advanced ? 'Hide' : 'Show'} advanced settings</button>
        {advanced && (
          <div className="stack">
            <p className="small muted" style={{ margin: 0 }}>Only if detection fails: fill in your provider's server settings.</p>
            <div className="grid-3">
              <label className="field"><span>Provider preset</span>
                <select className="select" defaultValue="" onChange={(e) => { const p = PRESETS.find(([n]) => n === e.target.value); if (p) setForm({ ...form, host: p[1], port: p[2] }) }}>
                  <option value="">Choose…</option>
                  {PRESETS.map(([n]) => <option key={n}>{n}</option>)}
                </select>
              </label>
              <label className="field"><span>SMTP host</span><input className="input" required value={form.host} onChange={set('host')} placeholder="smtp.yourprovider.com" /></label>
              <label className="field"><span>Port</span>
                <select className="select" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value), secure: e.target.value === '465' })}>{[587, 465, 2525, 25].map((p) => <option key={p}>{p}</option>)}</select>
              </label>
              <label className="field"><span>Username (if not your email)</span><input className="input" autoComplete="off" value={form.user} onChange={set('user')} /></label>
              <label className="field"><span>Reply-to (optional)</span><input className="input" type="email" value={form.replyTo} onChange={set('replyTo')} /></label>
              <label className="field"><span>IMAP host (optional)</span><input className="input" value={form.imapHost} onChange={set('imapHost')} placeholder={form.host ? form.host.replace(/^(smtp|mail)\./, 'imap.') : 'imap.yourprovider.com'} /></label>
            </div>
          </div>
        )}
        <div className="row-flex">
          <button className="btn lime" disabled={busy}>{busy ? 'Checking…' : i ? 'Replace email' : 'Connect my email'}</button>
          {!i && platform && <button type="button" className="btn ghost" onClick={() => nav('/app')}>Skip, use easySales mail</button>}
        </div>
      </form>
    </div>
  )
}
