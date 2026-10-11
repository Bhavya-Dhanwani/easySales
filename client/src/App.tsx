import { lazy, Suspense, useEffect } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router'
import { Forgot, Login, Reset, Signup, Verify } from './pages/Auth'
import { Empty, Spinner } from './components/ui'

// route-level code splitting: the landing page and the app load separately
const Landing = lazy(() => import('./pages/Landing'))
const AppLayout = lazy(() => import('./app/AppLayout'))
const Overview = lazy(() => import('./app/Overview'))
const Onboarding = lazy(() => import('./app/Onboarding'))
const Leads = lazy(() => import('./app/Leads'))
const LeadDetail = lazy(() => import('./app/LeadDetail'))
const ImportWizard = lazy(() => import('./app/ImportWizard'))
const Research = lazy(() => import('./app/Research'))
const Email = lazy(() => import('./app/Email'))
const Campaigns = lazy(() => import('./app/Campaigns'))
const Analytics = lazy(() => import('./app/Analytics'))
const Experiments = lazy(() => import('./app/Analytics').then((m) => ({ default: m.Experiments })))
const CampaignDetail = lazy(() => import('./app/Campaigns').then((m) => ({ default: m.CampaignDetail })))
const ReviewQueue = lazy(() => work().then((m) => ({ default: m.ReviewQueue })))
const work = () => import('./app/Work')
const Approvals = lazy(() => work().then((m) => ({ default: m.Approvals })))
const Inbox = lazy(() => work().then((m) => ({ default: m.Inbox })))
const Runs = lazy(() => work().then((m) => ({ default: m.Runs })))
const settings = () => import('./app/Settings')
const Audit = lazy(() => settings().then((m) => ({ default: m.Audit })))
const Business = lazy(() => settings().then((m) => ({ default: m.Business })))
const Policies = lazy(() => settings().then((m) => ({ default: m.Policies })))
const Suppressions = lazy(() => settings().then((m) => ({ default: m.Suppressions })))
const Team = lazy(() => settings().then((m) => ({ default: m.Team })))
const Usage = lazy(() => settings().then((m) => ({ default: m.Usage })))
const Ops = lazy(() => import('./app/Ops'))

// scroll to top on route change (keeps #hash links working)
function ScrollReset() {
  const { pathname, hash } = useLocation()
  useEffect(() => { if (!hash) window.scrollTo(0, 0) }, [pathname, hash])
  return null
}

export default function App() {
  return (
    <>
      <ScrollReset />
      <Suspense fallback={<div style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}><Spinner /></div>}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset-password/:token" element={<Reset />} />
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<Overview />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="leads" element={<Leads />} />
          <Route path="leads/import" element={<ImportWizard />} />
          <Route path="leads/:id" element={<LeadDetail />} />
          <Route path="research" element={<Research />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="review" element={<ReviewQueue />} />
          <Route path="campaigns" element={<Campaigns />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="experiments" element={<Experiments />} />
          <Route path="campaigns/:id" element={<CampaignDetail />} />
          <Route path="email" element={<Email />} />
          <Route path="runs" element={<Runs />} />
          <Route path="business" element={<Business />} />
          <Route path="policies" element={<Policies />} />
          <Route path="team" element={<Team />} />
          <Route path="suppressions" element={<Suppressions />} />
          <Route path="audit" element={<Audit />} />
          <Route path="usage" element={<Usage />} />
          <Route path="ops" element={<Ops />} />
        </Route>
        <Route path="*" element={<div style={{ padding: '15vh 16px' }}><Empty title="Nothing here." action={<Link className="btn" to="/">Go home</Link>} /></div>} />
      </Routes>
      </Suspense>
    </>
  )
}
