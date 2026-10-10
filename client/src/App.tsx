import { useEffect } from 'react'
import { Link, Route, Routes, useLocation } from 'react-router'
import Landing from './pages/Landing'
import { Forgot, Login, Reset, Signup, Verify } from './pages/Auth'
import AppLayout from './app/AppLayout'
import Overview from './app/Overview'
import Onboarding from './app/Onboarding'
import Leads from './app/Leads'
import LeadDetail from './app/LeadDetail'
import { Approvals, Inbox, Runs } from './app/Work'
import { Audit, Business, Policies, Suppressions, Team, Usage } from './app/Settings'
import { Empty } from './components/ui'

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
          <Route path="leads/:id" element={<LeadDetail />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="approvals" element={<Approvals />} />
          <Route path="runs" element={<Runs />} />
          <Route path="business" element={<Business />} />
          <Route path="policies" element={<Policies />} />
          <Route path="team" element={<Team />} />
          <Route path="suppressions" element={<Suppressions />} />
          <Route path="audit" element={<Audit />} />
          <Route path="usage" element={<Usage />} />
        </Route>
        <Route path="*" element={<div style={{ padding: '15vh 16px' }}><Empty title="Nothing here." action={<Link className="btn" to="/">Go home</Link>} /></div>} />
      </Routes>
    </>
  )
}
