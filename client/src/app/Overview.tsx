import { Link } from 'react-router'
import { api } from '../lib/api'
import { ago, human } from '../lib/format'
import { STAGES, type AuditEvent, type BusinessProfile } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, Stat, useLoad } from '../components/ui'
import { useAuth } from '../lib/auth'

interface Dashboard {
  totalLeads: number
  stages: Record<string, number>
  qualification: Record<string, number>
  qualifiedRate: number
  pendingApprovals: number
  sent7d: number
  replies7d: number
  replyRate: number
  runningWorkflows: number
  failedWorkflows7d: number
  aiCallsToday: number
  aiBudgetPerDay: number
  recent: AuditEvent[]
}

export default function Overview() {
  const { user, org } = useAuth()
  const { data, loading } = useLoad(async () => {
    const [dash, profile] = await Promise.all([
      api<Dashboard>('/v1/dashboard'),
      api<{ profile: BusinessProfile | null }>('/v1/business-profile').catch(() => ({ profile: null })),
    ])
    return { dash, profile: profile.profile }
  }, [org?.id], (d) => d.dash.runningWorkflows > 0)

  if (loading || !data) return <Spinner label="Loading pipeline" />
  const { dash, profile } = data
  const needsSetup = !profile?.description || !profile.services?.length

  return (
    <div className="stack lg fade-in">
      <PageHead index="01 / Overview" title={<>Good to see you, <span className="serif">{user?.name.split(' ')[0]}.</span></>}>
        <Link className="btn ghost" to="/app/leads?add=1">Add leads</Link>
        {dash.pendingApprovals > 0 && <Link className="btn accent" to="/app/approvals">{dash.pendingApprovals} to approve</Link>}
      </PageHead>

      {needsSetup && (
        <div className="card" style={{ background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' }}>
          <div className="row-flex between">
            <div>
              <div className="label" style={{ color: '#8b8b93' }}>Setup</div>
              <p className="h2" style={{ marginTop: 8 }}>Teach the agents your business first.</p>
              <p className="small" style={{ color: '#a3a3a9', margin: '6px 0 0' }}>Services, prices, ideal customers and the claims they may make. Takes about five minutes.</p>
            </div>
            <Link className="btn accent" to="/app/onboarding">Start setup</Link>
          </div>
        </div>
      )}

      <div className="grid-4">
        <Stat label="Leads" value={dash.totalLeads} hint={`${dash.qualifiedRate}% qualified`} />
        <Stat label="Sent · 7 days" value={dash.sent7d} hint={`${dash.replies7d} replies · ${dash.replyRate}% reply rate`} />
        <Stat label="Awaiting you" value={dash.pendingApprovals} hint={dash.pendingApprovals ? <Link to="/app/approvals">Review approvals →</Link> : 'Nothing pending'} />
        <Stat label="AI calls today" value={`${dash.aiCallsToday}`} hint={
          <span className="stack sm" style={{ marginTop: 6 }}>
            <span className="bar"><i style={{ width: `${Math.min(100, (dash.aiCallsToday / Math.max(1, dash.aiBudgetPerDay)) * 100)}%` }} /></span>
            <span>of {dash.aiBudgetPerDay} daily budget</span>
          </span>
        } />
      </div>

      <section className="stack">
        <div className="row-flex between">
          <div className="label">Pipeline</div>
          {dash.runningWorkflows > 0 && <span className="row-flex small muted"><span className="pulse" /> {dash.runningWorkflows} agent run{dash.runningWorkflows > 1 ? 's' : ''} in progress</span>}
        </div>
        <div className="board">
          {STAGES.map((s) => (
            <Link key={s} to={`/app/leads?stage=${s}`} className="board-col" style={{ textDecoration: 'none' }}>
              <div className="label">{s}</div>
              <div style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.05em' }}>{dash.stages[s] ?? 0}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="stack">
        <div className="label">Recent activity</div>
        {dash.recent.length === 0 ? <Empty title="Quiet so far.">Import leads and start a run; every agent decision shows up here.</Empty> : (
          <div className="card flat" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {dash.recent.map((e) => (
                    <tr key={e._id}>
                      <td className="mono">{human(e.action)}</td>
                      <td className="small muted">{e.actorType === 'user' ? 'You / team' : e.actorType === 'agent' ? `Agent · ${e.actorId}` : human(e.actorId)}</td>
                      <td>{e.decision ? <Badge status={e.decision} /> : <Badge status={e.outcome} />}</td>
                      <td className="small muted" style={{ textAlign: 'right' }}>{ago(e.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
