import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { errorHint, streamChat, toChatTurns, type RouteInfo } from '@/lib/chat'
import {
  deleteConversation, listConversations, loadConversation, metaFrom, saveConversation, type StoredMessage,
} from '@/lib/conversations'
import { formatLatency } from '@/lib/telemetry'
import { IntelligenceCore } from './IntelligenceCore'

// GLIXEL chat. The server enforces the persona and routes with free-only
// routing; this screen sends only the visible turns, streams the answer, and
// shows the route the router actually used under each reply.

interface UiMessage extends StoredMessage {
  id: string
  streaming?: boolean
  route?: RouteInfo | null
  hint?: string | null
}

let seq = 0
const nextId = () => `m${++seq}`

function RouteChip({ message }: { message: UiMessage }) {
  const platform = message.route?.platform ?? message.meta?.platform
  const model = message.route?.model ?? message.meta?.model
  if (!platform || !model) return null
  const fallbacks = message.route?.fallbackAttempts ?? message.meta?.fallbackAttempts ?? 0
  const latency = message.meta?.latency ?? null
  return (
    <p className="mt-1.5 text-[11px] font-mono text-glx-muted break-all" data-testid="route-chip">
      <span className="text-glx-cyan">via {platform}</span> · {model}
      {fallbacks > 0 && <span className="text-glx-warn"> · {fallbacks} fallback{fallbacks > 1 ? 's' : ''}</span>}
      {latency !== null && <> · {formatLatency(latency)}</>}
      {message.route?.fallbackTrail && (
        <span className="block text-glx-muted/80">skipped: {message.route.fallbackTrail}</span>
      )}
    </p>
  )
}

function Bubble({ message }: { message: UiMessage }) {
  const mine = message.role === 'user'
  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`} data-role={message.role} data-testid="message">
      <div
        className={[
          'max-w-[88%] px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words',
          mine ? 'glx-bubble-user' : message.isError ? 'glx-bubble-error' : 'glx-bubble-assistant',
        ].join(' ')}
      >
        {message.content || (message.streaming ? <span className="glx-typing" aria-label="GLIXEL is answering">▍</span> : null)}
        {message.isError && message.hint && <p className="mt-1.5 text-xs text-glx-text/80" data-testid="error-hint">{message.hint}</p>}
        {!mine && !message.isError && <RouteChip message={message} />}
      </div>
    </li>
  )
}

function History({ onOpen, onClose, currentId, onDeleted }: {
  onOpen: (id: number) => void
  onClose: () => void
  currentId: number | null
  onDeleted: (id: number) => void
}) {
  const queryClient = useQueryClient()
  const { data, isPending, isError } = useQuery({ queryKey: ['glixel', 'conversations'], queryFn: listConversations })
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  async function confirmDelete(id: number) {
    setBusy(true)
    try {
      await deleteConversation(id)
      onDeleted(id)
      await queryClient.invalidateQueries({ queryKey: ['glixel', 'conversations'] })
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex flex-col bg-glx-void/95 backdrop-blur-sm" role="dialog" aria-label="Conversation history">
      <div className="flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-3 border-b border-glx-line">
        <h2 className="glx-label">History</h2>
        <button type="button" className="glx-link text-sm" onClick={onClose}>Close</button>
      </div>
      <p className="px-4 py-2 text-[11px] text-glx-muted">Stored on your FreeLLMAPI server and shared with the dashboard Playground.</p>
      <ul className="flex-1 overflow-y-auto px-4 divide-y divide-glx-line" data-testid="history">
        {isPending && <li className="py-3 text-sm text-glx-muted">Loading…</li>}
        {isError && <li className="py-3 text-sm text-glx-warn">Could not load history.</li>}
        {data?.length === 0 && <li className="py-3 text-sm text-glx-muted">No conversations yet.</li>}
        {data?.map(c => (
          <li key={c.id} className="py-3">
            {confirming === c.id ? (
              <div className="space-y-2" data-testid="confirm-delete">
                <p className="text-sm">Delete “{c.title}”? This cannot be undone.</p>
                <div className="flex gap-2">
                  <button type="button" className="glx-button glx-button-danger" disabled={busy} onClick={() => void confirmDelete(c.id)}>Delete</button>
                  <button type="button" className="glx-button" onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onOpen(c.id)}>
                  <span className={`block truncate text-sm ${c.id === currentId ? 'text-glx-cyan' : ''}`}>{c.title}</span>
                  <span className="block text-[11px] text-glx-muted">{new Date(c.updatedAt).toLocaleString()}</span>
                </button>
                <button type="button" className="text-xs text-glx-muted hover:text-glx-bad" aria-label={`Delete ${c.title}`} onClick={() => setConfirming(c.id)}>Delete</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Chat() {
  const queryClient = useQueryClient()
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight })
  }, [messages])
  useEffect(() => () => abortRef.current?.abort(), [])

  const patchLast = (patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)) =>
    setMessages(list => list.map((m, i) => (i === list.length - 1 ? { ...m, ...(typeof patch === 'function' ? patch(m) : patch) } : m)))

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || busy) return
    const user: UiMessage = { id: nextId(), role: 'user', content: text }
    const history = [...messages, user]
    setMessages([...history, { id: nextId(), role: 'assistant', content: '', streaming: true }])
    setDraft('')
    setBusy(true)
    setSaveError(null)
    const controller = new AbortController()
    abortRef.current = controller

    const outcome = await streamChat(toChatTurns(history), {
      conversationId: conversationId ?? undefined,
      signal: controller.signal,
      onRoute: route => patchLast({ route }),
      onDelta: delta => patchLast(m => ({ content: m.content + delta })),
    })
    abortRef.current = null

    let assistant: UiMessage
    if (outcome.error || (outcome.aborted && !outcome.text)) {
      const message = outcome.aborted ? 'Stopped.' : outcome.error!.message
      assistant = {
        id: nextId(), role: 'assistant', isError: true,
        content: outcome.text ? `${outcome.text}\n\n— ${message}` : message,
        hint: outcome.aborted ? null : errorHint(outcome.error!.code, outcome.error!.status),
        route: outcome.route,
      }
    } else {
      assistant = {
        id: nextId(), role: 'assistant', content: outcome.text, route: outcome.route,
        meta: metaFrom(outcome.route, outcome.latencyMs),
      }
    }
    const finalList = [...history, assistant]
    setMessages(finalList)
    setBusy(false)

    try {
      const stored: StoredMessage[] = finalList.map(({ role, content, isError, meta }) => ({ role, content, ...(isError ? { isError } : {}), ...(meta ? { meta } : {}) }))
      const id = await saveConversation(conversationId, stored)
      setConversationId(id)
      void queryClient.invalidateQueries({ queryKey: ['glixel', 'conversations'] })
    } catch {
      setSaveError('This exchange could not be saved to history.')
    }
  }, [draft, busy, messages, conversationId, queryClient])

  function newConversation() {
    abortRef.current?.abort()
    setMessages([])
    setConversationId(null)
    setSaveError(null)
  }

  async function open(id: number) {
    setShowHistory(false)
    abortRef.current?.abort()
    try {
      const c = await loadConversation(id)
      setMessages(c.messages.map(m => ({ ...m, id: nextId() })))
      setConversationId(c.id)
      setSaveError(null)
    } catch {
      setSaveError('Could not open that conversation.')
    }
  }

  return (
    <section className="flex flex-col h-full min-h-0" aria-label="Chat with GLIXEL">
      <div className="flex items-center justify-between gap-2 py-2">
        <button type="button" className="glx-link text-xs" onClick={() => setShowHistory(true)}>History</button>
        <button type="button" className="glx-link text-xs" onClick={newConversation}>New chat</button>
      </div>

      <ul ref={listRef} className="flex-1 min-h-0 overflow-y-auto space-y-3 py-2" data-testid="messages" aria-live="polite">
        {messages.length === 0 && (
          <li className="pt-6 text-center space-y-3 list-none">
            <div className="mx-auto max-w-[180px]"><IntelligenceCore /></div>
            <p className="text-sm text-glx-muted">Ask GLIXEL anything. Replies use free models only, and the route is shown under each answer.</p>
          </li>
        )}
        {messages.map(m => <Bubble key={m.id} message={m} />)}
      </ul>

      {saveError && <p className="text-xs text-glx-warn py-1" role="status">{saveError}</p>}

      <form
        className="glx-composer flex items-end gap-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
        onSubmit={e => { e.preventDefault(); void send() }}
      >
        <label htmlFor="glixel-input" className="sr-only">Message GLIXEL</label>
        <textarea
          id="glixel-input"
          className="glx-input flex-1 resize-none"
          rows={1}
          value={draft}
          placeholder="Message GLIXEL"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia?.('(pointer: fine)').matches) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <button type="button" className="glx-button" onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button type="submit" className="glx-button" disabled={!draft.trim()}>Send</button>
        )}
      </form>

      {showHistory && (
        <History
          currentId={conversationId}
          onOpen={id => void open(id)}
          onClose={() => setShowHistory(false)}
          onDeleted={id => { if (id === conversationId) newConversation() }}
        />
      )}
    </section>
  )
}
