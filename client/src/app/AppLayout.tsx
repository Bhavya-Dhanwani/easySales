import { useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { Logo, Spinner } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'
import './app.css'

const NAV: { group: string; items: { to: string; label: string; end?: boolean }[] }[] = [
  { group: 'Pipeline', items: [
    { to: '/app', label: 'Overview', end: true },
    { to: '/app/leads', label: 'Lead pipeline' },
    { to: '/app/research', label: 'Research activity' },
    { to: '/app/campaigns', label: 'Campaigns' },
    { to: '/app/experiments', label: 'Experiments' },
    { to: '/app/analytics', label: 'Analytics' },
    { to: '/app/inbox', label: 'Inbox' },
    { to: '/app/review', label: 'Review queue' },
    { to: '/app/runs', label: 'Agent runs' },
  ] },
  { group: 'Configure', items: [
    { to: '/app/business', label: 'Business brain' },
    { to: '/app/policies', label: 'Autonomy & limits' },
    { to: '/app/email', label: 'Email account' },
    { to: '/app/team', label: 'Team' },
    { to: '/app/billing', label: 'Plan & billing' },
    { to: '/app/onboarding', label: 'Setup' },
  ] },
  { group: 'Trust', items: [
    { to: '/app/suppressions', label: 'Do-not-contact' },
    { to: '/app/audit', label: 'Audit log' },
    { to: '/app/usage', label: 'Usage & budget' },
  ] },
]

// operators of the platform (ADMIN_EMAILS) also see the operations console
const OPS: (typeof NAV)[number] = { group: 'Platform', items: [{ to: '/app/ops', label: 'Operations' }] }

export default function AppLayout() {
  const { ready, user, org, organizations, switchOrg, logout, isPlatformAdmin, isSupport } = useAuth()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(0)
  const loc = useLocation()
  const nav = useNavigate()

  useEffect(() => setOpen(false), [loc.pathname])

  // pending approvals badge, refreshed on navigation and every 15s
  useEffect(() => {
    if (!user?.isVerified || !org) return
    let alive = true
    const load = () => api<{ approvals: unknown[] }>('/v1/approvals').then((d) => alive && setPending(d.approvals.length)).catch(() => undefined)
    load()
    const id = window.setInterval(load, 15000)
    return () => { alive = false; window.clearInterval(id) }
  }, [user, org, loc.pathname])

  if (!ready) return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><Spinner label="Loading" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (!user.isVerified) return <Navigate to="/verify" replace />

  return (
    <div className="shell">
      <div className="topbar-mobile">
        <Logo />
        <button className="btn ghost sm" onClick={() => setOpen(true)} aria-label="Open menu">Menu</button>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`side ${open ? 'open' : ''}`}>
        <NavLink to="/" aria-label="Home" style={{ padding: '0 6px' }}><Logo dark /></NavLink>
        {(isPlatformAdmin || isSupport ? [...NAV, OPS] : NAV).map((g) => (
          <nav className="side-group" key={g.group} aria-label={g.group}>
            <div className="label">{g.group}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
                <span>{i.label}</span>
                {i.to === '/app/review' && pending > 0 && <span className="count">{pending}</span>}
              </NavLink>
            ))}
          </nav>
        ))}
        <div className="side-foot">
          {organizations.length > 1 && (
            <select className="select org-switch" value={org?.id} onChange={(e) => { switchOrg(e.target.value); nav('/app') }} aria-label="Organization">
              {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <div className="who">
            <span className="avatar">{user.name?.[0]?.toUpperCase()}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="small" style={{ fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{org?.name}</div>
              <div className="small" style={{ color: '#a9bfb3' }}>{org?.role?.replace('_', ' ')}</div>
            </div>
            <button className="linkish" onClick={async () => { await logout(); nav('/') }}>Log out</button>
          </div>
        </div>
      </aside>
      <main className="main" key={org?.id}>
        <Outlet />
      </main>
    </div>
  )
}
