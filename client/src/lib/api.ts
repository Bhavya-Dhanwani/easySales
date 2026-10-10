// Thin fetch wrapper: bearer access token in memory, refresh token in an httpOnly cookie.

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

let accessToken: string | null = null
let refreshing: Promise<boolean> | null = null

const ORG_KEY = 'easysales.org'

export const setAccessToken = (token: string | null) => { accessToken = token }

export function getOrgId() {
  try { return localStorage.getItem(ORG_KEY) } catch { return null }
}
export function setOrgId(id: string | null) {
  try {
    if (id) localStorage.setItem(ORG_KEY, id)
    else localStorage.removeItem(ORG_KEY)
  } catch { /* storage unavailable: org falls back to the first membership */ }
}

// single-flight refresh so parallel 401s only rotate the token once
export function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return false
        const json = await res.json()
        accessToken = json.data?.accessToken ?? null
        return Boolean(accessToken)
      })
      .catch(() => false)
      .finally(() => { refreshing = null })
  }
  return refreshing
}

interface Options {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

export async function api<T = unknown>(path: string, opts: Options = {}, retried = false): Promise<T> {
  const orgId = getOrgId()
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    credentials: 'include',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(orgId && path.startsWith('/v1') ? { 'X-Organization-Id': orgId } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  if (res.status === 401 && !retried && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) return api<T>(path, opts, true)
  }

  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(json.message || res.statusText || 'Request failed', res.status)
  return json.data as T
}

// a fresh key per user intent; repeat submits of the same intent reuse it
export const idempotencyKey = () => crypto.randomUUID()
