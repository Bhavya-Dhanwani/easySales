import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { Logo, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'

function Shell({ index, title, children, foot }: { index: string; title: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <Link to="/" aria-label="Home"><Logo dark /></Link>
        <div>
          <p className="auth-quote">“Reason with AI.<br /><span className="serif">Authorize</span> with policy.<br />Execute with code.”</p>
          <p className="label" style={{ color: '#8b8b93', marginTop: 18 }}>The easySales operating model</p>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-box fade-in">
          <div className="label">{index}</div>
          <h1 className="h1" style={{ margin: '12px 0 28px' }}>{title}</h1>
          {children}
          {foot && <div className="small muted" style={{ marginTop: 22 }}>{foot}</div>}
        </div>
      </main>
    </div>
  )
}

function useSubmit() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { await fn() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return { busy, error, run }
}

export function Login() {
  const { login, user } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, run } = useSubmit()
  if (user) return <Navigate to={user.isVerified ? '/app' : '/verify'} replace />
  return (
    <Shell index="Log in" title={<>Welcome <span className="serif">back.</span></>}
      foot={<>New here? <Link to="/signup">Create a workspace</Link> · <Link to="/forgot">Forgot password</Link></>}>
      <form className="stack" onSubmit={run(async () => { const u = await login(email, password); nav(u.isVerified ? '/app' : '/verify') })}>
        <label className="field"><span>Email</span><input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn lg" disabled={busy}>{busy ? 'Signing in…' : 'Log in'}</button>
      </form>
    </Shell>
  )
}

export function Signup() {
  const { signup, user } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' })
  const { busy, error, run } = useSubmit()
  if (user) return <Navigate to={user.isVerified ? '/app' : '/verify'} replace />
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <Shell index="Start free" title={<>Hire your <span className="serif">AI sales team.</span></>}
      foot={<>Already have an account? <Link to="/login">Log in</Link></>}>
      <form className="stack" onSubmit={run(async () => {
        await signup({ ...form, organizationName: form.organizationName || undefined })
        nav('/verify')
      })}>
        <label className="field"><span>Your name</span><input className="input" required minLength={3} autoComplete="name" value={form.name} onChange={set('name')} /></label>
        <label className="field"><span>Business name</span><input className="input" placeholder="Pixel Forge Studio" value={form.organizationName} onChange={set('organizationName')} /></label>
        <label className="field"><span>Work email</span><input className="input" type="email" required autoComplete="email" value={form.email} onChange={set('email')} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" required minLength={8} autoComplete="new-password" value={form.password} onChange={set('password')} /><small>At least 8 characters.</small></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn lg" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button>
      </form>
    </Shell>
  )
}

export function Verify() {
  const { verify, user, ready } = useAuth()
  const nav = useNavigate()
  const toast = useToast()
  const [otp, setOtp] = useState('')
  const { busy, error, run } = useSubmit()
  if (ready && !user) return <Navigate to="/login" replace />
  if (user?.isVerified) return <Navigate to="/app" replace />
  return (
    <Shell index="Verify email" title={<>Check your <span className="serif">inbox.</span></>}
      foot={<button className="linkish" onClick={() => api('/auth/resend-otp', { method: 'POST' }).then(() => toast('New code sent')).catch((e) => toast(e.message, true))}>Send a new code</button>}>
      <p className="muted" style={{ marginTop: -12 }}>We sent a 6-digit code to <b style={{ color: 'var(--ink)' }}>{user?.email}</b>.</p>
      <form className="stack" onSubmit={run(async () => { await verify(otp); nav('/app/onboarding') })}>
        <label className="field"><span>Code</span>
          <input className="input mono" style={{ fontSize: 22, letterSpacing: '0.4em', textAlign: 'center' }} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn lg" disabled={busy || otp.length !== 6}>{busy ? 'Verifying…' : 'Verify'}</button>
      </form>
    </Shell>
  )
}

export function Forgot() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const { busy, error, run } = useSubmit()
  return (
    <Shell index="Reset password" title={<>Forgot it? <span className="serif">Happens.</span></>} foot={<Link to="/login">Back to log in</Link>}>
      {sent ? <p className="lede">If an account exists for {email}, a reset link is on its way.</p> : (
        <form className="stack" onSubmit={run(async () => { await api('/auth/forgot-password', { body: { email } }); setSent(true) })}>
          <label className="field"><span>Email</span><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="btn lg" disabled={busy}>Send reset link</button>
        </form>
      )}
    </Shell>
  )
}

export function Reset() {
  const { token } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const { busy, error, run } = useSubmit()
  return (
    <Shell index="Reset password" title={<>Choose a new <span className="serif">password.</span></>}>
      <form className="stack" onSubmit={run(async () => { await api('/auth/reset-password', { body: { token, password } }); toast('Password updated'); nav('/login') })}>
        <label className="field"><span>New password</span><input className="input" type="password" minLength={8} required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn lg" disabled={busy}>Update password</button>
      </form>
    </Shell>
  )
}
