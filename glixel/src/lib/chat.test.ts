// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorHint, parseSseChunk, streamChat, toChatTurns } from './chat'
import { apiSend, isWritable, SESSION_TOKEN_KEY } from './session'

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

const sseResponse = (chunks: string[], status = 200) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close() },
}), { status, headers: { 'content-type': 'text/event-stream' } })
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

describe('parseSseChunk', () => {
  it('returns complete events and keeps a partial tail', () => {
    const { events, rest } = parseSseChunk('data: {"type":"delta","text":"a"}\n\ndata: {"type":"del')
    expect(events).toEqual([{ type: 'delta', text: 'a' }])
    expect(rest).toBe('data: {"type":"del')
  })
  it('ignores malformed lines', () => {
    expect(parseSseChunk('data: {nope\n\n').events).toEqual([])
  })
})

describe('toChatTurns', () => {
  it('drops error bubbles, empty turns and extra fields', () => {
    expect(toChatTurns([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Stopped.', isError: true },
      { role: 'assistant', content: '  ' },
      { role: 'user', content: 'again' },
    ])).toEqual([{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }])
  })
})

describe('write allowlist', () => {
  it('accepts only the listed method and path pairs', () => {
    for (const [m, p] of [['POST', '/api/glixel/chat'], ['POST', '/api/conversations'], ['PUT', '/api/conversations/12'], ['DELETE', '/api/conversations/12'],
      ['POST', '/api/keys'], ['POST', '/api/health/check/3'], ['PUT', '/api/fallback/routing']] as const) {
      expect(isWritable(m, p), `${m} ${p}`).toBe(true)
    }
    for (const [m, p] of [['DELETE', '/api/keys/3'], ['POST', '/api/keys/3/reveal'], ['POST', '/api/keys/import'], ['POST', '/api/settings/api-key/regenerate'],
      ['PUT', '/api/settings/proxy'], ['POST', '/v1/chat/completions'], ['POST', '/api/conversations/1/x'], ['POST', '/api/glixel/chat/x'],
      ['DELETE', '/api/conversations'], ['DELETE', '/api/fallback/penalty-inspector'], ['POST', '/api/health/check-all'], ['PUT', '/api/keys']] as const) {
      expect(isWritable(m, p), `${m} ${p}`).toBe(false)
    }
  })
  it('refuses other writes before the network', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(apiSend('POST', '/api/keys/1/reveal', {})).rejects.toThrow(/does not POST/)
    await expect(apiSend('DELETE', '/api/keys/1')).rejects.toThrow(/does not DELETE/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('streamChat', () => {
  it('collects the route, the text and the completion', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const fetch = vi.fn(async () => sseResponse([
      ev({ type: 'route', platform: 'groq', model: 'm1', displayName: 'M1', fallbackAttempts: 1, fallbackTrail: 'google/g key1=rate_limited' }),
      ev({ type: 'delta', text: 'Hel' }), ev({ type: 'delta', text: 'lo' }),
      ev({ type: 'done', finishReason: 'stop', latencyMs: 1200 }),
    ]))
    vi.stubGlobal('fetch', fetch)
    const deltas: string[] = []
    const out = await streamChat([{ role: 'user', content: 'hi' }], { conversationId: 4, onDelta: d => deltas.push(d) })
    expect(out).toMatchObject({ text: 'Hello', finishReason: 'stop', latencyMs: 1200, error: null, aborted: false })
    expect(out.route).toEqual({ platform: 'groq', model: 'm1', displayName: 'M1', fallbackAttempts: 1, fallbackTrail: 'google/g key1=rate_limited' })
    expect(deltas).toEqual(['Hel', 'lo'])
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/glixel/chat')
    expect(JSON.parse(String(init.body))).toEqual({ messages: [{ role: 'user', content: 'hi' }], conversationId: 4 })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t')
  })

  it('surfaces a JSON error with its code', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'nope', code: 'free_only_blocked' } }), { status: 403, headers: { 'content-type': 'application/json' } })))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error).toEqual({ message: 'nope', code: 'free_only_blocked', status: 403 })
    expect(errorHint('free_only_blocked', 403)).toMatch(/Free-only routing/)
  })

  it('reports a stream that ends without done or error', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([ev({ type: 'delta', text: 'half' })])))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.text).toBe('half')
    expect(out.error?.code).toBe('stream_incomplete')
  })

  it('reports an abort as aborted, not as an error', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError', init })
    }))
    const out = await streamChat([{ role: 'user', content: 'hi' }], { signal: controller.signal })
    expect(out.aborted).toBe(true)
    expect(out.error).toBeNull()
  })

  it('says when the server is unreachable', async () => {
    localStorage.setItem(SESSION_TOKEN_KEY, 't')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const out = await streamChat([{ role: 'user', content: 'hi' }])
    expect(out.error?.code).toBe('network_error')
    expect(errorHint('network_error', null)).toMatch(/server running/)
  })
})
