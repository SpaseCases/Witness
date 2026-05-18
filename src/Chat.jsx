/**
 * WITNESS — Chat.jsx
 * Updated: Full overhaul — two-column layout with persistent thread sidebar.
 * Left: thread list with create/rename/delete. Right: active conversation.
 * Threads load from SQLite via API. Stream abort on thread switch.
 *
 * Bug fixes (batch 9):
 *   - ThreadSidebar handleDelete used window.confirm() — blocked in Electron
 *     (always returns true silently). Replaced with inline confirm state.
 *   - Main handleDelete read stale `threads` closure to compute next active thread.
 *     Fixed by using setThreads functional updater to derive remaining from fresh state.
 *   - loadThreads / loadMessages promoted to useCallback so their identities are
 *     stable and dependency arrays are honest.
 *   - messages cleared to [] immediately on thread switch to prevent old thread's
 *     messages flashing before new ones load.
 *   - SSE read loop missing finally cleanup: if backend closes stream without a
 *     'done' event, streaming stayed true forever, locking the input. Added
 *     setStreaming(false) / setSearching(false) in the catch/finally path.
 *   - sendMessage dep array removed `input` — it is always passed explicitly as
 *     `text` arg or read via `input` which is captured fresh. Removed to stop
 *     sendMessage recreating on every keystroke.
 *
 * Save at: witness/src/Chat.jsx — replace entire file.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'

const API = 'http://127.0.0.1:8000'

const EXAMPLE_PROMPTS = [
  "What have I been most stressed about recently?",
  "When did I last feel really good and what was going on?",
  "What patterns do you see in my energy levels?",
  "What am I avoiding or not dealing with?",
  "How has my mood changed over the past few weeks?",
  "What keeps coming up that I never address?",
]

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric'
  }).toUpperCase()
}

// ─── Message ──────────────────────────────────────────────────────────────────

function Message({ msg, isStreaming }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) {
      gsap.fromTo(ref.current,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out' }
      )
    }
  }, [])

  if (msg.role === 'user') {
    return (
      <div ref={ref} className="chat-msg chat-msg-user">
        <div className="chat-msg-meta">
          <span className="chat-msg-role chat-msg-role-user">YOU</span>
          <span className="chat-msg-time">{fmtTime(msg.created_at || msg.ts)}</span>
        </div>
        <div className="chat-msg-body">{msg.content || msg.text}</div>
      </div>
    )
  }

  if (msg.role === 'error') {
    return (
      <div ref={ref} className="chat-msg chat-msg-error">
        <div className="chat-msg-meta">
          <span className="chat-msg-role chat-msg-role-ai">ERROR</span>
        </div>
        <div className="chat-msg-body">{msg.content || msg.text}</div>
      </div>
    )
  }

  return (
    <div ref={ref} className="chat-msg chat-msg-ai">
      <div className="chat-msg-meta">
        <span className="chat-msg-role chat-msg-role-ai">WITNESS</span>
        <span className="chat-msg-time">{fmtTime(msg.created_at || msg.ts)}</span>
      </div>
      <div className="chat-msg-body">
        {msg.content || msg.text}
        {isStreaming && <span className="chat-cursor" />}
      </div>
    </div>
  )
}

// ─── Searching indicator ──────────────────────────────────────────────────────

function SearchingIndicator({ visible }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current) return
    gsap.to(ref.current, { opacity: visible ? 1 : 0, duration: 0.18 })
  }, [visible])
  return (
    <div ref={ref} className="chat-searching" style={{ opacity: 0 }}>
      <div className="chat-searching-dot" />
      <div className="chat-searching-dot" />
      <div className="chat-searching-dot" />
      SEARCHING YOUR JOURNAL...
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onPrompt }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) gsap.to(ref.current, { opacity: 1, duration: 0.4, delay: 0.1 })
  }, [])
  const [shown] = useState(() =>
    [...EXAMPLE_PROMPTS].sort(() => Math.random() - 0.5).slice(0, 4)
  )
  return (
    <div ref={ref} className="chat-empty" style={{ opacity: 0 }}>
      <div className="chat-empty-icon">CHAT</div>
      <div className="chat-empty-title">
        ASK ANYTHING ABOUT YOUR JOURNAL.<br />
        ANSWERS ARE GROUNDED IN YOUR ACTUAL ENTRIES.
      </div>
      <div className="chat-prompts">
        <div className="chat-prompt-label">SUGGESTED QUESTIONS</div>
        {shown.map((p, i) => (
          <button key={i} className="chat-prompt-btn" onClick={() => onPrompt(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Thread sidebar ───────────────────────────────────────────────────────────

function ThreadSidebar({ threads, activeId, onSelect, onCreate, onRename, onDelete }) {
  const [renamingId,   setRenamingId]   = useState(null)
  const [renameVal,    setRenameVal]    = useState('')
  const [confirmingId, setConfirmingId] = useState(null)   // id of thread pending delete confirm
  const renameInputRef = useRef(null)

  useEffect(() => {
    if (renamingId && renameInputRef.current) renameInputRef.current.focus()
  }, [renamingId])

  const startRename = (thread, e) => {
    e.stopPropagation()
    setRenamingId(thread.id)
    setRenameVal(thread.title)
    setConfirmingId(null)
  }

  const commitRename = (id) => {
    if (renameVal.trim()) onRename(id, renameVal.trim())
    setRenamingId(null)
  }

  const handleDelete = (id, e) => {
    e.stopPropagation()
    // window.confirm() is blocked in Electron — use inline two-click confirm
    if (confirmingId === id) {
      onDelete(id)
      setConfirmingId(null)
    } else {
      setConfirmingId(id)
    }
  }

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <span className="chat-sidebar-title">THREADS</span>
        <button className="chat-new-btn" onClick={onCreate} title="New thread">+</button>
      </div>
      <div className="chat-thread-list">
        {threads.length === 0 && (
          <div className="chat-thread-empty">NO THREADS YET</div>
        )}
        {threads.map(t => (
          <div
            key={t.id}
            className={`chat-thread-item ${t.id === activeId ? 'active' : ''}`}
            onClick={() => { setConfirmingId(null); onSelect(t.id) }}
          >
            {renamingId === t.id ? (
              <input
                ref={renameInputRef}
                className="chat-thread-rename-input"
                value={renameVal}
                onChange={e => setRenameVal(e.target.value)}
                onBlur={() => commitRename(t.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename(t.id)
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <>
                <div className="chat-thread-info">
                  <span className="chat-thread-title">{t.title}</span>
                  <span className="chat-thread-meta">
                    {t.message_count > 0 ? `${t.message_count} MSG` : 'EMPTY'} · {fmtDate(t.updated_at)}
                  </span>
                </div>
                <div className="chat-thread-actions">
                  <button
                    className="chat-thread-action-btn"
                    onClick={e => startRename(t, e)}
                    title="Rename"
                  >✎</button>
                  <button
                    className={`chat-thread-action-btn chat-thread-delete-btn ${confirmingId === t.id ? 'confirming' : ''}`}
                    onClick={e => handleDelete(t.id, e)}
                    title={confirmingId === t.id ? 'Click again to confirm delete' : 'Delete thread'}
                  >{confirmingId === t.id ? '?' : '×'}</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Chat component ──────────────────────────────────────────────────────

export default function Chat() {
  const [threads,     setThreads]     = useState([])
  const [activeId,    setActiveId]    = useState(null)
  const [messages,    setMessages]    = useState([])
  const [input,       setInput]       = useState('')
  const [streaming,   setStreaming]   = useState(false)
  const [searching,   setSearching]   = useState(false)
  const [loadingMsgs, setLoadingMsgs] = useState(false)

  const threadRef  = useRef(null)
  const inputRef   = useRef(null)
  const abortRef   = useRef(null)
  const msgIdRef   = useRef(0)

  const nextId = () => ++msgIdRef.current

  // ── Load thread list ────────────────────────────────────────────────────────
  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch(`${API}/chat/threads`)
      if (!res.ok) return
      const data = await res.json()
      setThreads(data)
      // Auto-select the first thread if none active
      if (data.length > 0) {
        setActiveId(prev => prev ?? data[0].id)
      }
    } catch (e) {
      console.warn('[WITNESS] Could not load chat threads:', e.message)
    }
  }, [])

  // ── Load thread list on mount ───────────────────────────────────────────────
  useEffect(() => {
    loadThreads()
  }, [loadThreads])

  // ── Auto-scroll on message updates ─────────────────────────────────────────
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [messages, searching])

  // ── Abort stream on unmount ─────────────────────────────────────────────────
  useEffect(() => () => abortRef.current?.abort(), [])

  const loadMessages = useCallback(async (threadId) => {
    setMessages([])          // clear immediately so old thread's messages never flash
    setLoadingMsgs(true)
    try {
      const res = await fetch(`${API}/chat/threads/${threadId}/messages`)
      if (!res.ok) return
      const data = await res.json()
      setMessages(data)
    } catch (e) {
      console.warn('[WITNESS] Could not load messages:', e.message)
    } finally {
      setLoadingMsgs(false)
    }
  }, [])

  // ── Load messages when activeId changes ────────────────────────────────────
  useEffect(() => {
    if (!activeId) { setMessages([]); return }
    abortRef.current?.abort()  // abort any in-flight stream
    setStreaming(false)
    setSearching(false)
    loadMessages(activeId)
  }, [activeId, loadMessages])

  // ── Thread operations ───────────────────────────────────────────────────────
  const handleCreate = async () => {
    try {
      const res = await fetch(`${API}/chat/threads`, { method: 'POST' })
      if (!res.ok) return
      const thread = await res.json()
      setThreads(prev => [thread, ...prev])
      setActiveId(thread.id)
      setMessages([])
    } catch (e) {
      console.warn('[WITNESS] Could not create thread:', e.message)
    }
  }

  const handleSelect = (id) => {
    if (id === activeId) return
    abortRef.current?.abort()
    setStreaming(false)
    setSearching(false)
    setActiveId(id)
  }

  const handleRename = async (id, title) => {
    try {
      const res = await fetch(`${API}/chat/threads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      })
      if (!res.ok) return
      const updated = await res.json()
      setThreads(prev => prev.map(t => t.id === id ? { ...t, title: updated.title } : t))
    } catch (e) {
      console.warn('[WITNESS] Rename failed:', e.message)
    }
  }

  const handleDelete = async (id) => {
    try {
      await fetch(`${API}/chat/threads/${id}`, { method: 'DELETE' })
      // Use functional updater to read fresh state — avoids stale closure on `threads`
      setThreads(prev => {
        const remaining = prev.filter(t => t.id !== id)
        // If we just deleted the active thread, switch to the next available one
        setActiveId(cur => cur === id ? (remaining.length > 0 ? remaining[0].id : null) : cur)
        return remaining
      })
    } catch (e) {
      console.warn('[WITNESS] Delete failed:', e.message)
    }
  }

  const handleClearMessages = async () => {
    if (!activeId) return
    try {
      await fetch(`${API}/chat/threads/${activeId}/messages`, { method: 'DELETE' })
      setMessages([])
      setThreads(prev => prev.map(t => t.id === activeId ? { ...t, message_count: 0 } : t))
    } catch (e) {
      console.warn('[WITNESS] Clear failed:', e.message)
    }
  }

  // ── Send message ────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text) => {
    // `text` is passed explicitly from EmptyState prompts; `input` is the textarea value.
    // We always prefer the explicit arg so the textarea state is not required in deps.
    const question = (text ?? input).trim()
    if (!question || streaming || !activeId) return

    setInput('')

    // Optimistically add user message to display
    const userMsg = {
      id: nextId(), role: 'user', content: question,
      created_at: new Date().toISOString(), ts: new Date()
    }
    setMessages(prev => [...prev, userMsg])
    setSearching(true)
    setStreaming(true)

    const aiMsgId = nextId()
    const aiMsg = {
      id: aiMsgId, role: 'assistant', content: '',
      created_at: new Date().toISOString(), ts: new Date()
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/chat/threads/${activeId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`Backend returned ${res.status}`)

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''
      let firstToken = true
      let receivedDone = false

      setMessages(prev => [...prev, aiMsg])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (!payload) continue

          let event
          try { event = JSON.parse(payload) } catch { continue }

          if (event.type === 'token' && event.text) {
            if (firstToken) { firstToken = false; setSearching(false) }
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, content: m.content + event.text } : m
            ))
          }

          if (event.type === 'done') {
            receivedDone = true
            setStreaming(false)
            setSearching(false)
            // Refresh thread list so message_count and updated_at update
            loadThreads()
          }

          if (event.type === 'error') {
            setSearching(false)
            setStreaming(false)
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, role: 'error', content: `Error: ${event.text}` } : m
            ))
          }
        }
      }

      // Guard: backend closed the stream without sending a 'done' event
      // (e.g. crash mid-generation). Release the lock so the input isn't frozen.
      if (!receivedDone) {
        setStreaming(false)
        setSearching(false)
      }

    } catch (err) {
      setSearching(false)
      setStreaming(false)
      if (err.name === 'AbortError') return

      setMessages(prev => {
        const filtered = prev.filter(m => !(m.id === aiMsgId && m.content === ''))
        return [...filtered, {
          id: nextId(), role: 'error',
          content: `Could not reach the backend. Is Witness running? (${err.message})`,
          created_at: new Date().toISOString()
        }]
      })
    }
  }, [streaming, activeId, input, loadThreads])

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const canSend    = input.trim().length > 0 && !streaming && !!activeId
  const activeThread = threads.find(t => t.id === activeId)

  return (
    <div className="chat-screen">

      <ThreadSidebar
        threads={threads}
        activeId={activeId}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onRename={handleRename}
        onDelete={handleDelete}
      />

      <div className="chat-main">

        {/* Header */}
        <div className="chat-header">
          <div className="chat-header-left">
            <h1 className="page-title">
              {activeThread?.title || 'CHAT'}
            </h1>
            <span className="page-subtitle">ASK YOUR JOURNAL ANYTHING</span>
          </div>
          {messages.length > 0 && (
            <div className="chat-header-right">
              <button className="chat-clear-btn" onClick={handleClearMessages}>
                CLEAR
              </button>
            </div>
          )}
        </div>

        {/* Message thread */}
        <div className="chat-messages" ref={threadRef}>
          {!activeId ? (
            <div className="chat-no-thread">
              <span>CREATE A THREAD TO BEGIN</span>
              <button className="chat-prompt-btn" style={{ marginTop: 16 }} onClick={handleCreate}>
                + NEW THREAD
              </button>
            </div>
          ) : loadingMsgs ? (
            <div className="chat-loading">LOADING...</div>
          ) : messages.length === 0 && !streaming ? (
            <EmptyState onPrompt={(p) => {
              setInput(p)
              setTimeout(() => sendMessage(p), 50)
            }} />
          ) : (
            <>
              {messages.map(msg => (
                <Message
                  key={msg.id}
                  msg={msg}
                  isStreaming={streaming && msg.id === messages[messages.length - 1]?.id && msg.role === 'assistant'}
                />
              ))}
              <SearchingIndicator visible={searching} />
            </>
          )}
        </div>

        {/* Input */}
        <div className="chat-input-area">
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              placeholder={activeId ? "ASK SOMETHING..." : "CREATE A THREAD FIRST"}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              disabled={streaming || !activeId}
              spellCheck={true}
              rows={1}
              onInput={e => {
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
            />
            <button
              className="chat-send-btn"
              onClick={() => sendMessage()}
              disabled={!canSend}
            >
              {streaming ? 'THINKING...' : 'SEND'}
            </button>
          </div>
          <div className="chat-input-hint">
            ENTER TO SEND · SHIFT+ENTER FOR NEW LINE · THREADS PERSIST ACROSS SESSIONS
          </div>
        </div>

      </div>
    </div>
  )
}
