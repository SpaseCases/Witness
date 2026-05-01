/**
 * WITNESS — Todos.jsx
 * Dedicated To-Do / Projects screen.
 *
 * Save this file at: witness/src/Todos.jsx
 *
 * Two views:
 *   LIST VIEW   — all todos, newest first. Click any item to open detail.
 *   DETAIL VIEW — full-screen detail for one todo: notes, source journal
 *                 excerpt, related todos from same entry. Back button returns
 *                 to list.
 *
 * Features:
 *   - Manual add (text input + ADD button)
 *   - AI-sourced badge + "FROM DATE" label on AI-generated items
 *   - PROJECT badge for items the AI flagged as multi-step projects
 *   - Append notes to any todo (manual text notes)
 *   - Delete individual notes
 *   - Delete entire todo
 *   - Mark done / undone
 *   - Flood of AI items handled server-side (20-item guard)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'
import './styles/todos.css'

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSourceDate(dateStr) {
  if (!dateStr) return null
  try {
    const d = new Date(dateStr + 'T00:00:00')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
  } catch {
    return null
  }
}

function fmtFullDate(dateStr) {
  if (!dateStr) return null
  try {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }).toUpperCase()
  } catch {
    return null
  }
}

// ─── DETAIL VIEW ──────────────────────────────────────────────────────────────

function TodoDetail({ todoId, onBack, onDelete, onToggleDone }) {
  const [detail,      setDetail]      = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [noteInput,   setNoteInput]   = useState('')
  const [submitting,  setSubmitting]  = useState(false)
  const [editingText, setEditingText] = useState(false)
  const [editVal,     setEditVal]     = useState('')
  const containerRef  = useRef(null)
  const noteRefs      = useRef({})

  // Load detail on mount
  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(`${API}/todos/${todoId}/detail`)
        if (res.ok) {
          const data = await res.json()
          setDetail(data)
          setEditVal(data.todo?.text || '')
        }
      } catch (e) {
        console.error('Failed to load todo detail', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [todoId])

  // Animate in
  useEffect(() => {
    if (!loading && containerRef.current) {
      gsap.fromTo(containerRef.current,
        { opacity: 0, x: 24 },
        { opacity: 1, x: 0, duration: 0.28, ease: 'power2.out' }
      )
    }
  }, [loading])

  const refreshDetail = async () => {
    try {
      const res = await fetch(`${API}/todos/${todoId}/detail`)
      if (res.ok) setDetail(await res.json())
    } catch {}
  }

  // Append a note
  const addNote = async () => {
    const note = noteInput.trim()
    if (!note) return
    setSubmitting(true)
    try {
      const res = await fetch(`${API}/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ append_note: note })
      })
      if (res.ok) {
        setNoteInput('')
        await refreshDetail()
      }
    } catch {} finally {
      setSubmitting(false)
    }
  }

  // Delete a note by index
  const deleteNote = async (index) => {
    const el = noteRefs.current[index]
    if (el) {
      gsap.fromTo(el,
        { opacity: 1, x: 0 },
        { opacity: 0, x: 20, duration: 0.18, ease: 'power2.in',
          onComplete: async () => {
            await fetch(`${API}/todos/${todoId}/note/${index}`, { method: 'DELETE' })
            await refreshDetail()
          }
        }
      )
    } else {
      await fetch(`${API}/todos/${todoId}/note/${index}`, { method: 'DELETE' })
      await refreshDetail()
    }
  }

  // Save edited title
  const saveTitle = async () => {
    const text = editVal.trim()
    if (!text || text === detail?.todo?.text) { setEditingText(false); return }
    try {
      const res = await fetch(`${API}/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
      if (res.ok) {
        setEditingText(false)
        await refreshDetail()
      }
    } catch {}
  }

  // Toggle done from detail view
  const handleToggle = async () => {
    if (!detail) return
    const newDone = !detail.todo.done
    try {
      await fetch(`${API}/todos/${todoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: newDone })
      })
      await refreshDetail()
      if (onToggleDone) onToggleDone(todoId, newDone)
    } catch {}
  }

  // Delete the whole todo
  const handleDelete = async () => {
    if (!window.confirm('Delete this todo permanently?')) return
    try {
      await fetch(`${API}/todos/${todoId}`, { method: 'DELETE' })
      if (onDelete) onDelete(todoId)
      onBack()
    } catch {}
  }

  if (loading) {
    return (
      <div className="todos-detail-loading">
        <span className="todos-loading-text">LOADING...</span>
      </div>
    )
  }

  if (!detail) {
    return (
      <div className="todos-detail-loading">
        <span className="todos-loading-text">FAILED TO LOAD</span>
        <button className="todos-back-btn" onClick={onBack}>← BACK</button>
      </div>
    )
  }

  const { todo, source_entry, related_todos } = detail
  const notes      = Array.isArray(todo.notes) ? todo.notes : []
  const srcDate    = fmtSourceDate(todo.source_date)
  const isAI       = !!todo.source_entry_id
  const isProject  = !!todo.is_project

  return (
    <div className="todos-detail" ref={containerRef}>

      {/* Top bar */}
      <div className="todos-detail-topbar">
        <button className="todos-back-btn" onClick={onBack}>← BACK</button>
        <div className="todos-detail-actions">
          <button
            className={`todos-action-btn ${todo.done ? 'todos-action-undone' : 'todos-action-done'}`}
            onClick={handleToggle}
          >
            {todo.done ? 'MARK UNDONE' : 'MARK DONE'}
          </button>
          <button className="todos-action-btn todos-action-delete" onClick={handleDelete}>
            DELETE
          </button>
        </div>
      </div>

      {/* Title block */}
      <div className="todos-detail-title-block">
        <div className="todos-detail-badges">
          {isProject && <span className="todos-badge todos-badge-project">PROJECT</span>}
          {isAI      && <span className="todos-badge todos-badge-ai">AI</span>}
          {todo.done && <span className="todos-badge todos-badge-done">DONE</span>}
        </div>

        {editingText ? (
          <div className="todos-title-edit-row">
            <input
              className="todos-title-input"
              value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingText(false) }}
              autoFocus
              maxLength={120}
            />
            <button className="todos-save-btn" onClick={saveTitle}>SAVE</button>
            <button className="todos-cancel-btn" onClick={() => setEditingText(false)}>CANCEL</button>
          </div>
        ) : (
          <h2
            className={`todos-detail-title ${todo.done ? 'todos-detail-title-done' : ''}`}
            onClick={() => setEditingText(true)}
            title="Click to edit"
          >
            {todo.text}
          </h2>
        )}

        <div className="todos-detail-meta">
          {isAI && srcDate && (
            <span className="todos-detail-meta-item">EXTRACTED FROM ENTRY: {srcDate}</span>
          )}
          <span className="todos-detail-meta-item">
            CREATED: {fmtFullDate(todo.created_at)}
          </span>
          {todo.done && todo.done_at && (
            <span className="todos-detail-meta-item todos-meta-done">
              COMPLETED: {fmtFullDate(todo.done_at)}
            </span>
          )}
        </div>
      </div>

      {/* Notes section */}
      <div className="todos-detail-section">
        <div className="todos-section-label">NOTES & UPDATES</div>

        {notes.length === 0 && (
          <div className="todos-notes-empty">NO NOTES YET. ADD ONE BELOW.</div>
        )}

        {notes.map((note, i) => (
          <div
            key={i}
            className="todos-note-row"
            ref={el => { if (el) noteRefs.current[i] = el }}
          >
            <span className="todos-note-bullet">▸</span>
            <span className="todos-note-text">{note}</span>
            <button
              className="todos-note-delete"
              onClick={() => deleteNote(i)}
              title="Delete this note"
            >
              ✕
            </button>
          </div>
        ))}

        {/* Add note input */}
        <div className="todos-note-input-row">
          <input
            className="todos-note-input"
            type="text"
            placeholder="ADD A NOTE OR UPDATE..."
            value={noteInput}
            onChange={e => setNoteInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addNote() }}
            maxLength={300}
            disabled={submitting}
          />
          <button
            className="todos-note-add-btn"
            onClick={addNote}
            disabled={!noteInput.trim() || submitting}
          >
            ADD
          </button>
        </div>
      </div>

      {/* Source journal entry */}
      {source_entry && (
        <div className="todos-detail-section">
          <div className="todos-section-label">SOURCE JOURNAL ENTRY — {fmtSourceDate(source_entry.date)}</div>
          <div className="todos-source-transcript">
            {source_entry.transcript
              ? source_entry.transcript.slice(0, 800) + (source_entry.transcript.length > 800 ? '...' : '')
              : <span className="todos-transcript-empty">NO TRANSCRIPT</span>
            }
          </div>
        </div>
      )}

      {/* Related todos from same entry */}
      {related_todos && related_todos.length > 0 && (
        <div className="todos-detail-section">
          <div className="todos-section-label">OTHER ITEMS FROM SAME ENTRY</div>
          {related_todos.map(rt => (
            <div key={rt.id} className="todos-related-row">
              <span className={`todos-related-check ${rt.done ? 'todos-related-done' : ''}`}>
                {rt.done ? '■' : '□'}
              </span>
              <span className={`todos-related-text ${rt.done ? 'todos-related-text-done' : ''}`}>
                {rt.text}
              </span>
              {rt.is_project ? <span className="todos-badge todos-badge-project-sm">PROJECT</span> : null}
            </div>
          ))}
        </div>
      )}

    </div>
  )
}

// ─── LIST ROW ─────────────────────────────────────────────────────────────────

function TodoRow({ task, onClick, onToggle, onDelete, selectMode, isSelected, onSelectToggle }) {
  const rowRef    = useRef(null)
  const srcDate   = fmtSourceDate(task.source_date)
  const isAI      = !!task.source_entry_id
  const isProject = !!task.is_project
  const notes     = Array.isArray(task.notes) ? task.notes : []

  return (
    <div
      className={`todos-row ${task.done ? 'todos-row-done' : ''} ${selectMode && isSelected ? 'todos-row-selected' : ''}`}
      ref={rowRef}
    >
      {/* Bulk-select checkbox — only visible in select mode */}
      {selectMode ? (
        <button
          className={`todos-bulk-check ${isSelected ? 'checked' : ''}`}
          onClick={e => { e.stopPropagation(); onSelectToggle(task.id) }}
          title={isSelected ? 'Deselect' : 'Select'}
        >
          {isSelected ? '■' : '□'}
        </button>
      ) : (
        /* Normal done/undone checkbox */
        <button
          className="todos-row-check"
          onClick={e => { e.stopPropagation(); onToggle(task, rowRef) }}
          title={task.done ? 'Mark undone' : 'Mark done'}
        >
          {task.done ? '■' : '□'}
        </button>
      )}

      {/* Main body — click opens detail (disabled in select mode, click selects instead) */}
      <div
        className="todos-row-body"
        onClick={() => selectMode ? onSelectToggle(task.id) : onClick(task.id)}
      >
        <div className="todos-row-top">
          <span className={`todos-row-text ${task.done ? 'todos-row-text-done' : ''}`}>
            {task.text}
          </span>
          <div className="todos-row-badges">
            {isProject && <span className="todos-badge todos-badge-project">PROJECT</span>}
            {isAI      && <span className="todos-badge todos-badge-ai">AI</span>}
          </div>
        </div>
        <div className="todos-row-meta">
          {isAI && srcDate && (
            <span className="todos-row-source">FROM {srcDate}</span>
          )}
          {notes.length > 0 && (
            <span className="todos-row-notes-count">{notes.length} NOTE{notes.length !== 1 ? 'S' : ''}</span>
          )}
        </div>
      </div>

      {/* Delete button — hidden in select mode */}
      {!selectMode && (
        <button
          className="todos-row-delete"
          onClick={e => { e.stopPropagation(); onDelete(task, rowRef) }}
          title="Delete task"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ─── MAIN TODOS SCREEN ────────────────────────────────────────────────────────

export default function Todos() {
  const [tasks,               setTasks]               = useState([])
  const [loading,             setLoading]             = useState(true)
  const [input,               setInput]               = useState('')
  const [detailId,            setDetailId]            = useState(null)   // null = list view
  const [filter,              setFilter]              = useState('all')  // 'all' | 'open' | 'done' | 'project' | 'ai'
  const [selectMode,          setSelectMode]          = useState(false)
  const [selectedIds,         setSelectedIds]         = useState(new Set())
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false)
  const [bulkDeleting,        setBulkDeleting]        = useState(false)
  const listRef   = useRef(null)
  const inputRef  = useRef(null)

  // Load tasks
  const loadTasks = useCallback(async () => {
    try {
      const res = await fetch(`${API}/todos/`)
      if (res.ok) setTasks(await res.json())
    } catch {}
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadTasks() }, [loadTasks])

  // Animate list in after load
  useEffect(() => {
    if (!loading && listRef.current) {
      const rows = listRef.current.querySelectorAll('.todos-row')
      if (rows.length) {
        gsap.fromTo(rows,
          { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.22, stagger: 0.04, ease: 'power2.out' }
        )
      }
    }
  }, [loading, filter])

  // Add a new task
  const addTask = async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    try {
      const res = await fetch(`${API}/todos/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text })
      })
      if (res.ok) {
        const newTask = await res.json()
        setTasks(prev => [newTask, ...prev])
        // Animate new row in after React renders it
        setTimeout(() => {
          const el = listRef.current?.querySelector(`[data-id="${newTask.id}"]`)
          if (el) {
            gsap.fromTo(el,
              { opacity: 0, x: -16 },
              { opacity: 1, x: 0, duration: 0.25, ease: 'power2.out' }
            )
          }
        }, 30)
      }
    } catch {}
    inputRef.current?.focus()
  }

  // Toggle done
  const toggleTask = useCallback(async (task, rowRef) => {
    const newDone = !task.done
    // Optimistic update
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: newDone } : t))
    try {
      await fetch(`${API}/todos/${task.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ done: newDone })
      })
    } catch {}
  }, [])

  // Delete task
  const deleteTask = useCallback(async (task, rowRef) => {
    const el = rowRef?.current
    const doDelete = async () => {
      setTasks(prev => prev.filter(t => t.id !== task.id))
      if (typeof task.id === 'number') {
        try { await fetch(`${API}/todos/${task.id}`, { method: 'DELETE' }) } catch {}
      }
    }

    if (el) {
      gsap.fromTo(el,
        { opacity: 1, x: 0 },
        { opacity: 0, x: 20, duration: 0.18, ease: 'power2.in', onComplete: doDelete }
      )
    } else {
      doDelete()
    }
  }, [])

  // Open detail view
  const openDetail = (id) => {
    setDetailId(id)
  }

  // Back from detail
  const closeDetail = () => {
    setDetailId(null)
    loadTasks()  // refresh list in case notes/done changed
  }

  // ── Select mode helpers ───────────────────────────────────────────────────

  // Filtered task list — declared here so selectAll can reference it
  const filteredTasks = tasks.filter(t => {
    if (filter === 'open')    return !t.done
    if (filter === 'done')    return  t.done
    if (filter === 'project') return  t.is_project && !t.done
    if (filter === 'ai')      return  !!t.source_entry_id && !t.done
    return true
  })

  const enterSelectMode = () => {
    setSelectMode(true)
    setSelectedIds(new Set())
    setConfirmingBulkDelete(false)
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
    setConfirmingBulkDelete(false)
  }

  const toggleSelectItem = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (selectedIds.size === filteredTasks.length) {
      // All already selected — deselect all
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredTasks.map(t => t.id)))
    }
  }

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return
    setBulkDeleting(true)
    const ids = Array.from(selectedIds)
    // Optimistic removal
    setTasks(prev => prev.filter(t => !selectedIds.has(t.id)))
    exitSelectMode()
    try {
      await fetch(`${API}/todos/bulk`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids }),
      })
    } catch {
      // If the request fails, reload from server to restore accurate state
      loadTasks()
    } finally {
      setBulkDeleting(false)
    }
  }

  const openCount    = tasks.filter(t => !t.done).length
  const projectCount = tasks.filter(t => t.is_project && !t.done).length
  const aiCount      = tasks.filter(t => t.source_entry_id && !t.done).length

  // ── Detail view ───────────────────────────────────────────────────────────
  if (detailId !== null) {
    return (
      <div className="todos-screen">
        <TodoDetail
          todoId={detailId}
          onBack={closeDetail}
          onDelete={(id) => setTasks(prev => prev.filter(t => t.id !== id))}
          onToggleDone={(id, done) =>
            setTasks(prev => prev.map(t => t.id === id ? { ...t, done } : t))
          }
        />
      </div>
    )
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div className="todos-screen">

      {/* Page header */}
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">TASKS</h1>
          <span className="page-subtitle">
            {openCount} OPEN · {projectCount} PROJECT{projectCount !== 1 ? 'S' : ''} · {aiCount} AI-SOURCED
          </span>
        </div>
        <div className="page-header-right">
          {!selectMode ? (
            <button className="todos-select-btn" onClick={enterSelectMode}>
              SELECT
            </button>
          ) : confirmingBulkDelete ? (
            /* ── Inline confirmation bar ── */
            <div className="todos-bulk-confirm">
              <span className="todos-bulk-confirm-text">
                DELETE {selectedIds.size} ITEM{selectedIds.size !== 1 ? 'S' : ''}?
              </span>
              <button
                className="todos-bulk-confirm-yes"
                onClick={bulkDelete}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? 'DELETING...' : 'CONFIRM'}
              </button>
              <button
                className="todos-bulk-cancel"
                onClick={() => setConfirmingBulkDelete(false)}
              >
                CANCEL
              </button>
            </div>
          ) : (
            /* ── Select mode controls ── */
            <div className="todos-select-controls">
              {selectedIds.size > 0 && (
                <button
                  className="todos-bulk-delete-btn"
                  onClick={() => setConfirmingBulkDelete(true)}
                >
                  DELETE SELECTED ({selectedIds.size})
                </button>
              )}
              <button className="todos-select-cancel" onClick={exitSelectMode}>
                ✕ CANCEL
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Select-all row — only shown in select mode with items present */}
      {selectMode && filteredTasks.length > 0 && (
        <div className="todos-select-all-row">
          <button
            className={`todos-bulk-check ${selectedIds.size === filteredTasks.length && filteredTasks.length > 0 ? 'checked' : ''}`}
            onClick={selectAll}
          >
            {selectedIds.size === filteredTasks.length && filteredTasks.length > 0 ? '■' : '□'}
          </button>
          <span className="todos-select-all-label" onClick={selectAll}>
            {selectedIds.size === filteredTasks.length && filteredTasks.length > 0
              ? 'DESELECT ALL'
              : `SELECT ALL (${filteredTasks.length})`}
          </span>
          {selectedIds.size > 0 && (
            <span className="todos-select-count">{selectedIds.size} SELECTED</span>
          )}
        </div>
      )}

      {/* Add task row */}
      <div className="todos-add-row">
        <input
          ref={inputRef}
          className="todos-add-input"
          type="text"
          placeholder="NEW TASK OR PROJECT..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addTask() }}
          maxLength={120}
        />
        <button
          className="todos-add-btn"
          onClick={addTask}
          disabled={!input.trim()}
        >
          + ADD
        </button>
      </div>

      {/* Filter tabs */}
      <div className="todos-filters">
        {[
          { id: 'all',     label: 'ALL' },
          { id: 'open',    label: 'OPEN' },
          { id: 'project', label: 'PROJECTS' },
          { id: 'ai',      label: 'AI-SOURCED' },
          { id: 'done',    label: 'DONE' },
        ].map(f => (
          <button
            key={f.id}
            className={`todos-filter-btn ${filter === f.id ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Task list */}
      <div className="todos-list" ref={listRef}>
        {loading && (
          <div className="todos-empty">LOADING...</div>
        )}

        {!loading && filteredTasks.length === 0 && (
          <div className="todos-empty">
            {filter === 'all'
              ? 'NO TASKS YET. ADD ONE ABOVE OR RECORD A JOURNAL ENTRY.'
              : `NO ${filter.toUpperCase()} TASKS.`
            }
          </div>
        )}

        {!loading && filteredTasks.map(task => (
          <div key={task.id} data-id={task.id}>
            <TodoRow
              task={task}
              onClick={openDetail}
              onToggle={toggleTask}
              onDelete={deleteTask}
              selectMode={selectMode}
              isSelected={selectedIds.has(task.id)}
              onSelectToggle={toggleSelectItem}
            />
          </div>
        ))}
      </div>

    </div>
  )
}
