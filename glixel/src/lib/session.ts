// GLIXEL reuses the FreeLLMAPI dashboard session: the same opaque session token
// the dashboard stores after sign-in, sent as a Bearer token to the
// session-gated /api/* routes. GLIXEL never sees a unified API key, provider
// key or encryption key; it only ever reads the session token, and only from
// the same origin.
export const SESSION_TOKEN_KEY = 'freellmapi_dashboard_token'

export function getSessionToken(): string | null {
  try { return localStorage.getItem(SESSION_TOKEN_KEY) } catch { return null }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** GET a session-gated dashboard endpoint. Throws ApiError on non-2xx. */
export async function apiGet<T>(path: string): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('GLIXEL only reads /api/* endpoints')
  const token = getSessionToken()
  if (!token) throw new ApiError(401, 'Not signed in')
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!res.ok) throw new ApiError(res.status, `${path} answered ${res.status}`)
  return (await res.json()) as T
}

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}
