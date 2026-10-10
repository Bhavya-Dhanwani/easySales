import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '../lib/api'
import { ago, human } from '../lib/format'
import type { ResearchJob } from '../lib/types'
import { Badge, Empty, PageHead, Spinner, useLoad, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'

const FILTERS = ['', 'queued', 'running', 'completed', 'failed'] as const

export default function Research() {
  const { org } = useAuth()
  const toast = useToast()
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('')
  const { data, loading, reload } = useLoad(
    () => api<{ jobs: ResearchJob[] }>(`/v1/research-jobs?limit=100${status ? `&status=${status}` : ''}`),
    [org?.id, status],
    (d) => d.jobs.some((j) => j.status === 'queued' || j.status === 'running'),
  )
  const jobs = data?.jobs ?? []
  const tokens = jobs.reduce((a, j) => a + (j.usage ? j.usage.inputTokens + j.usage.outputTokens : 0), 0)

  return (
    <div className="stack lg fade-in">
      <PageHead index="Research activity" title={<>What the agents are <span className="hl">working on.</span></>}>
        <Link className="btn ghost" to="/app/leads">Pipeline</Link>
      </PageHead>

      <div className="grid-4">
        {(['queued', 'running', 'completed', 'failed'] as const).map((s) => (
          <button key={s} className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: status === s ? 'var(--forest-3)' : undefined }} onClick={() => setStatus(status === s ? '' : s)}>
            <div className="label">{human(s)}</div>
            <div className="num" style={{ fontSize: 32, marginTop: 6 }}>{jobs.filter((j) => j.status === s).length}</div>
          </button>
        ))}
      </div>
      <div className="small muted">{jobs.length} jobs shown · {tokens.toLocaleString()} tokens used{status && <> · filtered by <b>{status}</b> <button className="linkish" onClick={() => setStatus('')}>clear</button></>}</div>

      {loading ? <Spinner label="Loading jobs" /> : !jobs.length ? <Empty title="No research jobs yet.">Select leads in the pipeline and choose “Research selected”.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Lead</th><th>Job</th><th>Status</th><th>Outcome / failure</th><th>Attempts</th><th>Usage</th><th>Started</th><th /></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j._id}>
                  <td>{j.lead ? <Link to={`/app/leads/${j.lead._id}`} style={{ fontWeight: 600, textDecoration: 'none' }}>{j.lead.company.name}</Link> : <span className="muted">deleted lead</span>}</td>
                  <td className="small">{j.type === 'lead.research' ? 'Research' : 'Full pipeline'}<div className="muted">{human(j.currentStep)}</div></td>
                  <td>{j.status === 'running' ? <span className="row-flex small" style={{ gap: 6 }}><span className="spinner" /> running</span> : <Badge status={j.status} />}</td>
                  <td className="small" style={{ maxWidth: 320 }}>{j.status === 'failed' ? <span className="form-error">{j.failureCode}: {j.lastError}</span> : j.result?.outcome ? human(j.result.outcome) : j.lastError ? <span className="muted">retrying: {j.lastError}</span> : '—'}</td>
                  <td className="mono">{j.attempts}/{j.maxAttempts}</td>
                  <td className="small muted">{j.usage ? `${j.usage.calls} call · ${(j.usage.inputTokens + j.usage.outputTokens).toLocaleString()} tok` : '—'}</td>
                  <td className="small muted">{ago(j.createdAt)}</td>
                  <td>{j.status === 'failed' && <button className="btn sm ghost" onClick={() => api(`/v1/research-jobs/${j._id}/retry`, { method: 'POST' }).then(() => { toast('Retry queued'); reload() }).catch((e) => toast(e.message, true))}>Retry</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
