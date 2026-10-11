import { Link, NavLink, useLocation } from 'react-router'
import { Logo } from '../components/ui'

const UPDATED = '11 October 2026'
const SUPPORT = 'support@easysales.app'

// customer-facing help and policies; terms and privacy must be reviewed by a lawyer before launch
const PAGES: Record<string, { title: string; body: React.ReactNode }> = {
  help: {
    title: 'Help & plans',
    body: <>
      <h2>What easySales does</h2>
      <p>easySales researches your leads, scores them against your ideal customer, writes and sends outreach from your own mailbox, handles replies, books meetings from your real calendar, builds demo pages from approved templates and prepares proposals priced from your own price list.</p>
      <h2>Finding leads and reading replies</h2>
      <p>Under <b>Leads → Find leads</b>, describe a kind of business and a place. easySales searches OpenStreetMap, plus Google Places, Apollo and web search when they are enabled, and shows one merged list. You choose who to add and record why you may contact them; research then reads each business&apos;s website and finds its public contact email.</p>
      <p>Replies are read from your connected inbox every minute (read-only). Only replies from your leads are opened; other mail is never downloaded or stored.</p>
      <h2>What it will not do</h2>
      <ul>
        <li>Contact anyone before you activate your workspace, anyone who opted out, or anyone without a recorded consent basis.</li>
        <li>Invent prices, discounts, guarantees or meeting times. Prices come from your price list; discounts above your limit need your approval.</li>
        <li>Mark a deal as won without a recorded acceptance, sign contracts, or take payments.</li>
      </ul>
      <h2>AI-generated content</h2>
      <p>Research summaries, emails, replies, demo text and proposal narratives are written by AI. They can be wrong. Every claim is limited to the approved claims you configure, and in Copilot mode (the default) a person approves every message before it is sent. You are responsible for what is sent on your behalf.</p>
      <h2>Plans and limits</h2>
      <p>Each plan includes a number of team members, research jobs, emails and demo builds per billing period, shown under <b>Plan &amp; billing</b> with live usage. Separately, your monthly spending limit caps what that work may cost. Either one pauses the work when reached; queued emails are held, never dropped, and resume next period or after an upgrade.</p>
      <h2>Trials, payment and cancellation</h2>
      <p>New workspaces get a 14-day trial. If a payment fails, the workspace keeps working for a 7-day grace period, then becomes read-only until paid. You can cancel at any time; access continues until the end of the paid period, and you can export all your data.</p>
      <h2>Your data</h2>
      <p>Your data is kept separate from every other business, mailbox and CRM credentials are stored encrypted, and you can export or delete your workspace at any time (Settings → Team / Organization).</p>
      <h2>Support</h2>
      <p>Email <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a> with your workspace name. We answer within one business day; incidents affecting sending or data are handled first.</p>
    </>,
  },
  terms: {
    title: 'Terms of service',
    body: <>
      <p><b>Summary.</b> You may use easySales to find and contact business prospects lawfully. You are responsible for your leads, consent records, the content sent in your name and your compliance with marketing and privacy laws where you operate.</p>
      <h2>Your responsibilities</h2>
      <ul>
        <li>Only import contacts you are allowed to contact, and record a consent or lawful basis for each.</li>
        <li>Configure accurate services, prices and approved claims; review AI output according to the autonomy level you choose.</li>
        <li>Do not use the service for spam, deceptive content or anything unlawful. We may suspend workspaces that do.</li>
      </ul>
      <h2>Service</h2>
      <p>We provide the service as described in Help &amp; plans, with reasonable care and no guarantee of sales results. AI output may contain errors. Our liability is limited to the fees you paid in the previous three months, except where the law does not allow limits.</p>
      <h2>Fees</h2>
      <p>Fees are charged in advance per billing period through our payment provider. Taxes may apply. Refunds are handled case by case through support.</p>
      <h2>Ending</h2>
      <p>You can cancel any time. You can export your data before and for 30 days after cancellation, after which it is deleted.</p>
    </>,
  },
  privacy: {
    title: 'Privacy',
    body: <>
      <p><b>Summary.</b> For your prospects&apos; data you are the controller and we process it on your instructions. For your own account data we are the controller.</p>
      <h2>What we process</h2>
      <ul>
        <li>Account data: names, emails, roles, sign-in and billing status.</li>
        <li>Your business data: leads, research from public websites, conversations, demos, proposals and analytics.</li>
        <li>Connected services: encrypted mailbox and CRM/calendar credentials, used only for the actions you enable. When inbox reading is on, we check the sender of new mail and download only replies from your leads; other mail is never stored.</li>
        <li>Lead search: publicly listed business details (name, website, phone, address, published contact email) from OpenStreetMap and, if enabled, Google Places, Apollo and web search, saved only for the businesses you choose to add.</li>
      </ul>
      <h2>AI providers</h2>
      <p>To write research, emails and replies, relevant parts of your data are sent to our AI model provider under terms that do not allow training on it.</p>
      <h2>Monitoring</h2>
      <p>To find and fix errors in AI output, we may send traces of AI requests to our monitoring provider, Neatlogs. A trace contains the request and response, timing and token counts, and personal data is redacted first. We can also send timing and counts only. Traces are used only to operate and improve the service.</p>
      <h2>Retention and deletion</h2>
      <p>Messages and audit records are kept for the periods set in your workspace policy; you can export or delete your workspace at any time. Opt-out records are kept so that nobody who opted out is contacted again.</p>
      <h2>Security</h2>
      <p>Each business&apos;s data is isolated; credentials are encrypted; access by our support staff is limited, read-only by default and recorded in your audit log.</p>
      <h2>Contact</h2>
      <p>Privacy requests: <a href={`mailto:${SUPPORT}`}>{SUPPORT}</a>.</p>
    </>,
  },
}

export default function Legal() {
  const page = useLocation().pathname.slice(1) || 'help'
  const p = PAGES[page] ?? PAGES.help
  return (
    <div style={{ maxWidth: 780, margin: '0 auto', padding: '32px 20px 80px' }} className="stack lg">
      <div className="row-flex between"><Link to="/" aria-label="Home"><Logo /></Link><nav className="row-flex">{Object.keys(PAGES).map((k) => <NavLink key={k} to={`/${k}`} className="small">{PAGES[k].title}</NavLink>)}</nav></div>
      <article className="stack legal">
        <h1 className="h1">{p.title}</h1>
        <span className="small muted">Last updated {UPDATED}</span>
        {p.body}
      </article>
    </div>
  )
}
