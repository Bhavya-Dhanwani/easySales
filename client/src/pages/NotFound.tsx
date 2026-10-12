import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Link, useLocation } from 'react-router'
import { Logo } from '../components/ui'
import './notfound.css'

// the agents "working" on a page that doesn't exist, typed out line by line
const LOG = [
  ['research', 'fetched {path} … 404, nobody home'],
  ['qualify', 'fit score 0/100: the page does not exist'],
  ['outreach', 'drafted "Hi page, are you still there?"'],
  ['policy', 'blocked: no consent basis for ghosts'],
  ['follow-up', 'cancelled: the page never replied'],
  ['agent', 'recommend: rescue the leads on the radar →'],
]

const QUIPS = [
  'This page went cold.',
  'Our research agent read 3 pages. None were this one.',
  'Even the follow-up got no reply.',
  'Lead status: disqualified (does not exist).',
  'We checked the CRM, the calendar and under the sofa.',
]

type Blip = { id: number; x: number; y: number; born: number }

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function NotFound() {
  const { pathname } = useLocation()
  const stage = useRef<HTMLDivElement>(null)
  const [tilt, setTilt] = useState({ x: 0, y: 0 })
  const [quip, setQuip] = useState(0)
  const [typed, setTyped] = useState(() => (reduced() ? Infinity : 0))
  const [blips, setBlips] = useState<Blip[]>([])
  const [rescued, setRescued] = useState(0)
  const [pops, setPops] = useState<{ id: number; x: number; y: number }[]>([])
  const nextId = useRef(1)

  const lines = LOG.map(([who, what]) => `> ${who}: ${what.replace('{path}', pathname.length > 32 ? `${pathname.slice(0, 32)}…` : pathname)}`)
  const totalChars = lines.reduce((n, l) => n + l.length, 0)

  // rotating headline
  useEffect(() => {
    if (reduced()) return
    const t = setInterval(() => setQuip((q) => (q + 1) % QUIPS.length), 2800)
    return () => clearInterval(t)
  }, [])

  // the agent log types itself out
  useEffect(() => {
    if (typed >= totalChars) return
    const t = setTimeout(() => setTyped((n) => n + 1), 22)
    return () => clearTimeout(t)
  }, [typed, totalChars])

  // lost leads appear on the radar and fade if nobody rescues them
  useEffect(() => {
    const spawn = () => {
      const angle = Math.random() * Math.PI * 2
      const r = 18 + Math.random() * 26
      setBlips((b) => [...b.filter((x) => Date.now() - x.born < 5200), { id: nextId.current++, x: 50 + Math.cos(angle) * r, y: 50 + Math.sin(angle) * r, born: Date.now() }].slice(-6))
    }
    spawn()
    const t = setInterval(spawn, reduced() ? 2600 : 1300)
    return () => clearInterval(t)
  }, [])

  function move(e: PointerEvent) {
    if (reduced() || !stage.current) return
    const r = stage.current.getBoundingClientRect()
    setTilt({ x: ((e.clientY - r.top) / r.height - 0.5) * -14, y: ((e.clientX - r.left) / r.width - 0.5) * 18 })
  }

  function rescue(b: Blip) {
    setBlips((all) => all.filter((x) => x.id !== b.id))
    setRescued((n) => n + 1)
    const id = nextId.current++
    setPops((p) => [...p, { id, x: b.x, y: b.y }])
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 900)
  }

  // reveal `typed` characters across the log lines
  const starts = lines.map((_, i) => lines.slice(0, i).reduce((n, l) => n + l.length, 0))
  const shown = lines.map((l, i) => l.slice(0, Math.max(0, typed - starts[i])))
  const typing = typed < totalChars

  return (
    <main className="nf" ref={stage} onPointerMove={move} onPointerLeave={() => setTilt({ x: 0, y: 0 })}>
      <div className="nf-grid" aria-hidden="true" />
      <header className="nf-top">
        <Link to="/" aria-label="easySales home" className="nf-logo"><Logo dark /></Link>
        <span className="nf-chip"><i /> error 404 · lead lost</span>
      </header>

      <section className="nf-hero" style={{ '--rx': `${tilt.x}deg`, '--ry': `${tilt.y}deg` } as CSSProperties}>
        <h1 className="nf-sr">Page not found (404)</h1>
        <div className="nf-digits" aria-hidden="true">
          <span className="nf-d nf-d1">4</span>
          <div className="nf-radar">
            <div className="nf-sweep" />
            <div className="nf-ring r1" /><div className="nf-ring r2" /><div className="nf-ring r3" />
            <div className="nf-cross" />
          </div>
          <span className="nf-d nf-d2">4</span>
        </div>
        {/* blips sit over the radar's "0": real buttons, so keyboard users can play too */}
        <div className="nf-blips">
          {blips.map((b) => (
            <button key={b.id} className="nf-blip" style={{ left: `${b.x}%`, top: `${b.y}%` }} onClick={() => rescue(b)} aria-label="Rescue a lost lead" />
          ))}
          {pops.map((p) => <span key={p.id} className="nf-pop" style={{ left: `${p.x}%`, top: `${p.y}%` }} aria-hidden="true">+1 lead</span>)}
        </div>
      </section>

      <p className="nf-quip" aria-live="polite"><span key={quip}>{QUIPS[quip]}</span></p>
      <p className="nf-path">Nothing lives at <code>{pathname}</code>.{' '}
        {rescued > 0
          ? <b className="nf-score">{rescued >= 5 ? `${rescued} leads rescued. You're hired. 🏆` : `${rescued} lead${rescued > 1 ? 's' : ''} rescued.`}</b>
          : <span>Click the blips on the radar to rescue lost leads.</span>}
      </p>

      <div className="nf-actions">
        <Link className="btn lg lime" to="/">Take me home</Link>
        <Link className="btn lg nf-ghost" to="/app">Open the dashboard</Link>
      </div>

      <div className="nf-log" role="log" aria-label="Agent log">
        <div className="nf-log-bar"><i /><i /><i /><span>agents.log</span></div>
        <pre>{shown.filter((s, i) => s || i === 0).join('\n')}<span className={`nf-caret ${typing ? '' : 'idle'}`} aria-hidden="true">▍</span></pre>
      </div>
    </main>
  )
}
