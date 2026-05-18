/**
 * WITNESS — Memory Screen (merged with Profile)
 *
 * Combines:
 *   - AI Memory Document (auto-updated after each entry)
 *   - Extracted Facts (discrete facts learned from entries)
 *   - Self-Model / Profile (recurring themes, emotional patterns,
 *     apparent values, recurring challenges, plain summary)
 *   - HOW MEMORY WORKS explainer
 *   - DANGER ZONE (wipe memory)
 *
 * Bug fixes (batch 9):
 *   - CRITICAL: `import { useGSAP } from '@gsap/react'` crashed the entire screen
 *     because @gsap/react is not installed in node_modules (listed in package.json
 *     but never npm-installed). Replaced all useGSAP() calls with standard
 *     useEffect() + gsap — functionally identical, no extra package needed.
 *   - window.confirm() in handleReset blocked in Electron. Replaced with inline
 *     confirmingReset state and a two-button confirm row in the Danger Zone.
 *   - handleSaveEdit had no res.ok check — backend 4xx/5xx errors were silently
 *     accepted and the UI showed the edit as saved. Added check + error display.
 *   - loadMemory called .json() on both responses without checking res.ok first —
 *     a 500 body may not be valid JSON, causing a confusing parse error. Added
 *     res.ok guards before .json() on both fetches.
 *   - loadProfile called res.json() before the res.ok check — same parse-error
 *     risk on error responses. Swapped order to check ok first.
 *
 * Save at: witness/src/Memory.jsx  (replace the existing file)
 * Profile.jsx is no longer used and can be deleted.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'
// NOTE: @gsap/react is NOT installed. All animations use plain useEffect + gsap.

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '--'
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    }).toUpperCase()
  } catch {
    return iso
  }
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

// ─── PROFILE TAG LIST ─────────────────────────────────────────────────────────

function TagList({ items, accentColor }) {
  if (!items || items.length === 0) return (
    <p className="pf-empty-list">Nothing detected yet.</p>
  )
  return (
    <ul className="pf-tag-list">
      {items.map((item, i) => (
        <li key={i} className="pf-tag-item">
          <span className="pf-tag-bullet" style={{ color: accentColor }}>◆</span>
          <span className="pf-tag-text">{item}</span>
        </li>
      ))}
    </ul>
  )
}

// ─── PROFILE SECTION CARD ─────────────────────────────────────────────────────

function ProfileSection({ title, accentColor, borderColor, children, animDelay }) {
  return (
    <div className="pf-section pf-anim-in" style={{ borderLeftColor: borderColor, animationDelay: animDelay }}>
      <div className="pf-section-title" style={{ color: accentColor }}>{title}</div>
      <div className="pf-section-body">{children}</div>
    </div>
  )
}

// ─── PROFILE GENERATING STATE ─────────────────────────────────────────────────

function GeneratingState({ entryCount }) {
  return (
    <div className="pf-generating pf-anim-in">
      <div className="pf-gen-glyph pf-spin">◈</div>
      <div className="pf-gen-title">ANALYZING YOUR ENTRIES</div>
      <div className="pf-gen-sub">
        Reading {entryCount} {entryCount === 1 ? 'entry' : 'entries'} for
        patterns across time. This takes 30-90 seconds.
      </div>
    </div>
  )
}

// ─── PROFILE CONTENT ──────────────────────────────────────────────────────────

function ProfileContent({ profile }) {
  const atGenCount = profile.entry_count_at_gen ?? 0

  return (
    <div>
      {profile.plain_summary && (
        <div className="pf-summary-block pf-anim-in">
          <div className="pf-summary-label">SUMMARY</div>
          <p className="pf-summary-text">{profile.plain_summary}</p>
        </div>
      )}
      <div className="pf-grid">
        <ProfileSection title="RECURRING THEMES"     accentColor="#f5a830" borderColor="rgba(245,168,48,0.5)" animDelay="0.05s">
          <TagList items={profile.recurring_themes}     accentColor="#f5a830" />
        </ProfileSection>
        <ProfileSection title="EMOTIONAL PATTERNS"   accentColor="#c87850" borderColor="rgba(200,120,80,0.5)" animDelay="0.1s">
          <TagList items={profile.emotional_patterns}   accentColor="#c87850" />
        </ProfileSection>
        <ProfileSection title="APPARENT VALUES"      accentColor="#50a870" borderColor="rgba(80,168,112,0.5)" animDelay="0.15s">
          <TagList items={profile.apparent_values}      accentColor="#50a870" />
        </ProfileSection>
        <ProfileSection title="RECURRING CHALLENGES" accentColor="#e05050" borderColor="rgba(224,80,80,0.4)" animDelay="0.2s">
          <TagList items={profile.recurring_challenges} accentColor="#e05050" />
        </ProfileSection>
      </div>
      <div className="mem-profile-meta pf-anim-in" style={{ animationDelay: '0.25s' }}>
        GENERATED FROM {atGenCount} {atGenCount === 1 ? 'ENTRY' : 'ENTRIES'} · {fmtDate(profile.generated_at)}
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function Memory() {
  // Memory state
  const [memoryDoc,    setMemoryDoc]    = useState('')
  const [facts,        setFacts]        = useState([])
  const [stats,        setStats]        = useState(null)
  const [memLoading,   setMemLoading]   = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [editingDoc,   setEditingDoc]   = useState(false)
  const [editDraft,    setEditDraft]    = useState('')

  // Profile state
  const [profile,         setProfile]         = useState(null)
  const [profileLoading,  setProfileLoading]  = useState(true)
  const [profileGenerating, setProfileGenerating] = useState(false)

  // Shared error
  const [error, setError] = useState('')
  const [confirmingReset, setConfirmingReset] = useState(false)

  // Animation refs
  const containerRef  = useRef(null)
  const headerRef     = useRef(null)
  const docBlockRef   = useRef(null)
  const factsBlockRef = useRef(null)
  const animatedRef   = useRef(false)

  const loading = memLoading || profileLoading

  // ── Load memory ──
  const loadMemory = useCallback(async () => {
    setMemLoading(true)
    try {
      const [memRes, factsRes] = await Promise.all([
        fetch(`${API}/memory/`),
        fetch(`${API}/memory/facts`),
      ])
      // Check ok before .json() — error responses may not be valid JSON
      if (!memRes.ok)   throw new Error(`Memory API error ${memRes.status}`)
      if (!factsRes.ok) throw new Error(`Facts API error ${factsRes.status}`)
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
      setFacts((factsData.facts || []).filter(f => !f.dismissed))
    } catch (e) {
      setError(`Could not load memory data: ${e.message}`)
    } finally {
      setMemLoading(false)
    }
  }, [])

  // ── Load profile ──
  const loadProfile = useCallback(async () => {
    setProfileLoading(true)
    try {
      const res = await fetch(`${API}/profile/`)
      // Check ok before .json() — a 500 body may not be valid JSON
      if (!res.ok) throw new Error(`Profile API error ${res.status}`)
      const data = await res.json()
      setProfile(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setProfileLoading(false)
    }
  }, [])

  useEffect(() => {
    loadMemory()
    loadProfile()
  }, [loadMemory, loadProfile])

  // ── Entrance animation ──
  useEffect(() => {
    if (loading || animatedRef.current) return
    animatedRef.current = true
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } })
    if (headerRef.current)     tl.fromTo(headerRef.current,     { y: -14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 })
    if (docBlockRef.current)   tl.fromTo(docBlockRef.current,   { y: 20,  opacity: 0 }, { y: 0, opacity: 1, duration: 0.4 }, '-=0.2')
    if (factsBlockRef.current) tl.fromTo(factsBlockRef.current, { y: 20,  opacity: 0 }, { y: 0, opacity: 1, duration: 0.4 }, '-=0.25')
  }, [loading])

  // ── Rebuild memory document ──
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
        gsap.fromTo(docBlockRef.current.querySelector('.mem-doc-text'),
          { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out' }
        )
      }
      await loadMemory()
    } catch (e) {
      setError(`Memory rebuild failed: ${e.message}`)
    } finally {
      setRegenerating(false)
    }
  }

  // ── Generate / regenerate profile ──
  const handleGenerateProfile = async () => {
    setProfileGenerating(true)
    setError('')
    try {
      const res  = await fetch(`${API}/profile/generate`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Profile generation failed')
      setProfile(data)
    } catch (e) {
      setError(`Profile generation failed: ${e.message}`)
    } finally {
      setProfileGenerating(false)
    }
  }

  // ── Save edited memory document ──
  const handleSaveEdit = async () => {
    try {
      const res = await fetch(`${API}/settings/memory_document`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ value: editDraft }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
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

  // ── Wipe memory ──
  const handleReset = async () => {
    // window.confirm() is blocked in Electron — use inline two-step confirm instead
    if (!confirmingReset) {
      setConfirmingReset(true)
      return
    }
    setConfirmingReset(false)
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

  // Profile derived state
  const profileStatus      = profile?.status
  const hasProfile         = profileStatus === 'ok' || profileStatus === 'generated'
  const profileNotGenerated = profileStatus === 'not_generated'
  const profileStale       = profile?.stale === true
  const entryCount         = profile?.current_entry_count ?? profile?.entry_count ?? stats?.entryCount ?? 0
  const minEntries         = profile?.min_entries ?? 5
  const profileReady       = entryCount >= minEntries

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
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 2, color: '#606060' }}>
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
        <div className="page-header-right">
          {/* Row 1: stat chips */}
          {stats && (
            <div className="mem-header-stats">
              <span className="mem-stat">{stats.entryCount} {stats.entryCount === 1 ? 'ENTRY' : 'ENTRIES'}</span>
              <span className="mem-stat-sep">·</span>
              <span className="mem-stat">{facts.length} {facts.length === 1 ? 'FACT' : 'FACTS'}</span>
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
          {/* Row 2: action buttons */}
          <div className="mem-header-actions">
            {profileStale && !profileGenerating && (
              <span className="pf-stale-badge">PROFILE STALE</span>
            )}
            {hasProfile && !profileGenerating && (
              <button className="pf-regen-btn" onClick={handleGenerateProfile}>
                REGENERATE PROFILE
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
                <span>REBUILD MEMORY</span>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="mem-body">

        {/* ERROR */}
        {error && (
          <div className="je-error">
            <span className="je-error-label">ERROR</span>
            <span>{error}</span>
            <button
              className="je-btn-ghost"
              style={{ marginLeft: 'auto', flexShrink: 0 }}
              onClick={() => setError('')}
            >
              DISMISS
            </button>
          </div>
        )}

        {/* ── MEMORY DOCUMENT ── */}
        <div className="mem-doc-block" ref={docBlockRef}>
          <div className="mem-section-header">
            <div>
              <div className="je-section-label">MEMORY DOCUMENT</div>
              <div className="je-section-sub">
                AI-MAINTAINED PERSONAL CONTEXT — INJECTED INTO EVERY RESPONSE
              </div>
            </div>
            {!editingDoc && memoryDoc && (
              <button
                className="je-btn-ghost"
                onClick={() => { setEditingDoc(true); setEditDraft(memoryDoc) }}
              >
                EDIT
              </button>
            )}
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
                  <button className="je-btn je-btn-save" onClick={handleSaveEdit}>SAVE EDITS</button>
                  <button className="je-btn-ghost" onClick={() => { setEditingDoc(false); setEditDraft(memoryDoc) }}>
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
                  ? `YOU HAVE ${stats.entryCount} ENTRIES. CLICK REBUILD MEMORY TO GENERATE.`
                  : 'RECORD AT LEAST A FEW JOURNAL ENTRIES FIRST. MEMORY BUILDS AUTOMATICALLY AFTER EACH ENTRY.'}
              </div>
            </div>
          )}

          <div className="mem-doc-hint">
            THIS DOCUMENT IS AUTOMATICALLY UPDATED AFTER EACH JOURNAL ENTRY.
            YOU CAN EDIT OR REBUILD IT AT ANY TIME. IT IS NEVER SHARED OR SENT ONLINE.
          </div>
        </div>

        {/* ── EXTRACTED FACTS ── */}
        <div className="mem-facts-block" ref={factsBlockRef}>
          <div className="mem-section-header">
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

        {/* ── SELF-MODEL (Profile) ── */}
        <div className="mem-profile-block">
          <div className="mem-section-header">
            <div>
              <div className="je-section-label">SELF-MODEL</div>
              <div className="je-section-sub">
                RECURRING THEMES, EMOTIONAL PATTERNS, VALUES AND CHALLENGES ACROSS YOUR ENTRIES
              </div>
            </div>
          </div>

          {profileGenerating && <GeneratingState entryCount={entryCount} />}

          {!profileGenerating && profileNotGenerated && (
            <div className="mem-empty-state">
              <div className="mem-empty-label">NO SELF-MODEL GENERATED YET</div>
              {profileReady ? (
                <>
                  <div className="mem-empty-sub">
                    {entryCount} ENTRIES ON RECORD. ENOUGH TO BUILD A SELF-MODEL.
                  </div>
                  <button
                    className="je-btn je-btn-record"
                    onClick={handleGenerateProfile}
                    disabled={profileGenerating}
                    style={{ marginTop: 12 }}
                  >
                    GENERATE SELF-MODEL
                  </button>
                </>
              ) : (
                <div className="mem-empty-sub">
                  {entryCount === 0
                    ? `RECORD AT LEAST ${minEntries} ENTRIES TO GENERATE A SELF-MODEL.`
                    : `${entryCount} ${entryCount === 1 ? 'ENTRY' : 'ENTRIES'} ON RECORD. RECORD ${minEntries - entryCount} MORE.`}
                </div>
              )}
            </div>
          )}

          {!profileGenerating && hasProfile && (
            <ProfileContent profile={profile} />
          )}
        </div>

        {/* ── HOW MEMORY WORKS ── */}
        <div className="mem-explainer-block">
          <div className="je-section-label">HOW MEMORY WORKS</div>
          <div className="mem-explainer-grid">
            <div className="mem-explainer-card">
              <div className="mem-explainer-num">01</div>
              <div className="mem-explainer-title">LIVING DOCUMENT</div>
              <div className="mem-explainer-text">
                After every entry, the AI reads your transcript and updates a personal
                context document. This document is injected into every AI prompt —
                follow-up questions, insights, and recaps all have stable knowledge of who you are.
              </div>
            </div>
            <div className="mem-explainer-card">
              <div className="mem-explainer-num">02</div>
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

        {/* ── DANGER ZONE ── */}
        <div className="mem-danger-block">
          <div className="je-section-label">DANGER ZONE</div>
          <div className="mem-danger-row">
            <div>
              <div className="mem-danger-title">WIPE MEMORY</div>
              <div className="mem-danger-sub">
                Clears the memory document and all extracted facts. Your journal entries are not affected.
              </div>
            </div>
            {!confirmingReset ? (
              <button className="mem-danger-btn" onClick={handleReset}>
                WIPE MEMORY
              </button>
            ) : (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: '#e05050', letterSpacing: 1 }}>
                  ARE YOU SURE?
                </span>
                <button className="mem-danger-btn" onClick={handleReset}>
                  YES, WIPE
                </button>
                <button className="je-btn-ghost" onClick={() => setConfirmingReset(false)}>
                  CANCEL
                </button>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
