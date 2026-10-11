import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../lib/auth'
import { photo, type PhotoKey } from '../lib/photos'
import ScrollVelocity from '../components/bits/ScrollVelocity'
import ImageTrail from '../components/bits/ImageTrail'
import CountUp from '../components/bits/CountUp'
import './landing.css'

// one duotone (forest shadows, paper highlights) applied to every photo on the page
function DuotoneFilter() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <filter id="duo" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues="0.055 0.953" />
          <feFuncG type="table" tableValues="0.122 0.957" />
          <feFuncB type="table" tableValues="0.094 0.937" />
        </feComponentTransfer>
      </filter>
    </svg>
  )
}

// duotone at rest, real colour on hover
function Photo({ k, w = 900, h, alt = '', className = '' }: { k: PhotoKey; w?: number; h?: number; alt?: string; className?: string }) {
  const src = photo(k, w, h)
  return (
    <span className={`ph ${className}`}>
      <img src={src} alt={alt} loading="lazy" />
      <img src={src} alt="" aria-hidden="true" loading="lazy" className="duo" />
    </span>
  )
}

function Clock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setT(new Date()), 1000); return () => clearInterval(id) }, [])
  return <>{t.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST</>
}

// sentence that brightens word by word as it scrolls through the viewport
function Reveal({ children }: { children: React.ReactNode[] }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [p, setP] = useState(0)
  useEffect(() => {
    const on = () => {
      const r = ref.current?.getBoundingClientRect()
      if (r) setP(Math.min(1, Math.max(0, (innerHeight * 0.9 - r.top) / (r.height + innerHeight * 0.4))))
    }
    on()
    addEventListener('scroll', on, { passive: true })
    return () => removeEventListener('scroll', on)
  }, [])
  const lit = Math.round(p * children.length)
  return <p ref={ref} className="reveal">{children.map((c, i) => <span key={i} className={i < lit ? 'on' : ''}>{c} </span>)}</p>
}

const words = (s: string) => s.split(' ')
const chip = (k: PhotoKey) => <span className="chip-img"><Photo k={k} w={240} h={160} /></span>

const STEPS = [
  { n: '01', t: 'Teach it your business', d: 'Services, prices, ideal customer and the only claims it may make. Versioned like code.', k: 'writing' as PhotoKey },
  { n: '02', t: 'Bring your leads', d: 'Map any CSV, skip duplicates, download an error report for the rest.', k: 'founder' as PhotoKey },
  { n: '03', t: 'Research & score', d: 'Agents read each prospect’s site; code turns evidence into a fit score.', k: 'call2' as PhotoKey },
  { n: '04', t: 'Talk & close', d: 'Campaigns, replies and proposals — every send checked against your policy.', k: 'deal' as PhotoKey },
]

const FAQ = [
  ['Will it email people without asking me?', 'Not unless you allow it. New workspaces start in approval mode. Consent, opt-outs, daily and hourly caps, follow-up spacing and quiet hours are enforced by code, not by the model.'],
  ['How is a lead scored?', 'The research agent rates six criteria and must cite pages it actually read. Code turns that into a fit score plus a separate evidence-coverage number, so missing information never looks like a bad fit.'],
  ['Whose address does it send from?', 'Yours. Connect your own mailbox; the password is verified once and stored encrypted. Replies, bounces and complaints come back through a signed webhook.'],
  ['What happens when someone says stop?', 'Opt-out language is caught before any AI reads it. The address is suppressed instantly and every pending message is cancelled — nobody can email it again from the app.'],
  ['Is my data separate from other businesses?', 'Every record is scoped to your organization and the database refuses unscoped queries. Export or delete everything whenever you like.'],
]

export default function Landing() {
  const { user } = useAuth()
  const go = user ? '/app' : '/signup'

  return (
    <div className="lp">
      <DuotoneFilter />

      <header className="bar">
        <Link to="/" className="bar-logo" aria-label="easySales home">easy<b>Sales</b><sup>®</sup></Link>
        <span className="bar-meta mono"><i className="dot" /> Agents online · <Clock /></span>
        <nav className="bar-nav">
          <a href="#work">Product</a><a href="#process">Process</a><a href="#control">Control</a><a href="#faq">FAQ</a>
          {!user && <Link to="/login">Log in</Link>}
        </nav>
        <Link to={go} className="bar-cta">{user ? 'Open app' : 'Start free'} <span>→</span></Link>
      </header>

      {/* split hero: giant cropped type left, statement + proof right */}
      <section className="hero">
        <div className="hero-l">
          <span className="meta mono">(01) — AI business development</span>
          <h1 className="giant">Find.<br />Pitch.<br /><em>Follow up.</em></h1>
        </div>
        <div className="hero-r">
          <div className="hero-statement">
            <p>An AI sales team for service businesses. It researches every lead, writes the first email and follows up — <span className="u">until they reply or say stop.</span></p>
            <div className="row-flex">
              <Link to={go} className="btn lg">Build my pipeline <span className="arrow">→</span></Link>
              <a href="#process" className="link-arrow">How it works ↓</a>
            </div>
          </div>
          <div className="hero-cells">
            <div className="cell lime">
              <span className="meta mono">Scored by code</span>
              <div className="big-num"><CountUp to={6} duration={1.4} /><small>/6</small></div>
              <span>ICP criteria, each with a cited source</span>
            </div>
            <div className="cell photo-cell">
              <Photo k="call" w={900} h={700} alt="A founder on a sales call at her desk" />
              <span className="float-chip"><i className="dot" /> Lead qualified · fit 92</span>
              <span className="float-chip two">Reply: “Can we talk Tuesday?”</span>
            </div>
          </div>
        </div>
      </section>

      <div className="stripe">
        <ScrollVelocity texts={['easySales® ✳ Research ✳ Qualify ✳ Reach out ✳ Follow up ✳ Close ✳']} velocity={45} className="stripe-text" />
      </div>

      {/* sentence with inline images */}
      <section className="sentence pad">
        <span className="meta mono">(02) — What it does</span>
        <Reveal>{[
          ...words('It reads'), chip('founder'), ...words('every prospect’s website, scores'), chip('writing'),
          ...words('them against your ideal customer, writes'), chip('call2'), ...words('the first email in your voice — and stops'), chip('deal2'),
          ...words('the moment someone says no.'),
        ]}</Reveal>
      </section>

      {/* staggered mosaic: photos and solid tiles of different sizes */}
      <section id="work" className="mosaic pad">
        <div className="tile t1"><Photo k="founder2" w={900} h={1100} alt="A business owner" /><span className="cap"><b>Research with receipts</b>Up to three pages read per prospect. Every claim links to its source.</span></div>
        <div className="tile t2 solid lime"><span className="meta mono">(A)</span><b className="tile-h">Scores by code, not vibes.</b><span>Unknown is never a mismatch; coverage shown beside the score.</span></div>
        <div className="tile t3"><Photo k="call3" w={800} h={600} alt="A salesperson on the phone" /><span className="cap"><b>Outreach in your voice</b>Approved claims only. Personal details checked against research.</span></div>
        <div className="tile t4 solid forest"><span className="meta mono">(B)</span><b className="tile-h">9 reply intents.</b><span>Interested, pricing, objection, out of office, opt-out… each with its next step.</span></div>
        <div className="tile t5"><Photo k="deal2" w={800} h={800} alt="Two people shaking hands" /><span className="cap"><b>Follow-ups that stop</b>Business-day cadence, cancelled the moment someone replies.</span></div>
        <div className="tile t6 solid mint"><span className="meta mono">(C)</span><b className="tile-h">Proposals priced right.</b><span>Numbers from your catalogue. Discounts wait for you.</span></div>
        <div className="tile t7"><Photo k="suit" w={800} h={600} alt="A consultant on a call" /><span className="cap"><b>Your mailbox</b>Sends from your own address; replies thread back automatically.</span></div>
      </section>

      {/* cursor trail */}
      <section className="trail">
        <div className="trail-copy">
          <span className="meta mono">(03) — Move your cursor</span>
          <h2 className="giant-2">Every row is a person.</h2>
          <p>easySales reads each prospect before it writes a word, so the first email sounds like someone did their homework.</p>
        </div>
        <ImageTrail items={(['call', 'founder', 'deal', 'writing', 'call2', 'founder2', 'suit', 'call3', 'meeting', 'counter'] as PhotoKey[]).map((k) => photo(k, 380, 360))} variant={1} />
      </section>

      {/* ruled process table */}
      <section id="process" className="process pad">
        <div className="process-head"><span className="meta mono">(04) — Process</span><h2 className="giant-2">Spreadsheet to signed.</h2></div>
        {STEPS.map((s) => (
          <div key={s.n} className="prow">
            <span className="mono pn">{s.n}</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
            <span className="pthumb"><Photo k={s.k} w={500} h={340} /></span>
          </div>
        ))}
      </section>

      {/* control split */}
      <section id="control" className="control">
        <div className="control-l">
          <span className="meta mono">(05) — Control</span>
          <h2 className="giant-3">Nothing<br />leaves<br /><em>without you.</em></h2>
        </div>
        <div className="control-r">
          {[
            ['Research and score leads', 'Automatic'],
            ['Send within daily and hourly caps', 'Your choice'],
            ['Pricing questions & complaints', 'Human review'],
            ['Contact someone who opted out', 'Never'],
            ['Sign contracts or take payments', 'Human only'],
          ].map(([r, m]) => <div className="crow" key={r}><span>{r}</span><span className="mono">{m}</span></div>)}
          <div className="approval">
            <div className="row-flex between"><b>Review · outreach</b><span className="badge warn">pending</span></div>
            <pre>{`To: priya@acmedental.in
Subject: Online booking for Acme Dental

Hi Priya, every page on your site says "call to book". We've built booking flows for clinics so patients can pick a slot in under a minute. Worth a 20-minute chat next week?`}</pre>
            <div className="row-flex"><span className="btn sm">Approve & send</span><span className="btn sm ghost">Edit</span><span className="small muted">claim backed by acmedental.in</span></div>
          </div>
        </div>
      </section>

      <section id="faq" className="faq pad">
        <div className="faq-l"><span className="meta mono">(06) — FAQ</span><h2 className="giant-2">Fair<br />questions.</h2></div>
        <div>{FAQ.map(([q, a], i) => <details key={q}><summary><span className="mono">0{i + 1}</span>{q}</summary><p>{a}</p></details>)}</div>
      </section>

      <footer className="end">
        <div className="end-row pad">
          <Link to={go} className="end-cta">Let the pipeline fill itself <span>→</span></Link>
          <div className="end-links mono"><a href="#work">Product</a><a href="#process">Process</a><a href="#faq">FAQ</a><Link to="/help">Help</Link><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link><span>© {new Date().getFullYear()}</span></div>
        </div>
        <div className="wordmark" aria-hidden="true">easySales</div>
      </footer>
    </div>
  )
}
