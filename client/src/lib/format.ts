export function money(minor: number, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100)
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`
  }
}

export function ago(iso?: string) {
  if (!iso) return '—'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export const human = (s?: string | null) => (s ?? '').replace(/[._]/g, ' ')

// maps a status to a badge tone
export function tone(status?: string | null): '' | 'ok' | 'warn' | 'bad' | 'accent' {
  switch (status) {
    case 'qualified': case 'match': case 'sent': case 'completed': case 'won': case 'approved': case 'accepted': case 'done': case 'success': case 'allow': case 'replied': case 'active':
      return 'ok'
    case 'needs_review': case 'partial': case 'completed_with_errors': case 'pending_approval': case 'waiting_approval': case 'pending': case 'uncertain': case 'needs_approval': case 'negotiation': case 'draft':
      return 'warn'
    case 'disqualified': case 'failed': case 'research_failed': case 'mismatch': case 'rejected': case 'lost': case 'opted_out': case 'deny': case 'denied': case 'failure': case 'suppressed': case 'cancelled':
      return 'bad'
    case 'running': case 'queued': case 'sending': case 'generating': case 'discovery': case 'proposal': case 'research_queued': case 'researching': case 'processing':
      return 'accent'
    default:
      return ''
  }
}
