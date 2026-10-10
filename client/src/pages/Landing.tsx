import { Link } from 'react-router'
import { Logo } from '../components/ui'
import { useAuth } from '../lib/auth'
import { photo, PHOTOS } from '../lib/photos'
import BlurText from '../components/bits/BlurText'
import RotatingText from '../components/bits/RotatingText'
import CountUp from '../components/bits/CountUp'
import BounceCards from '../components/bits/BounceCards'
import ScrollVelocity from '../components/bits/ScrollVelocity'
import ImageTrail from '../components/bits/ImageTrail'
import ChromaGrid from '../components/bits/ChromaGrid'
import PixelTransition from '../components/bits/PixelTransition'
import CircularGallery from '../components/bits/CircularGallery'
import './landing.css'

const ALL = Object.keys(PHOTOS) as (keyof typeof PHOTOS)[]

const CAPABILITIES = [
  { image: photo('tablet', 700, 520), title: 'Research with receipts', subtitle: 'Reads up to three pages per prospect; every claim links to its source.', accent: '#c8f169' },
  { image: photo('workshop', 700, 520), title: 'Scored by code', subtitle: 'Six weighted ICP criteria. Unknown is never a mismatch.', accent: '#7fd6a4' },
  { image: photo('owner', 700, 520), title: 'Outreach in your voice', subtitle: 'Approved claims only, evidence-checked personalisation.', accent: '#c8f169' },
  { image: photo('coffee', 700, 520), title: 'Replies, understood', subtitle: 'Nine intents, opt-outs caught before the AI reads them.', accent: '#7fd6a4' },
  { image: photo('team', 700, 520), title: 'Follow-ups that stop', subtitle: 'Business-day cadence that ends the moment someone replies.', accent: '#c8f169' },
  { image: photo('presenting', 700, 520), title: 'Proposals priced right', subtitle: 'Numbers from your catalogue; discounts wait for you.', accent: '#7fd6a4' },
]

const STEPS = [
  { img: 'workshop' as const, n: '01', title: 'Teach it your business', copy: 'Services, prices, ideal customer, the claims it may make.' },
  { img: 'laptop' as const, n: '02', title: 'Bring your leads', copy: 'CSV with column mapping, dedupe and an error report.' },
  { img: 'tablet' as const, n: '03', title: 'Research & score', copy: 'Agents read each site; code calculates the fit.' },
  { img: 'presenting' as const, n: '04', title: 'Talk & close', copy: 'Campaigns, replies and proposals inside your policy.' },
]

const FAQ = [
  ['Will it email people without asking me?', 'Not unless you allow it. New workspaces start in approval mode: every message waits for you. Consent, opt-outs, daily and hourly caps, follow-up spacing and quiet hours are enforced by code, not by the model.'],
  ['How is a lead scored?', 'The research agent rates six criteria and must cite pages it actually read. Code turns that into a fit score plus a separate evidence-coverage number, so missing information never looks like a bad fit.'],
  ['Whose email address does it send from?', 'Yours. Connect your own mailbox over SMTP; the password is verified once and stored encrypted. Replies, bounces and complaints come back through a signed webhook.'],
  ['What happens when someone says stop?', 'Opt-out language is detected before any AI sees it. The address is suppressed instantly, every pending message and follow-up is cancelled, and nobody, human or agent, can email it again from the app.'],
  ['Is my data separated from other businesses?', 'Every record is scoped to your organization, and the database refuses unscoped queries. Cross-tenant access is covered by automated tests. Export or delete everything whenever you like.'],
]

export default function Landing() {
  const { user } = useAuth()
  const appHref = user ? '/app' : '/signup'

  return (
    <div className="lp">
      <header className="nav">
        <div className="wrap nav-inner">
          <Link to="/" aria-label="easySales home"><Logo /></Link>
          <nav className="nav-links" aria-label="Sections">
            <a href="#product">Product</a>
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
        {/* hero: text on a left editorial column, a bouncing photo stack offset to the right */}
        <section className="hero wrap">
          <div className="hero-copy">
            <span className="eyebrow">AI business development, under your rules</span>
            <h1 className="display">
              Let AI{' '}
              <RotatingText texts={['find clients', 'qualify leads', 'write outreach', 'handle replies', 'draft proposals']}
                mainClassName="rotator" staggerFrom="last" staggerDuration={0.02} rotationInterval={2400} />
              <br />while you do the work.
            </h1>
            <BlurText className="lede" delay={35} animateBy="words"
              text="Describe what you sell and who you sell to. easySales researches prospects, scores them against your ideal customer, writes the first email and follows up, until someone replies or says stop." />
            <div className="hero-cta">
              <Link className="btn lg lime" to={appHref}>Build my pipeline <span className="arrow">→</span></Link>
              <a className="btn lg ghost" href="#how">See how it works</a>
            </div>
            <dl className="hero-stats">
              <div><dt className="num"><CountUp to={6} duration={1.2} /></dt><dd>ICP criteria per lead</dd></div>
              <div><dt className="num"><CountUp to={9} duration={1.4} /></dt><dd>reply intents understood</dd></div>
              <div><dt className="num"><CountUp to={100} duration={1.6} />%</dt><dd>of actions audited</dd></div>
            </dl>
          </div>
          <div className="hero-art" aria-label="Photos of the businesses easySales works for">
            <div className="bounce-scale">
              <BounceCards
                images={['counter', 'owner', 'meeting', 'shop', 'coffee'].map((k) => ({ src: photo(k as keyof typeof PHOTOS, 460, 460), alt: '' }))}
                containerWidth={600} containerHeight={540} cardSize={280} spread={80} rotation={9} arc={14}
                borderWidth={6} borderColor="#ffffff" radius={26} pushDistance={140} hoverScale={1.08}
              />
            </div>
            <div className="hero-note"><span className="pulse" /> Hover the stack</div>
          </div>
        </section>

        <div className="velocity" aria-hidden="true">
          <ScrollVelocity
            texts={['Research · Qualify · Reach out · Follow up · Close ·', 'Agencies · Clinics · Studios · Consultancies · B2B services ·']}
            velocity={60}
            className="velocity-text"
          />
        </div>

        {/* cursor trail: the prospects behind every row of a spreadsheet */}
        <section className="trail-section wrap">
          <div className="trail">
            <div className="trail-copy">
              <span className="eyebrow dark">Every lead is a person</span>
              <h2 className="display">Behind every row is a business <em>worth understanding.</em></h2>
              <p>Move your cursor. easySales reads each prospect before it writes a word, so your first email sounds like you did your homework, because it did.</p>
            </div>
            <ImageTrail items={ALL.map((k) => photo(k, 380, 360))} variant={1} />
          </div>
        </section>

        {/* capabilities: sticky heading on the left, spotlight cards on the right */}
        <section id="product" className="section wrap split-section">
          <div className="split-head">
            <span className="eyebrow">What the agents do</span>
            <h2 className="display">A whole sales desk, <span className="hl">minus the busywork.</span></h2>
            <p className="lede">Hover a card. Each capability is a separate agent with one job and no permission to do anything else.</p>
            <Link className="btn ghost" to={appHref}>Try it free <span className="arrow">→</span></Link>
          </div>
          <div className="chroma-wrap">
            <ChromaGrid items={CAPABILITIES} columns={2} minCardWidth={240} theme="light" reveal="spotlight" radius={300} />
          </div>
        </section>

        {/* steps: staggered pixel-transition cards */}
        <section id="how" className="section wrap">
          <div className="section-head">
            <span className="eyebrow">How it works</span>
            <h2 className="display">From spreadsheet to signed, in four steps.</h2>
          </div>
          <div className="steps-row">
            {STEPS.map((s) => (
              <PixelTransition
                key={s.n}
                className="step-pixel"
                aspectRatio="120%"
                gridSize={12}
                pixelColor="#c8f169"
                pattern="random"
                firstContent={<div className="step-face"><img src={photo(s.img, 600, 720)} alt="" loading="lazy" /><span className="step-n">{s.n}</span><span className="step-title">{s.title}</span></div>}
                secondContent={<div className="step-back"><span className="step-n dark">{s.n}</span><h3>{s.title}</h3><p>{s.copy}</p></div>}
              />
            ))}
          </div>
        </section>

        {/* WebGL curved gallery */}
        <section className="gallery-section">
          <div className="wrap gallery-head">
            <span className="eyebrow">Built for service businesses</span>
            <h2 className="display">If you sell expertise, it sells for you.</h2>
            <p className="muted">Drag or scroll the gallery.</p>
          </div>
          <div className="gallery">
            <CircularGallery
              items={[
                { image: photo('shop', 900, 700), text: 'Retail & local' },
                { image: photo('presenting', 900, 700), text: 'Consultancies' },
                { image: photo('tablet', 900, 700), text: 'Clinics' },
                { image: photo('meeting', 900, 700), text: 'Agencies' },
                { image: photo('workshop', 900, 700), text: 'Studios' },
                { image: photo('coffee', 900, 700), text: 'Hospitality' },
                { image: photo('team', 900, 700), text: 'B2B services' },
              ]}
              bend={2.4}
              textColor="#0f3d2e"
              borderRadius={0.06}
              font='700 30px "Bricolage Grotesque"'
              scrollSpeed={2}
            />
          </div>
        </section>

        <section id="control" className="section wrap">
          <div className="control">
            <div style={{ position: 'relative', zIndex: 1 }}>
              <span className="eyebrow dark">You stay in control</span>
              <h2 className="display" style={{ margin: '18px 0 14px' }}>Autonomy inside the lines you draw.</h2>
              <p className="lede">The AI reasons. Your policy decides. Code executes, exactly once, with a full audit trail.</p>
              <div style={{ marginTop: 18 }}>
                {[
                  ['Research and score leads', 'Automatic', 'ok'],
                  ['Send within daily and hourly caps', 'Your choice', 'warn'],
                  ['Pricing questions and complaints', 'Human review', 'warn'],
                  ['Contact someone who opted out', 'Never', 'bad'],
                  ['Sign contracts or take payments', 'Human only', 'bad'],
                ].map(([rule, mode, t]) => <div className="rule" key={rule}><span>{rule}</span><span className={`badge ${t}`}>{mode}</span></div>)}
              </div>
            </div>
            <div className="approval-mock">
              <div className="row-flex between"><b>Review · outreach</b><span className="badge warn">pending</span></div>
              <pre>{`To: priya@acmedental.in
Subject: Online booking for Acme Dental

Hi Priya, every page on your site says "call to book". We've built booking flows for clinics so patients can pick a slot in under a minute. Worth a 20-minute chat next week?`}</pre>
              <div className="claims"><span className="badge ok">“every page says call to book” · backed by acmedental.in</span></div>
              <div className="row-flex"><span className="btn sm">Approve & send</span><span className="btn sm ghost">Edit draft</span></div>
            </div>
          </div>
        </section>

        <section id="faq" className="section wrap">
          <div className="faq">
            <div className="section-head" style={{ marginBottom: 0 }}>
              <span className="eyebrow">FAQ</span>
              <h2 className="display">Fair questions, straight answers.</h2>
              <p className="lede">New workspaces can't send anything until you say so.</p>
            </div>
            <div>{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
          </div>
        </section>

        <section className="wrap end">
          <div className="end-copy">
            <h2 className="display">Your pipeline, <span className="hl">filling itself.</span></h2>
            <Link className="btn lg lime" to={appHref}>Start free <span className="arrow">→</span></Link>
          </div>
          <div className="end-strip">
            {(['counter', 'owner', 'meeting', 'coffee'] as const).map((k, i) => <img key={k} src={photo(k, 420, 520)} alt="" loading="lazy" style={{ ['--i' as string]: i }} />)}
          </div>
        </section>
      </main>

      <footer className="wrap footer">
        <Logo size={24} />
        <span>© {new Date().getFullYear()} easySales · Photos: Unsplash · Effects: React Bits</span>
      </footer>
    </div>
  )
}
