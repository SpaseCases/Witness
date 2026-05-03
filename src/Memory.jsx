/**
 * WITNESS — Memory Screen (Step 5 — patched)
 *
 * Fixes:
 *   1. GSAP errors — all animations now target direct refs, not global class
 *      selectors. useGSAP runs once after loading=false; re-runs are blocked.
 *   2. Extracted facts formatting — facts are plain strings. The grid now
 *      renders correctly and the empty-state box has a proper dark border so
 *      it doesn't look broken.
 *
 * Save at: witness/src/Memory.jsx  (replace the existing file)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

const API = 'http://127.0.0.1:8000'

// ─── STATUS PIP ───────────────────────────────────────────────────────────────

function StatusPip({ status }) {
  const colors = {
    online:  '#50a870',
    offline: '#606060',
    loading: '#f5a830',
  }
  return (
    <span style={{
      display:      'inline-block',
      width:        7,
      height:       7,
      borderRadius: '50%',
      background:   colors[status] || '#606060',
      marginRight:  8,
      flexShrink:   0,
    }} />
  )
}

// ─── FACT CARD ────────────────────────────────────────────────────────────────

function FactCard({ fact, onDismiss }) {
  const cardRef = useRef(null)

  const handleDismiss = () => {
    gsap.to(cardRef.current, {
      opacity: 0, x: 20, duration: 0.2,
      onComplete: onDismiss,
    })
  }

  // fact.fact is always a plain string — render it directly
  const text = typeof fact.fact === 'string' ? fact.fact : String(fact.fact ?? '')

  return (
    <div className="mem-fact-card" ref={cardRef}>
      <span className="mem-fact-text">{text}</span>
      <button
        className="mem-fact-dismiss"
        onClick={handleDismiss}
        title="Remove this fact"
      >
        ✕
      </button>
    </div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function Memory() {
  const [memoryDoc,    setMemoryDoc]    = useState('')
  const [facts,        setFacts]        = useState([])
  const [stats,        setStats]        = useState(null)
  const [loading,      setLoading]      = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [error,        setError]        = useState('')
  const [editingDoc,   setEditingDoc]   = useState(false)
  const [editDraft,    setEditDraft]    = useState('')

  // Animation target refs — avoid global class selectors entirely
  const containerRef  = useRef(null)
  const headerRef     = useRef(null)
  const docBlockRef   = useRef(null)
  const factsBlockRef = useRef(null)

  // Track whether the entrance animation has already run
  const animatedRef = useRef(false)

  // ── Load memory on mount ──
  const loadMemory = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [memRes, factsRes] = await Promise.all([
        fetch(`${API}/memory/`),
        fetch(`${API}/memory/facts`),
      ])
      const memData   = await memRes.json()
      const factsData = await factsRes.json()

      setMemoryDoc(memData.memory_document || '')
      setEditDraft(memData.memory_document || '')
      setStats({
        entryCount: memData.entry_count,
        factCount:  memData.fact_count,
        updatedAt:  memData.updated_at,
        hasMemory:  memData.has_memory,
      })
      // Filter dismissed facts — they come back with dismissed=0/1
      setFacts((factsData.facts || []).filter(f => !f.dismissed))
    } catch (e) {
      setError('Could not load memory data. Is the backend running?')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadMemory() }, [loadMemory])

  // ── Page entrance — runs once after loading finishes ──
  useGSAP(() => {
    // Only animate on the first load, not on every re-fetch
    if (loading || animatedRef.current) return
    animatedRef.current = true

    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } })

    if (headerRef.current) {
      tl.from(headerRef.current, { y: -14, opacity: 0, duration: 0.35 })
    }
    if (docBlockRef.current) {
      tl.from(docBlockRef.current, { y: 20, opacity: 0, duration: 0.4 }, '-=0.2')
    }
    if (factsBlockRef.current) {
      tl.from(factsBlockRef.current, { y: 20, opacity: 0, duration: 0.4 }, '-=0.25')
    }
  }, { scope: containerRef, dependencies: [loading] })

  // ── Regenerate ──
  const handleRegenerate = async () => {
    setRegenerating(true)
    setError('')
    try {
      const res  = await fetch(`${API}/memory/regenerate`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || `Server error ${res.status}`)
      }
      const data = await res.json()
      setMemoryDoc(data.memory_document || '')
      setEditDraft(data.memory_document || '')

      if (docBlockRef.current) {
        gsap.from(docBlockRef.current.querySelector('.mem-doc-text'), {
          opacity: 0, y: 8, duration: 0.3, ease: 'power2.out',
        })
      }

      await loadMemory()
    } catch (e) {
      setError(`Regeneration failed: ${e.message}`)
    } finally {
      setRegenerating(false)
    }
  }

  // ── Save edited document ──
  const handleSaveEdit = async () => {
    try {
      await fetch(`${API}/settings/memory_document`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ value: editDraft }),
      })
      setMemoryDoc(editDraft)
      setEditingDoc(false)
    } catch (e) {
      setError(`Could not save: ${e.message}`)
    }
  }

  // ── Dismiss a fact ──
  const handleDismissFact = async (factId) => {
    try {
      await fetch(`${API}/memory/facts/${factId}`, { method: 'DELETE' })
      setFacts(prev => prev.filter(f => f.id !== factId))
    } catch (e) {
      setError(`Could not dismiss fact: ${e.message}`)
    }
  }

  // ── Reset ──
  const handleReset = async () => {
    if (!window.confirm(
      'This will wipe the memory document and all facts. Your journal entries are not affected. Continue?'
    )) return
    try {
      await fetch(`${API}/memory/reset`, { method: 'POST' })
      setMemoryDoc('')
      setEditDraft('')
      setFacts([])
    } catch (e) {
      setError(`Reset failed: ${e.message}`)
    }
  }

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).toUpperCase()

  if (loading) {
    return (
      <div className="memory-screen" ref={containerRef}>
        <div className="page-header">
          <div className="page-header-left">
            <h1 className="page-title">MEMORY</h1>
            <span className="page-subtitle">{today}</span>
          </div>
        </div>
        <div className="mem-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="working-spinner" />
          <span style={{
            fontFamily:    'var(--font-mono)',
            fontSize:      9,
            letterSpacing: 2,
            color:         '#606060',
          }}>
            LOADING MEMORY...
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="memory-screen" ref={containerRef}>

      {/* HEADER */}
      <div className="page-header" ref={headerRef}>
        <div className="page-header-left">
          <h1 className="page-title">MEMORY</h1>
          <span className="page-subtitle">{today}</span>
        </div>
        <div
          className="page-header-right"
          style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}
        >
          {stats && (
            <div className="mem-stats-row">
              <span className="mem-stat">{stats.entryCount} ENTRIES</span>
              <span className="mem-stat-sep">·</span>
              <span className="mem-stat">{facts.length} FACTS</span>
              {stats.updatedAt && (
                <>
                  <span className="mem-stat-sep">·</span>
                  <span className="mem-stat">
                    UPDATED {new Date(stats.updatedAt + 'Z').toLocaleDateString('en-US', {
                      month: 'short', day: 'numeric',
                    }).toUpperCase()}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mem-body">

        {/* ERROR */}
        {error && (
          <div className="je-error">
            <span className="je-error-label">ERROR</span>
            <span>{error}</span>
          </div>
        )}

        {/* LIVING MEMORY DOCUMENT */}
        <div className="mem-doc-block" ref={docBlockRef}>
          <div className="mem-section-header">
            <div>
              <div className="je-section-label">MEMORY DOCUMENT</div>
              <div className="je-section-sub">
                AI-MAINTAINED PERSONAL CONTEXT — INJECTED INTO EVERY RESPONSE
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {!editingDoc && memoryDoc && (
                <button
                  className="je-btn-ghost"
                  onClick={() => { setEditingDoc(true); setEditDraft(memoryDoc) }}
                >
                  EDIT
                </button>
              )}
              <button
                className={`je-btn ${regenerating ? '' : 'je-btn-record'}`}
                onClick={handleRegenerate}
                disabled={regenerating || !stats?.entryCount}
                style={{ opacity: (regenerating || !stats?.entryCount) ? 0.5 : 1 }}
              >
                {regenerating ? (
                  <>
                    <div className="working-spinner" style={{ width: 12, height: 12 }} />
                    <span>REBUILDING...</span>
                  </>
                ) : (
                  <span>REBUILD FROM ENTRIES</span>
                )}
              </button>
            </div>
          </div>

          {memoryDoc ? (
            editingDoc ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea
                  className="je-transcript-editor mem-doc-text"
                  value={editDraft}
                  onChange={e => setEditDraft(e.target.value)}
                  rows={6}
                  spellCheck
                  lang="en"
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="je-btn je-btn-save" onClick={handleSaveEdit}>
                    SAVE EDITS
                  </button>
                  <button
                    className="je-btn-ghost"
                    onClick={() => { setEditingDoc(false); setEditDraft(memoryDoc) }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            ) : (
              <div className="mem-doc-text">{memoryDoc}</div>
            )
          ) : (
            <div className="mem-empty-state">
              <div className="mem-empty-label">NO MEMORY DOCUMENT YET</div>
              <div className="mem-empty-sub">
                {stats?.entryCount > 0
                  ? `YOU HAVE ${stats.entryCount} ENTRIES. CLICK REBUILD TO GENERATE YOUR MEMORY DOCUMENT.`
                  : 'RECORD AT LEAST A FEW JOURNAL ENTRIES FIRST. MEMORY BUILDS AUTOMATICALLY AFTER EACH ENTRY.'}
              </div>
              {stats?.entryCount > 0 && (
                <button
                  className="je-btn je-btn-record"
                  onClick={handleRegenerate}
                  disabled={regenerating}
                  style={{ marginTop: 12, opacity: regenerating ? 0.5 : 1 }}
                >
                  {regenerating ? 'REBUILDING...' : 'BUILD MEMORY NOW'}
                </button>
              )}
            </div>
          )}

          <div className="mem-doc-hint">
            THIS DOCUMENT IS AUTOMATICALLY UPDATED AFTER EACH JOURNAL ENTRY.
            YOU CAN EDIT OR REBUILD IT AT ANY TIME. IT IS NEVER SHARED OR SENT ONLINE.
          </div>
        </div>

        {/* EXTRACTED FACTS */}
        <div className="mem-facts-block" ref={factsBlockRef}>
          <div className="mem-section-header" style={{ marginBottom: 12 }}>
            <div>
              <div className="je-section-label">EXTRACTED FACTS</div>
              <div className="je-section-sub">
                SPECIFIC THINGS THE AI HAS LEARNED ABOUT YOU FROM YOUR ENTRIES
              </div>
            </div>
          </div>

          {facts.length > 0 ? (
            <div className="mem-facts-grid">
              {facts.map(fact => (
                <FactCard
                  key={fact.id}
                  fact={fact}
                  onDismiss={() => handleDismissFact(fact.id)}
                />
              ))}
            </div>
          ) : (
            <div className="mem-facts-empty">
              <div className="mem-empty-label">NO FACTS EXTRACTED YET</div>
              <div className="mem-empty-sub">
                FACTS ARE EXTRACTED AUTOMATICALLY AFTER EACH ENTRY.
                THEY REPRESENT DURABLE THINGS ABOUT YOU — NOT MOODS OR EVENTS.
              </div>
            </div>
          )}
        </div>

        {/* HOW IT WORKS */}
        <div className="mem-explainer-block">
          <div className="je-section-label" style={{ marginBottom: 12 }}>HOW MEMORY WORKS</div>
          <div className="mem-explainer-grid">
            <div className="mem-explainer-card">
              <div className="mem-explainer-num">B</div>
              <div className="mem-explainer-title">LIVING DOCUMENT</div>
              <div className="mem-explainer-text">
                After every entry, the AI reads your transcript and updates a personal
                context document. This document is injected into every AI prompt —
                follow-up questions, insights, and recaps all have stable knowledge of who you are.
              </div>
            </div>
            <div className="mem-explainer-card">
              <div className="mem-explainer-num">C</div>
              <div className="mem-explainer-title">EPISODIC RECALL</div>
              <div className="mem-explainer-text">
                Every entry is stored as a semantic fingerprint in ChromaDB.
                When generating follow-up questions, the AI searches for the most
                similar past entries and includes them as context — letting it
                notice patterns across weeks and months.
              </div>
            </div>
          </div>
        </div>

        {/* DANGER ZONE */}
        <div className="mem-danger-block">
          <div className="je-section-label" style={{ marginBottom: 8 }}>DANGER ZONE</div>
          <div className="mem-danger-row">
            <div>
              <div className="mem-danger-title">WIPE MEMORY</div>
              <div className="mem-danger-sub">
                Clears the memory document and all extracted facts. Your journal entries are not affected.
              </div>
            </div>
            <button className="mem-danger-btn" onClick={handleReset}>
              WIPE MEMORY
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
