import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getOrgId, refreshSession, setAccessToken, setOrgId } from './api'
import type { OrgSummary, User } from './types'

interface AuthState {
  ready: boolean
  user: User | null
  organizations: OrgSummary[]
  org: OrgSummary | null
  isPlatformAdmin: boolean
  isSupport: boolean
  login(email: string, password: string): Promise<User>
  signup(input: { name: string; email: string; password: string; organizationName?: string }): Promise<User>
  verify(otp: string): Promise<void>
  logout(): Promise<void>
  switchOrg(id: string): void
  reload(): Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

interface SessionData { user: User; accessToken: string }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [organizations, setOrganizations] = useState<OrgSummary[]>([])
  const [orgId, setOrgState] = useState<string | null>(getOrgId())
  const [isPlatformAdmin, setAdmin] = useState(false)
  const [isSupport, setSupport] = useState(false)

  const loadMe = useCallback(async () => {
    const me = await api<{ user: User; organizations: OrgSummary[]; isPlatformAdmin?: boolean; isSupport?: boolean }>('/auth/me')
    setUser(me.user)
    setAdmin(Boolean(me.isPlatformAdmin))
    setSupport(Boolean(me.isSupport))
    setOrganizations(me.organizations)
    // keep a valid active organization selected
    const current = getOrgId()
    if (!current || !me.organizations.some((o) => o.id === current)) {
      const first = me.organizations[0]?.id ?? null
      setOrgId(first)
      setOrgState(first)
    }
  }, [])

  // restore the session from the refresh cookie on first load
  useEffect(() => {
    refreshSession()
      .then(async (ok) => { if (ok) await loadMe() })
      .catch(() => undefined)
      .finally(() => setReady(true))
  }, [loadMe])

  const start = useCallback(async (data: SessionData) => {
    setAccessToken(data.accessToken)
    await loadMe()
    return data.user
  }, [loadMe])

  const value = useMemo<AuthState>(() => ({
    ready,
    user,
    organizations,
    org: organizations.find((o) => o.id === orgId) ?? organizations[0] ?? null,
    isPlatformAdmin,
    isSupport,
    login: async (email, password) => start(await api<SessionData>('/auth/login', { body: { email, password } })),
    signup: async (input) => start(await api<SessionData>('/auth/signup', { body: input })),
    verify: async (otp) => { await start(await api<SessionData>('/auth/verify-email', { body: { otp } })) },
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined)
      setAccessToken(null)
      setUser(null)
      setOrganizations([])
    },
    switchOrg: (id) => { setOrgId(id); setOrgState(id) },
    reload: loadMe,
  }), [ready, user, organizations, orgId, start, loadMe, isPlatformAdmin, isSupport])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
