// Client for POST /api/glixel/chat. The server owns the persona and routing;
// the app sends only the visible user/assistant turns and renders the stream.
import { ApiError, apiSend } from './session'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** Routing facts the router reported for this reply (never guessed). */
export interface RouteInfo {
  platform: string
  model: string
  displayName: string
  fallbackAttempts: number
  fallbackTrail: string | null
}

export interface ChatOutcome {
  route: RouteInfo | null
  text: string
  finishReason: string | null
  latencyMs: number | null
  /** Set when the request failed; `text` keeps whatever arrived first. */
  error: { message: string; code: string | null; status: number | null } | null
  aborted: boolean
}

export interface StreamHandlers {
  onRoute?: (route: RouteInfo) => void
  onDelta?: (text: string) => void
}

/** Turns stored history into what the server accepts: no error bubbles, no empties. */
export function toChatTurns(messages: Array<{ role: 'user' | 'assistant'; content: string; isError?: boolean }>): ChatTurn[] {
  return messages
    .filter(m => !m.isError && m.content.trim() !== '')
    .map(m => ({ role: m.role, content: m.content }))
}

/** Parses SSE `data:` lines; returns complete events and the unparsed tail. */
export function parseSseChunk(buffer: string): { events: Array<Record<string, unknown>>; rest: string } {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: Array<Record<string, unknown>> = []
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore a malformed line */ }
    }
  }
  return { events, rest }
}

export async function streamChat(
  turns: ChatTurn[],
  opts: { conversationId?: number; signal?: AbortSignal } & StreamHandlers = {},
): Promise<ChatOutcome> {
  const outcome: ChatOutcome = { route: null, text: '', finishReason: null, latencyMs: null, error: null, aborted: false }
  let res: Response
  try {
    res = await apiSend('POST', '/api/glixel/chat', {
      messages: turns,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    }, opts.signal)
  } catch (err) {
    if (opts.signal?.aborted) return { ...outcome, aborted: true }
    if (err instanceof ApiError) return { ...outcome, error: { message: err.message, code: null, status: err.status } }
    return { ...outcome, error: { message: 'Could not reach your FreeLLMAPI server.', code: 'network_error', status: null } }
  }

  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    let message = `The server answered ${res.status}.`
    let code: string | null = null
    try {
      const body = await res.json() as { error?: { message?: string; code?: string | null } }
      message = body.error?.message ?? message
      code = body.error?.code ?? null
    } catch { /* not JSON */ }
    return { ...outcome, error: { message, code, status: res.status } }
  }

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = parseSseChunk(buffer)
      buffer = rest
      for (const e of events) {
        if (e.type === 'route') {
          outcome.route = {
            platform: String(e.platform), model: String(e.model), displayName: String(e.displayName),
            fallbackAttempts: Number(e.fallbackAttempts ?? 0),
            fallbackTrail: typeof e.fallbackTrail === 'string' ? e.fallbackTrail : null,
          }
          opts.onRoute?.(outcome.route)
        } else if (e.type === 'delta' && typeof e.text === 'string') {
          outcome.text += e.text
          opts.onDelta?.(e.text)
        } else if (e.type === 'done') {
          finished = true
          outcome.finishReason = typeof e.finishReason === 'string' ? e.finishReason : null
          outcome.latencyMs = typeof e.latencyMs === 'number' ? e.latencyMs : null
        } else if (e.type === 'error') {
          finished = true
          outcome.error = { message: String(e.message ?? 'The provider failed mid-answer.'), code: typeof e.code === 'string' ? e.code : null, status: null }
        }
      }
    }
  } catch {
    if (opts.signal?.aborted) return { ...outcome, aborted: true }
    outcome.error = { message: 'The connection dropped before the answer finished.', code: 'stream_interrupted', status: null }
    return outcome
  }
  if (opts.signal?.aborted) return { ...outcome, aborted: true }
  if (!finished) outcome.error = { message: 'The answer ended unexpectedly.', code: 'stream_incomplete', status: null }
  return outcome
}

/** Plain-language guidance for the error codes the server returns. */
export function errorHint(code: string | null, status: number | null): string | null {
  switch (code) {
    case 'no_providers_configured': return 'No free provider is set up yet. Add a key on the dashboard\'s Keys page.'
    case 'free_only_blocked': return 'Free-only routing refused every configured provider. Add a key for a free provider, or opt one in on the server.'
    case 'rate_limit_exceeded':
    case 'routing_exhausted': return 'Every free model is busy or rate-limited right now. Try again shortly.'
    case 'provider_authentication_failed': return 'A provider rejected its key. Check it on the dashboard\'s Providers page.'
    case 'conversation_too_long': return 'This conversation is too long. Start a new one.'
    case 'network_error': return 'Is the FreeLLMAPI server running?'
    default: return status === 401 ? 'Your session has expired. Sign in on the dashboard again.' : null
  }
}
