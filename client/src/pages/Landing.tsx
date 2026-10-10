import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/auth'
import './landing.css'

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const t = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false })
  return <span className="lp-clock"><span className="pulse" /> Agents online · {t} IST</span>
}

// a scripted replay of one real pipeline run
const SCRIPT: [string, string, string][] = [
  ['research', 'k-research', 'Reading acmedental.in — 3 clinics, phone-only bookings'],
  ['research', 'k-research', 'Evidence: "Call to book" on every page (verified)'],
  ['qualify', 'k-qualify', 'ICP fit 82/100 · healthcare · India · no disqualifiers'],
  ['draft', 'k-draft', 'Subject: "Online booking for Acme Dental"'],
  ['policy', 'k-policy', 'Consent ✓ · suppression ✓ · daily cap 4/20 ✓'],
  ['policy', 'k-policy', 'Auto-send off → waiting for your approval'],
  ['approved', 'k-sent', 'Approved by you · payload hash 9f3c…e21'],
  ['sent', 'k-sent', 'Delivered 10:42 IST · follow-up scheduled in 72h'],
  ['reply', 'k-research', '"Yes — can we launch before January?"'],
  ['qualify', 'k-qualify', 'Intent: interested · timeline: before January'],
]

function AgentConsole() {
  const [count, setCount] = useState(1)
  useEffect(() => {
    const id = window.setInterval(() => setCount((c) => (c >= SCRIPT.length + 3 ? 1 : c + 1)), 1300)
    return () => window.clearInterval(id)
  }, [])
  const lines = SCRIPT.slice(0, Math.min(count, SCRIPT.length))
  return (
    <div className="console" aria-label="Example of an agent run">
      <div className="console-head">
        <div className="console-dots"><i /><i /><i /></div>
        <span>pipeline · acme dental</span>
      </div>
      {lines.map(([k, cls, text], i) => (
        <div className="console-line" key={`${count > SCRIPT.length ? 'x' : ''}${i}`}>
          <b className={cls}>{k}</b>
          <span>{text}</span>
        </div>
      ))}
      <div className="console-line"><b /> <span><span className="console-caret" /></span></div>
    </div>
  )
}

// words light up as the paragraph scrolls through the viewport
function Manifesto({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [lit, setLit] = useState(0)
  const words = text.split(' ')
  useEffect(() => {
    const onScroll = () => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight
      const progress = Math.min(Math.max((vh * 0.85 - r.top) / (r.height + vh * 0.35), 0), 1)
      setLit(Math.round(progress * words.length))
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [words.length])
  return (
    <p ref={ref}>
      {words.map((w, i) => <span key={i} className={`w ${i < lit ? 'on' : ''}`}>{w} </span>)}
    </p>
  )
}

const CAPABILITIES = [
  { n: '01', k: 'Research', title: 'It reads before it writes.', copy: 'Every prospect\'s public site is read, summarized and turned into evidence. Facts it verified are marked verified. Guesses stay guesses.', tags: ['Website research', 'Evidence trail', 'SSRF-safe fetch'] },
  { n: '02', k: 'Qualify', title: 'Only the right fits.', copy: 'Leads are scored against your ideal customer profile. Disqualifiers are hard rules, not vibes. You see the rationale for every score.', tags: ['ICP scoring', 'Disqualifiers', 'Human override'] },
  { n: '03', k: 'Reach out', title: 'Specific, never spammy.', copy: 'First touches and follow-ups written in your voice, using only claims you approved. Opt-out on every message, quiet hours, daily caps.', tags: ['Approved claims', 'Follow-ups', 'Opt-out built in'] },
  { n: '04', k: 'Converse', title: 'Replies, handled.', copy: 'Inbound replies are classified, requirements are captured into the CRM, and the next step is drafted. Pricing questions go to a human.', tags: ['Intent detection', 'Requirement capture', 'Escalation'] },
  { n: '05', k: 'Propose', title: 'Numbers by code. Words by AI.', copy: 'Proposals are priced by a deterministic engine from your catalogue. The agent writes the story; it can never change a number.', tags: ['Deterministic pricing', 'Discount limits', 'Approvals'] },
]

const FAQ = [
  ['Will it email people without asking me?', 'Not unless you allow it. New workspaces start in approval mode: every outbound message waits for a human. You can enable automatic sending later, and even then hard limits (consent, opt-outs, daily caps, follow-up spacing, quiet hours) are enforced by code, not by the model.'],
  ['What stops it from promising things I can\'t deliver?', 'Agents can only use the approved claims in your business profile. Prohibited phrases force a human review. Prices and discounts are calculated deterministically and anything outside your limits needs approval.'],
  ['Which AI models does it use?', 'Any OpenAI-compatible endpoint: OpenAI, a LiteLLM gateway with Claude or Nova models, or your own. Calls are metered per workspace with a hard daily budget.'],
  ['Is my data separated from other businesses?', 'Every record is scoped to your organization and the database layer refuses unscoped queries. Cross-tenant access is covered by automated tests. You can export or delete everything at any time.'],
  ['What happens when someone says “stop”?', 'Opt-out language is detected deterministically before any model sees it. The address is suppressed immediately, pending messages are cancelled, and nothing is sent to it again, not even by a human from inside the app.'],
]

export default function Landing() {
  const { user } = useAuth()
  const appHref = user ? '/app' : '/signup'
  return (
    <div className="lp">
      <header className="lp-top">
        <div className="lp-wrap lp-top-inner">
          <Link to="/" aria-label="easySales home"><Logo /></Link>
          <Clock />
          <div className="lp-top-right">
            {user ? <Link className="btn" to="/app">Open app</Link> : <>
              <Link className="btn ghost" to="/login">Log in</Link>
              <Link className="btn" to="/signup">Start free</Link>
            </>}
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero lp-wrap">
          <div className="label">00 / AI business development</div>
          <h1 className="display" style={{ marginTop: 22 }}>
            <span className="reveal-line"><span>Clients, found</span></span>
            <span className="reveal-line"><span>and <span className="serif">followed up</span></span></span>
            <span className="reveal-line"><span>while you build.</span></span>
          </h1>
          <div className="lp-hero-foot">
            <div>
              <p className="lede">Tell easySales what you sell and who you sell to. A team of AI agents researches prospects, starts the conversation, handles replies and drafts the proposal, inside limits you control.</p>
              <div className="lp-cta">
                <Link className="btn lg" to={appHref}>Build my pipeline</Link>
                <a className="btn lg ghost" href="#how">See how it works</a>
              </div>
            </div>
            <AgentConsole />
          </div>
        </section>

        <section className="lp-manifesto lp-wrap">
          <div className="label">01 / Manifesto</div>
          <Manifesto text="Most outreach is noise. Templates blasted at lists, follow-ups nobody asked for, promises nobody can keep. We think a sales agent should behave like your best salesperson: do the homework, say something specific, know when to stop, and never commit you to something you did not approve." />
        </section>

        <section id="how" className="lp-section lp-wrap">
          <div className="lp-section-head">
            <div className="label">02 / How it works</div>
            <h2 className="display">Five agents.<br />One pipeline.</h2>
          </div>
          <div className="lp-stack">
            {CAPABILITIES.map((c) => (
              <article className="lp-card" key={c.n}>
                <div className="lp-card-top"><span className="label">{c.n}</span><span className="label">{c.k}</span></div>
                <div>
                  <h3>{c.title}</h3>
                  <p className="lp-card-copy">{c.copy}</p>
                </div>
                <div className="lp-tags">{c.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>
              </article>
            ))}
          </div>
        </section>

        <section id="control" className="lp-section lp-wrap">
          <div className="lp-dark">
            <div className="label">03 / Control</div>
            <h2 className="display" style={{ marginTop: 18 }}>Autonomy, inside <span className="serif">the lines</span> you draw.</h2>
            <div className="lp-control">
              <div>
                {[
                  ['Research companies and score leads', 'Automatic', 'ok'],
                  ['Send outreach within daily caps', 'Your choice', 'warn'],
                  ['Follow up after 72h, max 2 times', 'Policy', 'warn'],
                  ['Discount above 10%', 'Approval', 'warn'],
                  ['Contact someone who opted out', 'Never', 'bad'],
                  ['Sign contracts or take payments', 'Human only', 'bad'],
                ].map(([rule, mode, t]) => (
                  <div className="lp-rule" key={rule}><span>{rule}</span><span className={`badge ${t}`}>{mode}</span></div>
                ))}
              </div>
              <div className="lp-approval">
                <div className="row-flex between"><span className="label">Approval · outreach</span><span className="badge warn">pending</span></div>
                <pre>{`To: priya@acmedental.in
Subject: Online booking for Acme Dental

Hi Priya, I noticed every page on your site says "call to book". We've built booking flows for 12 clinics, so patients can pick a slot in under a minute. Worth a 20-minute chat next week?`}</pre>
                <div className="row-flex">
                  <span className="btn accent sm">Approve & send</span>
                  <span className="btn ghost sm" style={{ color: '#e9e8e3', borderColor: 'rgba(242,241,237,.25)' }}>Edit</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="lp-section lp-wrap">
          <div className="lp-section-head">
            <div className="label">04 / Principles</div>
          </div>
          <div className="lp-principles">
            <div><span className="label">Reason</span><h4>The AI decides what would help.</h4><p className="muted">Research, scoring, writing and understanding replies.</p></div>
            <div><span className="label">Authorize</span><h4>Your policy decides if it may.</h4><p className="muted">A deterministic engine, versioned, audited, fail-closed.</p></div>
            <div><span className="label">Execute</span><h4>Code does it, once.</h4><p className="muted">Idempotent sends, outbox delivery, full audit trail.</p></div>
          </div>
        </section>

        <section id="faq" className="lp-section lp-wrap lp-faq">
          <div className="lp-section-head">
            <div className="label">05 / FAQ</div>
            <h2 className="display">Fair questions.</h2>
          </div>
          {FAQ.map(([q, a]) => (
            <details key={q}><summary>{q}</summary><p>{a}</p></details>
          ))}
        </section>

        <section className="lp-end lp-wrap">
          <div className="label">06 / Start</div>
          <h2 className="display" style={{ marginTop: 22 }}>Let the pipeline <span className="serif">fill itself.</span></h2>
          <div className="lp-cta" style={{ justifyContent: 'center', marginTop: 36 }}>
            <Link className="btn lg accent" to={appHref}>Start free</Link>
          </div>
        </section>
      </main>

      <footer className="lp-wrap lp-footer">
        <Logo />
        <span className="label">© {new Date().getFullYear()} easySales · Built for businesses that sell carefully</span>
      </footer>

      <nav className="lp-dock" aria-label="Sections">
        <a href="#how">How</a>
        <a href="#control">Control</a>
        <a href="#faq">FAQ</a>
        <Link className="go" to={appHref}>Start</Link>
      </nav>
    </div>
  )
}
