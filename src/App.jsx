/**
 * WITNESS — App.jsx (Step 17 / corrected Step 3)
 *
 * Save this file at: witness/src/App.jsx
 *
 * Changes from Step 16:
 *   - Version bumped to 2.0.0 everywhere
 *   - Dashboard To-Do List: real todos table via /todos API
 *   - Seed tasks with EXAMPLE badge for new users
 *   - Done tasks sink to bottom at 40% opacity
 *   - GSAP strikethrough animation on task completion (gsap.fromTo only)
 *   - Source label ("FROM: APR 28") on each task
 *   - Delete button visible on hover
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'
import JournalEntry from './JournalEntry'
import Memory from './Memory'
import RantMode     from './RantMode'
import WriteMode    from './WriteMode'
import LogBrowser   from './LogBrowser'
import Debrief      from './Debrief'
import Vitals       from './Vitals'
import WeeklyRecap  from './WeeklyRecap'
import Settings     from './Settings'
import Todos       from './Todos'
import Chat        from './Chat'
import Profile     from './Profile'
import Export      from './Export'

const API = 'http://127.0.0.1:8000'

const NAV = [
  { id: 'dashboard', label: 'COMMAND',  sub: 'Dashboard' },
  { id: 'journal',   label: 'RECORD',   sub: 'Entry' },
  { id: 'memory',    label: 'MEMORY',   sub: 'AI Memory' },
  { id: 'write',     label: 'WRITE',    sub: 'Text Entry' },
  { id: 'rant',      label: 'DUMP',     sub: 'Rant Mode' },
  { id: 'logs',      label: 'ARCHIVE',  sub: 'Log Browser' },
  { id: 'todos',     label: 'TASKS',    sub: 'To-Do & Projects' },
  { id: 'insights',  label: 'DEBRIEF',  sub: 'Insights & Flags' },
  { id: 'health',    label: 'VITALS',   sub: 'Health Data' },
  { id: 'recap',     label: 'SITREP',   sub: 'Weekly Recap' },
  { id: 'chat',      label: 'CHAT',     sub: 'Journal Chat' },
  { id: 'profile',   label: 'PROFILE',  sub: 'Self-Model' },
  { id: 'export',    label: 'EXPORT',   sub: 'Save Journal' },
  { id: 'settings',  label: 'CONFIG',   sub: 'Settings' },
]

// Seed tasks shown to new users before they create their first real task
const SEED_TASKS = [
  { id: 'seed-1', text: 'Follow up on the work situation you mentioned', done: false, source_date: null, _seed: true },
  { id: 'seed-2', text: 'Schedule that appointment you have been putting off', done: false, source_date: null, _seed: true },
  { id: 'seed-3', text: 'Write down what has been on your mind this week', done: false, source_date: null, _seed: true },
]

function fmtSourceDate(dateStr) {
  if (!dateStr) return null
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
  } catch {
    return null
  }
}

// ─── TITLE BAR ────────────────────────────────────────────────────────────────

function TitleBar() {
  return (
    <div className="titlebar">
      <span className="titlebar-wordmark">W I T N E S S</span>
      <div className="titlebar-controls">
        <button className="titlebar-btn tb-min"   onClick={() => window.witness?.minimize()}>─</button>
        <button className="titlebar-btn tb-max"   onClick={() => window.witness?.maximize()}>□</button>
        <button className="titlebar-btn tb-close" onClick={() => window.witness?.close()}>✕</button>
      </div>
    </div>
  )
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────

function Sidebar({ active, onNav, ollamaStatus }) {
  const statusLabel = {
    online:  'OLLAMA ONLINE',
    offline: 'OLLAMA OFFLINE',
    loading: 'STARTING...'
  }[ollamaStatus] ?? 'CHECKING...'

  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-text">WIT<span className="logo-accent">NESS</span></span>
        <span className="logo-tagline">PRIVATE INTELLIGENCE</span>
      </div>

      <div className="sidebar-status">
        <div className={`status-pip ${ollamaStatus}`} />
        <span className="status-label">{statusLabel}</span>
      </div>

      <ul className="nav-list">
        {NAV.map(item => (
          <li key={item.id}>
            <button
              className={`nav-btn ${active === item.id ? 'active' : ''}`}
              onClick={() => onNav(item.id)}
            >
              <span className="nav-btn-label">{item.label}</span>
              <span className="nav-btn-sub">{item.sub}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-foot">
        <span className="sidebar-foot-text">WITNESS v2.0.0</span>
        <span className="sidebar-foot-text">BUILD 2026.04</span>
      </div>
    </nav>
  )
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtLastEntry(lastEntry) {
  if (!lastEntry) return { line1: 'NO LOGS YET', line2: 'YOUR HISTORY WILL APPEAR HERE' }

  // Compare by date string only — avoids timezone bugs where SQLite UTC timestamps
  // make yesterday's entry appear as "-1 days ago" in local time.
  const entryDate = (lastEntry.date || lastEntry.created_at || '').slice(0, 10)
  const todayDate = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA')

  let when
  if (entryDate === todayDate)      when = 'TODAY'
  else if (entryDate === yesterday) when = 'YESTERDAY'
  else if (entryDate) {
    // Calculate days between the two date strings without timezone distortion
    const msPerDay = 86400000
    const entryMs  = new Date(entryDate + 'T12:00:00').getTime()
    const todayMs  = new Date(todayDate + 'T12:00:00').getTime()
    const diff     = Math.round((todayMs - entryMs) / msPerDay)
    when = diff > 0 ? `${diff} DAYS AGO` : 'TODAY'
  } else {
    when = 'RECENTLY'
  }

  const preview = lastEntry.preview
    ? lastEntry.preview.slice(0, 60) + (lastEntry.preview.length > 60 ? '...' : '')
    : 'NO TRANSCRIPT'
  return { line1: when, line2: preview }
}

function getStressColor(val) {
  if (val >= 7.5) return 'stress-high'
  if (val >= 5)   return 'stress-mid'
  return 'stress-low'
}

// ─── TO-DO LIST CARD ──────────────────────────────────────────────────────────

function TodoCard({ backendReady }) {
  const [tasks,       setTasks]       = useState([])
  const [showSeeds,   setShowSeeds]   = useState(false)  // true when no real tasks exist
  const [input,       setInput]       = useState('')
  const [loading,     setLoading]     = useState(true)
  const inputRef    = useRef(null)
  const taskRefs    = useRef({})       // id -> DOM ref for GSAP targeting

  // Load real tasks from backend — only after backend is confirmed ready
  useEffect(() => {
    if (!backendReady) return
    const load = async () => {
      try {
        const res = await fetch(`${API}/todos/`)
        if (res.ok) {
          const data = await res.json()
          setTasks(data)
          // Show seed tasks only when the user has never added a real task
          setShowSeeds(data.length === 0)
        }
      } catch {
        setShowSeeds(true)   // backend offline — show seeds as placeholder
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [backendReady])

  // Add a new task
  const addTask = useCallback(async () => {
    const text = input.trim()
    if (!text) return
    setInput('')

    // First real task — dismiss seeds immediately
    setShowSeeds(false)

    try {
      const res = await fetch(`${API}/todos/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text })
      })
      if (res.ok) {
        const newTask = await res.json()
        setTasks(prev => [newTask, ...prev])
        // Animate new task sliding in
        setTimeout(() => {
          const el = taskRefs.current[newTask.id]
          if (el) {
            gsap.fromTo(el,
              { opacity: 0, x: -12 },
              { opacity: 1, x: 0, duration: 0.25, ease: 'power2.out' }
            )
          }
        }, 20)
      }
    } catch {
      // Backend offline — add locally so UI isn't broken
      const local = { id: `local-${Date.now()}`, text, done: false, source_date: null }
      setTasks(prev => [local, ...prev])
    }

    inputRef.current?.focus()
  }, [input])

  // Toggle a task done / undone
  const toggleTask = useCallback(async (task) => {
    const newDone = !task.done
    const el = taskRefs.current[task.id]

    if (newDone && el) {
      // Animate strikethrough: find the text span inside the task element
      const textEl = el.querySelector('.todo-text')
      if (textEl) {
        // The strikethrough line starts at 0 width and expands to 100%
        // We do this by animating a pseudo-overlay div we inject temporarily
        gsap.fromTo(textEl,
          { opacity: 1, textDecorationColor: 'transparent' },
          { opacity: 0.4, textDecorationColor: '#505050', duration: 0.35, ease: 'power2.inOut' }
        )
      }
    } else if (!newDone && el) {
      const textEl = el.querySelector('.todo-text')
      if (textEl) {
        gsap.fromTo(textEl,
          { opacity: 0.4 },
          { opacity: 1, duration: 0.2, ease: 'power2.out' }
        )
      }
    }

    // Optimistic update
    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, done: newDone } : t
    ))

    // Sink done task to bottom after animation
    if (newDone) {
      setTimeout(() => {
        setTasks(prev => {
          const undone = prev.filter(t => t.id !== task.id || !newDone ? !t.done : false)
          const done   = prev.filter(t => t.done)
          // Re-sort: undone first (newest first), done after
          const allUndone = prev.filter(t => t.id === task.id ? false : !t.done)
          const allDone   = prev.filter(t => t.id === task.id ? true : t.done)
          return [...allUndone, ...allDone]
        })
      }, 380)
    } else {
      setTasks(prev => {
        const allUndone = prev.filter(t => !t.done)
        const allDone   = prev.filter(t => t.done && t.id !== task.id)
        return [...allUndone, ...allDone]
      })
    }

    if (typeof task.id === 'number') {
      try {
        await fetch(`${API}/todos/${task.id}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ done: newDone })
        })
      } catch { /* silently ignore */ }
    }
  }, [])

  // Delete a task
  const deleteTask = useCallback(async (task) => {
    const el = taskRefs.current[task.id]
    if (el) {
      gsap.fromTo(el,
        { opacity: 1, x: 0 },
        { opacity: 0, x: 16, duration: 0.2, ease: 'power2.in',
          onComplete: () => {
            setTasks(prev => {
              const updated = prev.filter(t => t.id !== task.id)
              if (updated.length === 0) setShowSeeds(true)
              return updated
            })
          }
        }
      )
    } else {
      setTasks(prev => {
        const updated = prev.filter(t => t.id !== task.id)
        if (updated.length === 0) setShowSeeds(true)
        return updated
      })
    }

    if (typeof task.id === 'number') {
      try {
        await fetch(`${API}/todos/${task.id}`, { method: 'DELETE' })
      } catch { /* silently ignore */ }
    }
  }, [])

  const dismissSeeds = () => setShowSeeds(false)

  const handleKey = (e) => {
    if (e.key === 'Enter') addTask()
  }

  const displayTasks = showSeeds ? SEED_TASKS : tasks
  const openCount    = tasks.filter(t => !t.done).length

  return (
    <div className="d-card todo-card">

      {/* Header */}
      <div className="todo-header">
        <div className="card-label">TO-DO</div>
        {!showSeeds && tasks.length > 0 && (
          <span className="todo-open-count">
            {openCount} OPEN
          </span>
        )}
        {showSeeds && (
          <button className="todo-dismiss-seeds" onClick={dismissSeeds}>
            DISMISS
          </button>
        )}
      </div>

      {/* Task list */}
      <div className="todo-list">
        {loading && (
          <div className="todo-empty">LOADING...</div>
        )}

        {!loading && displayTasks.map(task => {
          const srcLabel = fmtSourceDate(task.source_date)
          return (
            <div
              key={task.id}
              className={`todo-item ${task.done ? 'todo-item-done' : ''} ${task._seed ? 'todo-item-seed' : ''}`}
              ref={el => { if (el) taskRefs.current[task.id] = el }}
            >
              {/* Checkbox */}
              {!task._seed && (
                <button
                  className="todo-check"
                  onClick={() => toggleTask(task)}
                  title={task.done ? 'Mark incomplete' : 'Mark complete'}
                >
                  {task.done ? '■' : '□'}
                </button>
              )}
              {task._seed && <span className="todo-seed-dot">◆</span>}

              {/* Text + source label */}
              <div className="todo-body">
                <span className="todo-text">{task.text}</span>
                {srcLabel && (
                  <span className="todo-source">FROM: {srcLabel}</span>
                )}
              </div>

              {/* Badges + delete */}
              <div className="todo-right">
                {task._seed && <span className="todo-example-badge">EXAMPLE</span>}
                {!task._seed && (
                  <button
                    className="todo-delete"
                    onClick={() => deleteTask(task)}
                    title="Delete task"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {!loading && !showSeeds && tasks.length === 0 && (
          <div className="todo-empty">NO TASKS. ADD ONE BELOW.</div>
        )}
      </div>

      {/* Add task input */}
      <div className="todo-input-row">
        <input
          ref={inputRef}
          className="todo-input"
          type="text"
          placeholder="NEW TASK..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          maxLength={120}
        />
        <button
          className="card-action-btn todo-add-btn"
          onClick={addTask}
          disabled={!input.trim()}
        >
          ADD
        </button>
      </div>

    </div>
  )
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function Dashboard({ onRant, onRecord, refreshKey, backendReady }) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).toUpperCase()

  const [stats, setStats] = useState(null)

  useEffect(() => {
    if (!backendReady) return
    const load = async () => {
      try {
        const res = await fetch(`${API}/entries/dashboard-stats`)
        if (res.ok) setStats(await res.json())
      } catch { /* silently show placeholders */ }
    }
    load()
  }, [refreshKey, backendReady])

  const lastEntryDisplay = fmtLastEntry(stats?.last_entry)
  const avgStress        = stats?.avg_stress != null ? `${stats.avg_stress}/10` : '--/10'
  const streak           = stats?.streak ?? 0
  const todayDone        = (stats?.today_count ?? 0) > 0

  return (
    <div className="dashboard">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">COMMAND</h1>
          <span className="page-subtitle">{today}</span>
        </div>
        <div className="page-header-right">
          <div className="streak-block">
            <span className="streak-num">{streak}</span>
            <span className="streak-label">DAY STREAK</span>
          </div>
        </div>
      </div>

      <div className="dashboard-grid">

        {/* RECORD CARD — spans all 3 rows */}
        <div className="d-card d-card-record">
          <div className="record-orbit">
            <div className="record-ring" />
            <div className="record-ring" />
            <div className="record-ring" />
            <button className="record-btn" onClick={onRecord}>
              <span className="record-icon">⬤</span>
              <span className="record-text">{todayDone ? 'ADD' : 'RECORD'}</span>
            </button>
          </div>
          <div className="record-label">{todayDone ? 'ENTRY LOGGED TODAY' : 'BEGIN ENTRY'}</div>
          <div className="record-hint">
            {todayDone
              ? "TODAY'S ENTRY IS SAVED. TAP TO ADD ANOTHER."
              : 'CLICK TO RECORD YOUR DAILY ENTRY\nAI WILL TRANSCRIBE AND ANALYZE'
            }
          </div>
          <button className="rant-btn" onClick={onRant}>+ RANT MODE</button>
        </div>

        {/* LAST ENTRY — row 1, col 2 */}
        <div className="d-card">
          <div className="card-label">LAST ENTRY</div>
          <div className="card-value" style={{ fontSize: stats?.last_entry ? '16px' : undefined }}>
            {lastEntryDisplay.line1}
          </div>
          <div className="card-sub">{lastEntryDisplay.line2}</div>
        </div>

        {/* AVG STRESS — row 1, col 3 */}
        <div className="d-card">
          <div className="card-label">AVG STRESS</div>
          <div className={`card-value-mono ${stats?.avg_stress != null ? getStressColor(stats.avg_stress) : ''}`}>
            {avgStress}
          </div>
          <div className="card-sub">7 DAY AVERAGE</div>
        </div>

        {/* TO-DO LIST — row 2, cols 2-3 */}
        <TodoCard backendReady={backendReady} />

        {/* FLAGS — row 3, cols 2-3 */}
        <div className="d-card d-card-flags">
          <div className="card-label">ACTIVE FLAGS</div>
          <div className="flags-empty-main">NO FLAGS DETECTED</div>
          <div className="flags-empty-sub">
            FLAGS APPEAR AFTER 7+ ENTRIES. AI NEEDS DATA TO FIND PATTERNS.
          </div>
        </div>

      </div>
    </div>
  )
}

// ─── PYTHON MISSING SCREEN ────────────────────────────────────────────────────
// Shown when main.js cannot find a compatible Python installation.
// Sits over the boot splash. The user must install Python and restart.

function PythonMissingScreen() {
  const handleOpenPython = () => {
    if (window.witness?.openExternal) {
      window.witness.openExternal('https://python.org/downloads')
    }
  }

  const handleQuit = () => {
    if (window.witness?.close) {
      window.witness.close()
    }
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 10000,
      background: '#111111',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px',
      fontFamily: "'IBM Plex Mono', monospace",
    }}>
      {/* Error badge */}
      <div style={{
        fontSize: '9px',
        letterSpacing: '3px',
        color: '#e05050',
        background: 'rgba(224,80,80,0.12)',
        border: '1px solid rgba(224,80,80,0.35)',
        padding: '6px 14px',
        marginBottom: '28px',
      }}>
        STARTUP ERROR
      </div>

      {/* Title */}
      <div style={{
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: '42px',
        letterSpacing: '6px',
        color: '#f0e8dc',
        marginBottom: '16px',
      }}>
        PYTHON NOT FOUND
      </div>

      {/* Subtitle */}
      <div style={{
        fontSize: '11px',
        letterSpacing: '1.5px',
        color: '#a09080',
        marginBottom: '40px',
        textAlign: 'center',
      }}>
        WITNESS NEEDS PYTHON 3.11 OR LATER TO RUN ITS AI BACKEND
      </div>

      {/* Instructions box */}
      <div style={{
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderLeft: '3px solid #f5a830',
        padding: '28px 32px',
        maxWidth: '540px',
        width: '100%',
        marginBottom: '36px',
      }}>
        <div style={{
          fontSize: '8px',
          letterSpacing: '2.5px',
          color: '#f5a830',
          marginBottom: '20px',
        }}>
          HOW TO FIX THIS
        </div>

        {[
          'Go to python.org/downloads',
          'Download Python 3.12 (the big yellow button)',
          'Run the installer',
          ['IMPORTANT:', ' During install, check the box that says "Add Python to PATH" — easy to miss'],
          'Restart Witness',
        ].map((step, i) => (
          <div key={i} style={{
            display: 'flex',
            gap: '14px',
            marginBottom: '12px',
            alignItems: 'flex-start',
          }}>
            <span style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: '16px',
              color: 'rgba(245,168,48,0.5)',
              lineHeight: '1.3',
              flexShrink: 0,
              width: '18px',
            }}>
              {i + 1}
            </span>
            <span style={{
              fontSize: '11px',
              color: '#a09080',
              lineHeight: '1.6',
              letterSpacing: '0.5px',
            }}>
              {Array.isArray(step)
                ? <><span style={{ color: '#e05050' }}>{step[0]}</span>{step[1]}</>
                : step
              }
            </span>
          </div>
        ))}

        <div style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid #2a2a2a',
          fontSize: '9px',
          color: '#606060',
          letterSpacing: '1px',
          lineHeight: '1.7',
        }}>
          ALREADY HAVE PYTHON? OPEN WINDOWS TERMINAL AND TYPE: python --version<br />
          YOU NEED TO SEE "PYTHON 3.11" OR HIGHER.
        </div>
      </div>

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          onClick={handleOpenPython}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '10px',
            letterSpacing: '2px',
            color: '#f5a830',
            background: 'rgba(245,168,48,0.08)',
            border: '1px solid rgba(245,168,48,0.5)',
            padding: '12px 28px',
            cursor: 'pointer',
          }}
        >
          OPEN PYTHON.ORG
        </button>
        <button
          onClick={handleQuit}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '10px',
            letterSpacing: '2px',
            color: '#606060',
            background: 'transparent',
            border: '1px solid #2a2a2a',
            padding: '12px 28px',
            cursor: 'pointer',
          }}
        >
          QUIT
        </button>
      </div>
    </div>
  )
}

// ─── BOOT SPLASH ──────────────────────────────────────────────────────────────

function BootSplash({ dots }) {
  return (
    <div className="boot-splash">
      <div className="boot-wordmark">W I T N E S S</div>
      <div className="boot-tagline">PRIVATE INTELLIGENCE</div>
      <div className="boot-status">
        <div className="boot-spinner" />
        <span className="boot-msg">STARTING BACKEND{'.'.repeat(dots)}</span>
      </div>
    </div>
  )
}


// ─── OLLAMA MISSING SCREEN ────────────────────────────────────────────────────
// Shown when the backend starts but Ollama is not installed on the machine.
// Appears after the boot splash fades, sits over the full app.

function OllamaMissingScreen({ onDismiss }) {
  const openOllama = () => window.witness?.openExternal('https://ollama.com/download')

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      zIndex: 10000,
      background: '#111111',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '40px',
      fontFamily: "'IBM Plex Mono', monospace",
    }}>
      <div style={{
        fontSize: '9px',
        letterSpacing: '3px',
        color: '#e05050',
        background: 'rgba(224,80,80,0.12)',
        border: '1px solid rgba(224,80,80,0.35)',
        padding: '6px 14px',
        marginBottom: '28px',
      }}>
        OLLAMA NOT FOUND
      </div>

      <div style={{
        fontFamily: "'Bebas Neue', sans-serif",
        fontSize: '42px',
        letterSpacing: '6px',
        color: '#f0e8dc',
        marginBottom: '16px',
      }}>
        AI ENGINE REQUIRED
      </div>

      <div style={{
        fontSize: '11px',
        letterSpacing: '1.5px',
        color: '#a09080',
        marginBottom: '40px',
        textAlign: 'center',
        maxWidth: '480px',
        lineHeight: '1.6',
      }}>
        WITNESS USES OLLAMA TO RUN AI LOCALLY ON YOUR MACHINE.
        IT IS NOT INSTALLED OR NOT RUNNING.
      </div>

      <div style={{
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderLeft: '3px solid #f5a830',
        padding: '28px 32px',
        maxWidth: '540px',
        width: '100%',
        marginBottom: '36px',
      }}>
        <div style={{
          fontSize: '8px',
          letterSpacing: '2.5px',
          color: '#f5a830',
          marginBottom: '20px',
        }}>
          HOW TO FIX THIS
        </div>

        {[
          ['1', 'Go to ollama.com/download and install Ollama'],
          ['2', 'Open Witness and go to CONFIG to choose and download a model'],
          ['3', 'Wait for the model to download (about 9GB, one time only)'],
          ['4', 'Restart Witness'],
        ].map(([num, text]) => (
          <div key={num} style={{
            display: 'flex',
            gap: '14px',
            marginBottom: '12px',
            alignItems: 'flex-start',
          }}>
            <span style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: '16px',
              color: 'rgba(245,168,48,0.5)',
              lineHeight: '1.3',
              flexShrink: 0,
              width: '18px',
            }}>{num}</span>
            <span style={{
              fontSize: '11px',
              color: '#a09080',
              lineHeight: '1.6',
              letterSpacing: '0.5px',
            }}>{text}</span>
          </div>
        ))}

        <div style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid #2a2a2a',
          fontSize: '9px',
          color: '#606060',
          letterSpacing: '1px',
          lineHeight: '1.7',
        }}>
          FREE TO DOWNLOAD. RUNS ENTIRELY ON YOUR MACHINE. NO ACCOUNT NEEDED.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '16px' }}>
        <button
          onClick={openOllama}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '10px',
            letterSpacing: '2px',
            padding: '12px 28px',
            background: '#f5a830',
            color: '#111111',
            border: 'none',
            cursor: 'pointer',
            fontWeight: '600',
          }}
        >
          DOWNLOAD OLLAMA
        </button>
        <button
          onClick={onDismiss}
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: '10px',
            letterSpacing: '2px',
            padding: '12px 28px',
            background: 'transparent',
            color: '#a09080',
            border: '1px solid #2a2a2a',
            cursor: 'pointer',
          }}
        >
          CONTINUE ANYWAY
        </button>
      </div>
    </div>
  )
}

// ─── APP ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [page,          setPage]          = useState('dashboard')
  const [ollamaStatus,  setOllamaStatus]  = useState('loading')
  const [dashRefresh,   setDashRefresh]   = useState(0)
  const [backendReady,  setBackendReady]  = useState(false)
  const [bootDots,      setBootDots]      = useState(1)
  const [pythonMissing, setPythonMissing] = useState(false)
  const [ollamaMissing,  setOllamaMissing]  = useState(false)

  const splashRef = useRef(null)

  // Animated dots on splash screen
  useEffect(() => {
    if (backendReady) return
    const t = setInterval(() => setBootDots(d => (d % 3) + 1), 500)
    return () => clearInterval(t)
  }, [backendReady])

  // Wait for Electron's main process to signal that the backend is up.
  // main.js polls using Node's http module (silent — no browser console errors).
  // Falls back to a 30-second timeout in case the IPC signal never arrives.
  useEffect(() => {
    let fallbackTimer = null

    const reveal = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer)
      const el = splashRef.current
      if (el) {
        gsap.fromTo(el,
          { opacity: 1 },
          { opacity: 0, duration: 0.4, ease: 'power2.out',
            onComplete: () => setBackendReady(true) }
        )
      } else {
        setBackendReady(true)
      }
    }

    // Primary: listen for the IPC signal from main.js
    if (window.witness?.onBackendReady) {
      window.witness.onBackendReady(reveal)
    }

    // If Python wasn't found, show the install error screen instead of the splash
    if (window.witness?.onPythonNotFound) {
      window.witness.onPythonNotFound(() => {
        if (fallbackTimer) clearTimeout(fallbackTimer)
        setPythonMissing(true)
        // Don't call reveal() — keep splash visible underneath the error screen
      })
    }

    // Fallback: if IPC never fires (e.g. dev mode without Electron),
    // give up after 30 seconds and show the app anyway.
    fallbackTimer = setTimeout(reveal, 30000)

    return () => { if (fallbackTimer) clearTimeout(fallbackTimer) }
  }, [])

  // Only start checking Ollama once the backend is up — avoids console spam
  // during the startup window when Ollama hasn't launched yet.
  // If Ollama is still offline after 90 seconds, show the install screen.
  useEffect(() => {
    if (!backendReady) return

    let offlineCount = 0
    const OFFLINE_THRESHOLD = 6 // 6 x 15s = 90 seconds before showing install screen

    const checkOllama = async () => {
      try {
        const res = await fetch('http://localhost:11434/api/tags', {
          signal: AbortSignal.timeout(3000)
        })
        if (res.ok) {
          setOllamaStatus('online')
          setOllamaMissing(false)
          offlineCount = 0
        } else {
          setOllamaStatus('offline')
          offlineCount++
        }
      } catch {
        setOllamaStatus('offline')
        offlineCount++
      }
      // After 90 seconds of being offline, show the install prompt
      if (offlineCount >= OFFLINE_THRESHOLD) {
        setOllamaMissing(true)
      }
    }
    checkOllama()
    const interval = setInterval(checkOllama, 15000)
    return () => clearInterval(interval)
  }, [backendReady])

  useEffect(() => {
    if (window.witness?.onNavigate) {
      window.witness.onNavigate((screen) => setPage(screen))
    }
  }, [])

  const goTo = (newPage) => {
    if (newPage === page) return
    setPage(newPage)
  }

  const handleEntrySaved = () => {
    setDashRefresh(n => n + 1)
    setTimeout(() => goTo('logs'), 2000)
  }

  const handlers = {
    openRant:     () => goTo('rant'),
    openJournal:  () => goTo('journal'),
    onEntrySaved: handleEntrySaved,
    onRantSaved:  handleEntrySaved,
  }

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return (
        <Dashboard
          onRant={handlers.openRant}
          onRecord={handlers.openJournal}
          refreshKey={dashRefresh}
          backendReady={backendReady}
        />
      )
      case 'journal':   return <JournalEntry onSaved={handlers.onEntrySaved} />
      case 'memory':    return <Memory />
      case 'rant':      return <RantMode     onSaved={handlers.onRantSaved} backendReady={backendReady} />
      case 'write':     return <WriteMode    onSaved={handlers.onEntrySaved} />
      case 'logs':      return <LogBrowser />
      case 'insights':  return <Debrief />
      case 'health':    return <Vitals />
      case 'recap':     return <WeeklyRecap />
      case 'todos':     return <Todos />
      case 'chat':      return <Chat />
      case 'profile':   return <Profile />
      case 'export':    return <Export />
      case 'settings':  return <Settings />
      default:          return (
        <Dashboard
          onRant={handlers.openRant}
          onRecord={handlers.openJournal}
          refreshKey={dashRefresh}
          backendReady={backendReady}
        />
      )
    }
  }

  return (
    <div className="app">
      <TitleBar />
      {/* App content always renders — splash sits on top as an overlay */}
      <div className="app-body">
        <Sidebar active={page} onNav={goTo} ollamaStatus={ollamaStatus} />
        <main className="content">
          {renderPage()}
        </main>
      </div>
      {/* Boot splash: fixed overlay, fades out when backend responds, then unmounts */}
      {!backendReady && (
        <div
          ref={splashRef}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: '#111111',
          }}
        >
          <BootSplash dots={bootDots} />
        </div>
      )}
      {/* Python not found: shown over the splash when main.js can't find Python */}
      {pythonMissing && <PythonMissingScreen />}
      {ollamaMissing && !pythonMissing && (
        <OllamaMissingScreen onDismiss={() => setOllamaMissing(false)} />
      )}
    </div>
  )
}
