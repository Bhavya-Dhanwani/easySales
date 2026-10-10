import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { human, tone } from '../lib/format'

export function Badge({ status, children }: { status?: string | null; children?: ReactNode }) {
  return <span className={`badge ${tone(status)}`}>{children ?? human(status)}</span>
}

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className="logo" style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="4" width="11" height="24" rx="5.5" fill={dark ? '#f2f1ed' : '#0d0d12'} />
        <rect x="17" y="10" width="12" height="18" rx="6" fill="#2b3bff" />
        <circle className="logo-eye" cx="21" cy="17" r="1.6" fill="#fff" />
        <circle className="logo-eye" cx="25" cy="17" r="1.6" fill="#fff" />
      </svg>
      <span style={{ fontWeight: 600, letterSpacing: '-0.04em', fontSize: 19 }}>easysales</span>
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
      <div style={{ fontSize: 38, fontWeight: 500, letterSpacing: '-0.05em', lineHeight: 1.1, marginTop: 10 }}>{value}</div>
      {hint && <div className="small muted" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

export function PageHead({ index, title, children }: { index: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="label">{index}</div>
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
