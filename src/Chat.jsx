/**
 * WITNESS — Chat.jsx
 *
 * Save this file at: witness/src/Chat.jsx
 *
 * The journal chat interface. Ask natural-language questions about your
 * own journal and get AI-generated answers grounded in your actual entries.
 *
 * How the streaming works:
 *   1. User submits a question
 *   2. Frontend opens a fetch() with the question as POST body
 *   3. Backend streams back Server-Sent Events (SSE) — one JSON chunk per token
 *   4. We append each token to the current AI message as it arrives
 *   5. When the "done" event arrives, we stop the cursor and mark the message complete
 *
 * GSAP is used for:
 *   - Empty state fade-in on mount
 *   - Each new message sliding in from below
 *   - The searching indicator appearing/disappearing
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'

const API = 'http://127.0.0.1:8000'

// Suggested questions shown in the empty state
const EXAMPLE_PROMPTS = [
  "What have I been most stressed about recently?",
  "When did I last feel really good and what was going on?",
  "What patterns do you see in my energy levels?",
  "What am I avoiding or not dealing with?",
  "How has my mood changed over the past few weeks?",
  "What keeps coming up in my entries that I don't address?",
]

function fmtTime(ts) {
  // ts is a JS Date object
  return ts.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

// ─── Message component ────────────────────────────────────────────────────────

function Message({ msg, isStreaming }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) {
      gsap.fromTo(ref.current,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out' }
      )
    }
  }, [])

  if (msg.role === 'user') {
    return (
      <div ref={ref} className="chat-msg chat-msg-user">
        <div className="chat-msg-meta">
          <span className="chat-msg-role chat-msg-role-user">YOU</span>
          <span className="chat-msg-time">{fmtTime(msg.ts)}</span>
        </div>
        <div className="chat-msg-body">{msg.text}</div>
      </div>
    )
  }

  if (msg.role === 'error') {
    return (
      <div ref={ref} className="chat-msg chat-msg-error">
        <div className="chat-msg-meta">
          <span className="chat-msg-role chat-msg-role-ai">ERROR</span>
          <span className="chat-msg-time">{fmtTime(msg.ts)}</span>
        </div>
        <div className="chat-msg-body">{msg.text}</div>
      </div>
    )
  }

  // AI message
  return (
    <div ref={ref} className="chat-msg chat-msg-ai">
      <div className="chat-msg-meta">
        <span className="chat-msg-role chat-msg-role-ai">WITNESS</span>
        <span className="chat-msg-time">{fmtTime(msg.ts)}</span>
      </div>
      <div className="chat-msg-body">
        {msg.text}
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
    if (visible) {
      gsap.fromTo(ref.current,
        { opacity: 0 },
        { opacity: 1, duration: 0.2, ease: 'power2.out' }
      )
    } else {
      gsap.to(ref.current, { opacity: 0, duration: 0.15 })
    }
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
    if (ref.current) {
      gsap.to(ref.current, {
        opacity: 1, duration: 0.5, delay: 0.1, ease: 'power2.out'
      })
    }
  }, [])

  // Show 4 random prompts each time the empty state appears
  const [shown] = useState(() => {
    const shuffled = [...EXAMPLE_PROMPTS].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, 4)
  })

  return (
    <div ref={ref} className="chat-empty">
      <div className="chat-empty-icon">CHAT</div>
      <div className="chat-empty-title">
        ASK ANYTHING ABOUT YOUR JOURNAL.<br />
        ANSWERS ARE GROUNDED IN YOUR ACTUAL ENTRIES.
      </div>
      <div className="chat-prompts">
        <div className="chat-prompt-label">SUGGESTED QUESTIONS</div>
        {shown.map((p, i) => (
          <button
            key={i}
            className="chat-prompt-btn"
            onClick={() => onPrompt(p)}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Main Chat component ──────────────────────────────────────────────────────

export default function Chat() {
  const [messages,    setMessages]    = useState([])   // { role, text, ts, id }
  const [input,       setInput]       = useState('')
  const [streaming,   setStreaming]   = useState(false) // true while AI is typing
  const [searching,   setSearching]   = useState(false) // true before first token arrives
  const [ollamaOnline, setOllamaOnline] = useState(true)

  const threadRef   = useRef(null)   // scrollable message container
  const inputRef    = useRef(null)
  const abortRef    = useRef(null)   // AbortController for current stream
  const msgIdRef    = useRef(0)      // incrementing message ID

  // Check Ollama status on mount
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('http://localhost:11434/api/tags', {
          signal: AbortSignal.timeout(3000)
        })
        setOllamaOnline(res.ok)
      } catch {
        setOllamaOnline(false)
      }
    }
    check()
  }, [])

  // Auto-scroll to bottom whenever messages change or streaming updates
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight
    }
  }, [messages, searching])

  // Clean up any in-flight request on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  const nextId = () => ++msgIdRef.current

  const sendMessage = useCallback(async (text) => {
    const question = (text || input).trim()
    if (!question || streaming) return

    setInput('')

    // Add user message
    const userMsg = { id: nextId(), role: 'user', text: question, ts: new Date() }
    setMessages(prev => [...prev, userMsg])

    // Show searching indicator
    setSearching(true)
    setStreaming(true)

    // Create the AI message placeholder — we'll append to it as tokens arrive
    const aiMsgId = nextId()
    const aiMsg = { id: aiMsgId, role: 'ai', text: '', ts: new Date() }

    // Abort any previous in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`${API}/chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`Backend returned ${res.status}`)
      }

      // Read the SSE stream
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let firstToken = true

      setMessages(prev => [...prev, aiMsg])

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''  // keep the incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (!payload) continue

          let event
          try { event = JSON.parse(payload) } catch { continue }

          if (event.type === 'token' && event.text) {
            // Hide searching indicator on first token
            if (firstToken) {
              firstToken = false
              setSearching(false)
            }

            // Append token to the AI message
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId
                ? { ...m, text: m.text + event.text }
                : m
            ))
          }

          if (event.type === 'done') {
            setStreaming(false)
            setSearching(false)
          }

          if (event.type === 'error') {
            setSearching(false)
            setStreaming(false)
            setMessages(prev => prev.map(m =>
              m.id === aiMsgId
                ? { ...m, role: 'error', text: `Error: ${event.text}` }
                : m
            ))
          }
        }
      }
    } catch (err) {
      setSearching(false)
      setStreaming(false)

      if (err.name === 'AbortError') return  // user navigated away — silent

      // Show error as a message
      setMessages(prev => {
        // Remove the empty AI placeholder if it's still there
        const filtered = prev.filter(m => !(m.id === aiMsgId && m.text === ''))
        return [...filtered, {
          id: nextId(),
          role: 'error',
          text: `Could not reach the backend. Is Witness running? (${err.message})`,
          ts: new Date()
        }]
      })
    }
  }, [input, streaming])

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
    // Shift+Enter inserts a newline (default textarea behavior)
  }

  const handleClear = async () => {
    setMessages([])
    try {
      await fetch(`${API}/chat/history`, { method: 'DELETE' })
    } catch { /* backend offline, clear locally anyway */ }
  }

  const canSend = input.trim().length > 0 && !streaming

  return (
    <div className="chat-screen">

      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <h1 className="page-title">CHAT</h1>
          <span className="page-subtitle">ASK YOUR JOURNAL ANYTHING</span>
        </div>
        {messages.length > 0 && (
          <div className="chat-header-right">
            <button className="chat-clear-btn" onClick={handleClear}>
              CLEAR
            </button>
          </div>
        )}
      </div>

      {/* Ollama offline warning */}
      {!ollamaOnline && (
        <div className="chat-offline-banner">
          OLLAMA IS OFFLINE. START OLLAMA OR CHECK CONFIG.
        </div>
      )}

      {/* Message thread */}
      <div className="chat-messages" ref={threadRef}>
        {messages.length === 0 && !streaming ? (
          <EmptyState onPrompt={(p) => {
            setInput(p)
            // Give the input time to update before submitting
            setTimeout(() => sendMessage(p), 50)
          }} />
        ) : (
          <>
            {messages.map(msg => (
              <Message
                key={msg.id}
                msg={msg}
                isStreaming={streaming && msg.id === messages[messages.length - 1]?.id && msg.role === 'ai'}
              />
            ))}
            <SearchingIndicator visible={searching} />
          </>
        )}
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="ASK SOMETHING..."
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={streaming}
            spellCheck={true}
            rows={1}
            onInput={e => {
              // Auto-grow up to max-height
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
          ENTER TO SEND  ·  SHIFT+ENTER FOR NEW LINE  ·  SEARCHES YOUR LAST 30 ENTRIES SEMANTICALLY
        </div>
      </div>

    </div>
  )
}
