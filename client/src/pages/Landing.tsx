import { Link } from 'react-router'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/auth'
import { photo } from '../lib/photos'
import BlurText from '../components/bits/BlurText'
import RotatingText from '../components/bits/RotatingText'
import TiltedCard from '../components/bits/TiltedCard'
import SpotlightCard from '../components/bits/SpotlightCard'
import CountUp from '../components/bits/CountUp'
import './landing.css'

const INDUSTRIES = ['Web & app studios', 'Marketing agencies', 'Clinics & healthcare', 'Coaching institutes', 'IT consultancies', 'Architecture firms', 'Event companies', 'B2B SaaS', 'Design studios', 'Local services']

const STEPS = [
  { img: 'workshop' as const, title: 'Teach it your business', copy: 'Services, prices, ideal customers and the claims it may make. Structured, versioned, yours.' },
  { img: 'laptop' as const, title: 'Bring your leads', copy: 'Import a CSV with column mapping, duplicate detection and a downloadable error report.' },
  { img: 'tablet' as const, title: 'Research & score', copy: 'Agents read each prospect\'s site and evaluate six ICP criteria. Code calculates the score.' },
  { img: 'presenting' as const, title: 'Talk & close', copy: 'Outreach, replies and proposals flow through your policy, with approvals where you want them.' },
]

const FAQ = [
  ['Will it email people without asking me?', 'Not unless you allow it. New workspaces start in approval mode: every outbound message waits for you. Hard limits (consent, opt-outs, daily caps, follow-up spacing, quiet hours) are enforced by code, not by the model.'],
  ['How is a lead scored?', 'The research agent evaluates six criteria (industry, size, need, geography, budget, contact) and must cite the pages it read. Deterministic code turns that into a fit score and a separate evidence-coverage number. Unknown never counts as a mismatch.'],
  ['What stops it from making things up?', 'Citations to pages the agent did not actually fetch are dropped, and the criterion becomes "unknown". Agents can only use claims you approved, and prices come from your catalogue, never from the model.'],
  ['Which AI models does it use?', 'Any OpenAI-compatible endpoint: OpenAI, a LiteLLM gateway with Claude or Nova, or your own. Every call is metered per workspace against a daily budget.'],
  ['Is my data separated from other businesses?', 'Every record is scoped to your organization and the database layer refuses unscoped queries. Cross-tenant access is covered by automated tests. Export or delete everything at any time.'],
]

export default function Landing() {
  const { user } = useAuth()
  const appHref = user ? '/app' : '/signup'

  return (
    <div className="lp">
      <header className="nav wrap">
        <div className="nav-inner">
          <Link to="/" aria-label="easySales home"><Logo /></Link>
          <nav className="nav-links" aria-label="Sections">
            <a href="#features">Product</a>
            <a href="#how">How it works</a>
            <a href="#control">Control</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="nav-cta">
            {user ? <Link className="btn" to="/app">Open app <span className="arrow">→</span></Link> : <>
              <Link className="btn ghost" to="/login">Log in</Link>
              <Link className="btn lime" to="/signup">Get started</Link>
            </>}
          </div>
        </div>
      </header>

      <main>
        <section className="hero wrap">
          <div>
            <span className="eyebrow">Your AI business development team</span>
            <h1 className="display">
              Let AI{' '}
              <RotatingText
                texts={['find clients', 'qualify leads', 'write outreach', 'handle replies', 'draft proposals']}
                mainClassName="rotator"
                staggerFrom="last"
                staggerDuration={0.02}
                rotationInterval={2400}
                splitLevelClassName="rotator-split"
              />
              <br />while you do the work.
            </h1>
            <BlurText
              className="lede"
              text="Describe what you sell and who you sell to. easySales researches prospects, scores them against your ideal customer, starts the conversation and drafts the proposal, all inside limits you set."
              delay={40}
              animateBy="words"
            />
            <div className="hero-cta">
              <Link className="btn lg lime" to={appHref}>Build my pipeline <span className="arrow">→</span></Link>
              <a className="btn lg ghost" href="#how">See how it works</a>
            </div>
            <div className="hero-stats">
              <div><div className="num"><CountUp to={6} duration={1.2} /></div><div className="label">ICP criteria per lead</div></div>
              <div><div className="num"><CountUp to={100} duration={1.6} />%</div><div className="label">actions audited</div></div>
              <div><div className="num"><CountUp from={0} to={9} direction="down" duration={1.4} /></div><div className="label">emails sent without your rules</div></div>
            </div>
          </div>

          <div className="collage">
            <div className="collage-main">
              <TiltedCard
                imageSrc={photo('counter', 1100, 1000)}
                altText="A shop owner talking with a customer at the counter"
                containerHeight="100%"
                containerWidth="100%"
                imageHeight="100%"
                imageWidth="100%"
                rotateAmplitude={8}
                scaleOnHover={1.03}
                showMobileWarning={false}
                showTooltip={false}
                displayOverlayContent
                overlayContent={<div className="tilt-overlay"><span className="badge lime plain">Lead qualified · fit 92 · coverage 85%</span></div>}
              />
            </div>
            <div className="collage-side"><img src={photo('meeting', 600, 420)} alt="A team discussing a proposal" loading="lazy" /></div>
            <div className="float-card float-1"><span className="ic">R</span><span><b>Research done</b><span className="muted">3 pages read · 7 facts</span></span></div>
            <div className="float-card float-2"><span className="ic">✓</span><span><b>Draft approved</b><span className="muted">by you, 10:42</span></span></div>
            <div className="float-card float-3"><span className="ic">₹</span><span><b>Proposal ready</b><span className="muted">priced by your catalogue</span></span></div>
          </div>
        </section>

        <div className="marquee" aria-label="Who it is for">
          <div className="marquee-track">
            {[...INDUSTRIES, ...INDUSTRIES].map((t, i) => <span key={i} className="tag">{t}</span>)}
          </div>
        </div>

        <section id="features" className="section wrap">
          <div className="section-head">
            <span className="eyebrow">What the agents do</span>
            <h2 className="display">A whole sales desk, <span className="hl">minus the busywork.</span></h2>
          </div>
          <div className="bento">
            <div className="b-wide">
              <SpotlightCard className="feature" theme="light" spotlightColor="rgba(200, 241, 105, 0.35)">
                <div className="feature-body">
                  <h3>Research that shows its sources</h3>
                  <p>Each prospect's website is read and turned into findings with links. Verified facts and guesses are shown separately, so you know what to trust.</p>
                </div>
                <div className="mini-ui">
                  <div className="mini-row"><span>Runs 3 clinics in Pune</span><span className="badge ok">verified</span></div>
                  <div className="mini-row"><span>Bookings are phone-only</span><span className="badge ok">verified</span></div>
                  <div className="mini-row"><span>Likely needs online booking</span><span className="badge warn">hypothesis</span></div>
                </div>
              </SpotlightCard>
            </div>
            <div className="b-third">
              <SpotlightCard className="feature" theme="dark" spotlightColor="rgba(200, 241, 105, 0.3)" style={{ background: 'var(--forest)' }}>
                <div className="feature-body dark">
                  <h3 style={{ color: '#fff' }}>Scores by code</h3>
                  <p style={{ color: '#b9cbc1' }}>Six weighted criteria. Unknown is never a mismatch, and coverage is shown next to the score.</p>
                </div>
                <div className="mini-ui" style={{ background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.12)', color: '#eaf2ec' }}>
                  <div className="mini-row"><span>Fit score</span><b className="num" style={{ color: 'var(--lime)', fontSize: 22 }}>86</b></div>
                  <div className="meter" style={{ background: 'rgba(255,255,255,0.12)' }}><i style={{ width: '86%' }} /></div>
                  <div className="mini-row"><span>Evidence coverage</span><b>75%</b></div>
                </div>
              </SpotlightCard>
            </div>
            <div className="b-third">
              <SpotlightCard className="feature" theme="light" spotlightColor="rgba(200, 241, 105, 0.35)">
                <div className="feature-body"><h3>Outreach in your voice</h3><p>Specific first emails and polite follow-ups, using only claims you approved.</p></div>
                <div className="feature-img"><img src={photo('owner', 700, 400)} alt="A business owner reading on a laptop" loading="lazy" /></div>
              </SpotlightCard>
            </div>
            <div className="b-third">
              <SpotlightCard className="feature" theme="light" spotlightColor="rgba(200, 241, 105, 0.35)">
                <div className="feature-body"><h3>Replies, handled</h3><p>Intent detected, needs captured into the CRM, next step drafted. Opt-outs stop everything.</p></div>
                <div className="feature-img"><img src={photo('coffee', 700, 400)} alt="A customer at a coffee counter" loading="lazy" /></div>
              </SpotlightCard>
            </div>
            <div className="b-third">
              <SpotlightCard className="feature" theme="light" spotlightColor="rgba(200, 241, 105, 0.35)">
                <div className="feature-body"><h3>Proposals, priced right</h3><p>Numbers come from your catalogue. Discounts beyond your limit wait for approval.</p></div>
                <div className="feature-img"><img src={photo('team', 700, 400)} alt="A team reviewing documents" loading="lazy" /></div>
              </SpotlightCard>
            </div>
          </div>
        </section>

        <section id="how" className="section wrap" style={{ paddingTop: 0 }}>
          <div className="section-head">
            <span className="eyebrow">How it works</span>
            <h2 className="display">From spreadsheet to signed, in four steps.</h2>
          </div>
          <div className="steps-grid">
            {STEPS.map((s) => (
              <article key={s.title} className="step-card">
                <div className="img"><img src={photo(s.img, 600, 360)} alt="" loading="lazy" /></div>
                <div className="txt"><h4>{s.title}</h4><p>{s.copy}</p></div>
              </article>
            ))}
          </div>
        </section>

        <section id="control" className="section wrap" style={{ paddingTop: 0 }}>
          <div className="control">
            <div style={{ position: 'relative', zIndex: 1 }}>
              <span className="eyebrow" style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--lime)', borderColor: 'rgba(255,255,255,0.12)' }}>You stay in control</span>
              <h2 className="display" style={{ margin: '18px 0 14px' }}>Autonomy inside the lines you draw.</h2>
              <p className="lede">The AI reasons. Your policy decides. Code executes, exactly once, with a full audit trail.</p>
              <div style={{ marginTop: 18 }}>
                {[
                  ['Research and score leads', 'Automatic', 'ok'],
                  ['Send outreach within daily caps', 'Your choice', 'warn'],
                  ['Discount above your limit', 'Approval', 'warn'],
                  ['Contact someone who opted out', 'Never', 'bad'],
                  ['Sign contracts or take payments', 'Human only', 'bad'],
                ].map(([rule, mode, t]) => (
                  <div className="rule" key={rule}><span>{rule}</span><span className={`badge ${t}`}>{mode}</span></div>
                ))}
              </div>
            </div>
            <div className="approval-mock">
              <div className="row-flex between"><b>Approval · outreach</b><span className="badge warn">pending</span></div>
              <pre>{`To: priya@acmedental.in
Subject: Online booking for Acme Dental

Hi Priya, every page on your site says "call to book". We've built booking flows for clinics so patients can pick a slot in under a minute. Worth a 20-minute chat next week?`}</pre>
              <div className="row-flex"><span className="btn sm">Approve & send</span><span className="btn sm ghost">Edit draft</span></div>
            </div>
          </div>
        </section>

        <section className="section wrap" style={{ paddingTop: 0 }}>
          <div className="section-head">
            <span className="eyebrow">Built for service businesses</span>
            <h2 className="display">If you sell expertise, it sells for you.</h2>
          </div>
          <div className="cases">
            {[
              { img: 'shop' as const, h: 'Agencies & studios', p: 'Find businesses with outdated sites or slow funnels and pitch with a concrete observation.' },
              { img: 'presenting' as const, h: 'Consultancies', p: 'Qualify by size, region and buying signals before anyone spends an hour on a call.' },
              { img: 'tablet' as const, h: 'Local B2B services', p: 'Steady, polite outreach that respects quiet hours and stops the moment someone says no.' },
            ].map((c) => (
              <div key={c.h} style={{ height: 380 }}>
                <TiltedCard
                  imageSrc={photo(c.img, 800, 760)}
                  altText={c.h}
                  containerHeight="380px" containerWidth="100%" imageHeight="380px" imageWidth="100%"
                  rotateAmplitude={10} scaleOnHover={1.04} showMobileWarning={false} showTooltip={false}
                  displayOverlayContent
                  overlayContent={<div className="tilt-overlay" style={{ background: 'linear-gradient(180deg, transparent 35%, rgba(14,31,24,.85))', borderRadius: 15 }}>
                    <h3 className="h2" style={{ color: '#fff' }}>{c.h}</h3><p style={{ margin: '6px 0 0', color: '#d6e3db', fontSize: 14 }}>{c.p}</p>
                  </div>}
                />
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className="section wrap" style={{ paddingTop: 0 }}>
          <div className="faq">
            <div className="section-head" style={{ marginBottom: 0 }}>
              <span className="eyebrow">FAQ</span>
              <h2 className="display">Fair questions, straight answers.</h2>
              <p className="lede">Still unsure? Start free; new workspaces can't send anything until you say so.</p>
            </div>
            <div>{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
          </div>
        </section>

        <section className="wrap" style={{ paddingBottom: 24 }}>
          <div className="cta-band">
            <img src={photo('workshop', 1600, 800)} alt="" loading="lazy" />
            <div>
              <Logo dark size={40} />
              <h2 className="display">Your pipeline, filling itself.</h2>
              <Link className="btn lg lime" to={appHref}>Start free <span className="arrow">→</span></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="wrap footer">
        <Logo size={24} />
        <span>© {new Date().getFullYear()} easySales · Photos from Unsplash</span>
      </footer>
    </div>
  )
}
