import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { human, tone } from '../lib/format'

export function Badge({ status, children }: { status?: string | null; children?: ReactNode }) {
  return <span className={`badge ${tone(status)}`}>{children ?? human(status)}</span>
}

// the easySales mark: a rising trend line in a forest tile
export function Logo({ dark = false, size = 30 }: { dark?: boolean; size?: number }) {
  return (
    <span className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill={dark ? '#c8f169' : '#0f3d2e'} />
        <path className="logo-trend" d="M8 21.5 13.5 16l3.5 3.5L24 12.5" fill="none" stroke={dark ? '#0f3d2e' : '#c8f169'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M19 12h5.5v5.5" fill="none" stroke={dark ? '#0f3d2e' : '#c8f169'} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontFamily: 'var(--display)', fontWeight: 700, letterSpacing: '-0.035em', fontSize: size * 0.68, color: dark ? '#fff' : 'var(--ink)' }}>
        easy<span style={{ color: dark ? 'var(--lime)' : 'var(--forest-3)' }}>Sales</span>
      </span>
    </span>
  )
}

export function Spinner({ label }: { label?: string }) {
  return <span className="row-flex muted small" style={{ gap: 8 }}><span className="spinner" />{label}</span>
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="h2">{title}</p>
      {children && <p className="small" style={{ margin: '0 auto 16px', maxWidth: 420 }}>{children}</p>}
      {action}
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="num" style={{ fontSize: 36, lineHeight: 1.1, marginTop: 8 }}>{value}</div>
      {hint && <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

export function PageHead({ index, title, children }: { index: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <span className="eyebrow" style={{ justifySelf: 'start' }}>{index}</span>
      <div className="row-flex between" style={{ alignItems: 'flex-end' }}>
        <h1 className="h1">{title}</h1>
        {children && <div className="row-flex">{children}</div>}
      </div>
    </header>
  )
}

/* ---------- toast ---------- */

interface Toast { text: string; bad?: boolean }
const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((text: string, bad = false) => {
    setToast({ text, bad })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), 3600)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <div role="status" className={`toast ${toast.bad ? 'bad' : ''}`}>{toast.text}</div>}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

/* ---------- data hook ---------- */

// loads data, exposes reload, and optionally polls while `poll` returns true
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], poll?: (data: T) => boolean) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(async () => {
    try {
      const next = await loadRef.current()
      setData(next)
      setError(null)
      return next
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    if (!poll || !data || !poll(data)) return
    const id = window.setInterval(reload, 2000)
    return () => window.clearInterval(id)
  }, [data, poll, reload])

  return { data, error, loading, reload, setData }
}
