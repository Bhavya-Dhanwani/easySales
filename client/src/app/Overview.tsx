import { Link } from 'react-router'
import { api } from '../lib/api'
import { ago, human } from '../lib/format'
import { photo, photoAlt } from '../lib/photos'
import { LEAD_STATUSES, type AuditEvent, type BusinessProfile } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, Stat, useLoad } from '../components/ui'
import { useAuth } from '../lib/auth'
import CountUp from '../components/bits/CountUp'

interface Dashboard {
  totalLeads: number
  pendingApprovals: number
  sent7d: number
  replies7d: number
  replyRate: number
  runningWorkflows: number
  aiCallsToday: number
  aiBudgetPerDay: number
  recent: AuditEvent[]
}
interface Summary { total: number; counts: Record<string, number>; averageScore: number | null; averageEvidenceCoverage: number | null; qualifiedRate: number; researched: number }

export default function Overview() {
  const { user, org } = useAuth()
  const { data: setup } = useLoad(() => api<{ activatedAt: string | null; currentStep: string | null }>('/v1/onboarding/status'), [org?.id])
  const { data, loading } = useLoad(async () => {
    const [dash, summary, profile] = await Promise.all([
      api<Dashboard>('/v1/dashboard'),
      api<Summary>('/v1/pipeline/summary'),
      api<{ profile: BusinessProfile | null }>('/v1/business-profile').catch(() => ({ profile: null })),
    ])
    return { dash, summary, profile: profile.profile }
  }, [org?.id], (d) => d.dash.runningWorkflows > 0)

  if (loading || !data) return <Spinner label="Loading pipeline" />
  const { dash, summary, profile } = data
  const needsSetup = !profile?.description || !profile.services?.length

  return (
    <div className="stack lg fade-in">
      <PageHead index="Overview" title={<>Good to see you, <span className="hl">{user?.name.split(' ')[0]}.</span></>}>
        <Link className="btn ghost" to="/app/leads/import">Import leads</Link>
        {dash.pendingApprovals > 0 && <Link className="btn lime" to="/app/review">{dash.pendingApprovals} to approve</Link>}
      </PageHead>

      {setup && !setup.activatedAt && (
        <div className="card row-flex between" style={{ borderColor: 'var(--forest-3)' }}>
          <span>Your workspace is not live yet: nothing is sent to prospects until setup is finished and you activate it.</span>
          <Link className="btn sm lime" to="/app/onboarding">Continue setup</Link>
        </div>
      )}
      <div className="welcome">
        <div className="stack sm">
          <span className="eyebrow" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--lime)', borderColor: 'rgba(255,255,255,0.12)', justifySelf: 'start' }}>{needsSetup ? 'Setup' : 'Pipeline health'}</span>
          {needsSetup ? <>
            <p className="h1" style={{ color: '#fff' }}>Teach the agents your business first.</p>
            <p style={{ margin: 0, color: '#b9cbc1' }}>Services, prices, ideal customers and the claims they may make. About five minutes.</p>
            <div><Link className="btn lime" to="/app/onboarding">Start setup →</Link></div>
          </> : <>
            <p className="h1" style={{ color: '#fff' }}><CountUp to={summary.qualifiedRate} duration={1.2} />% of your leads are qualified.</p>
            <p style={{ margin: 0, color: '#b9cbc1' }}>Average fit {summary.averageScore ?? '—'} · evidence coverage {summary.averageEvidenceCoverage ?? '—'}% across {summary.researched} researched leads.</p>
          </>}
        </div>
        <img src={photo('owner')} alt={photoAlt('owner')} />
      </div>

      <div className="grid-4">
        <Stat label="Leads" value={<CountUp to={summary.total} duration={1} />} hint={`${summary.counts.qualified ?? 0} qualified · ${summary.counts.needs_review ?? 0} to review`} />
        <Stat label="Sent · 7 days" value={<CountUp to={dash.sent7d} duration={1} />} hint={`${dash.replies7d} replies · ${dash.replyRate}% reply rate`} />
        <Stat label="Awaiting you" value={dash.pendingApprovals} hint={dash.pendingApprovals ? <Link to="/app/review">Review approvals →</Link> : 'Nothing pending'} />
        <Stat label="AI calls today" value={dash.aiCallsToday} hint={
          <span className="stack sm" style={{ marginTop: 6 }}>
            <span className="meter"><i style={{ width: `${Math.min(100, (dash.aiCallsToday / Math.max(1, dash.aiBudgetPerDay)) * 100)}%` }} /></span>
            <span>of {dash.aiBudgetPerDay} daily budget</span>
          </span>
        } />
      </div>

      <section className="stack">
        <div className="row-flex between">
          <span className="h2">Pipeline</span>
          {dash.runningWorkflows > 0 && <Link to="/app/research" className="row-flex small muted" style={{ textDecoration: 'none' }}><span className="pulse" /> {dash.runningWorkflows} agent run{dash.runningWorkflows > 1 ? 's' : ''} in progress</Link>}
        </div>
        <div className="board">
          {LEAD_STATUSES.map((s) => (
            <Link key={s} to={`/app/leads?status=${s}`} className="board-col">
              <div className="label">{human(s)}</div>
              <div className="num" style={{ fontSize: 30, marginTop: 6 }}>{summary.counts[s] ?? 0}</div>
            </Link>
          ))}
        </div>
      </section>

      <section className="stack">
        <span className="h2">Recent activity</span>
        {dash.recent.length === 0 ? <Empty title="Quiet so far.">Import leads and start research; every agent decision shows up here.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {dash.recent.map((e) => (
                  <tr key={e._id}>
                    <td style={{ fontWeight: 500 }}>{human(e.action)}</td>
                    <td className="small muted">{e.actorType === 'user' ? 'You / team' : e.actorType === 'agent' ? `Agent · ${e.actorId}` : human(e.actorId)}</td>
                    <td>{e.decision ? <Badge status={e.decision} /> : <Badge status={e.outcome} />}</td>
                    <td className="small muted" style={{ textAlign: 'right' }}>{ago(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
