/**
 * WITNESS -- Profile  (Step 4)
 * Longitudinal self-model: recurring themes, emotional patterns,
 * apparent values, recurring challenges, plain summary.
 *
 * Save at: witness/src/Profile.jsx
 */

import { useState, useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

gsap.registerPlugin(useGSAP)

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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

// ─── SPINNER ─────────────────────────────────────────────────────────────────

function Spinner() {
  return <div className="pf-spinner" />
}

// ─── TAG LIST ────────────────────────────────────────────────────────────────

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

// ─── SECTION CARD ────────────────────────────────────────────────────────────

function Section({ title, accentColor, borderColor, children }) {
  return (
    <div className="pf-section" style={{ borderLeftColor: borderColor }}>
      <div className="pf-section-title" style={{ color: accentColor }}>{title}</div>
      <div className="pf-section-body">{children}</div>
    </div>
  )
}

// ─── EMPTY STATE ─────────────────────────────────────────────────────────────
// Uses CSS keyframe animation (pf-anim-in) -- no GSAP needed for a static reveal.

function EmptyState({ entryCount, minEntries, onGenerate, generating }) {
  const needed = Math.max(0, minEntries - entryCount)
  const ready  = entryCount >= minEntries

  return (
    <div className="pf-empty pf-anim-in">
      <div className="pf-empty-glyph">◈</div>
      <div className="pf-empty-title">NO PROFILE GENERATED</div>
      {ready ? (
        <>
          <div className="pf-empty-sub">
            {entryCount} {entryCount === 1 ? 'ENTRY' : 'ENTRIES'} ON RECORD.
            ENOUGH TO BUILD A PROFILE.
          </div>
          <div className="pf-empty-hint">
            Witness will read all your entries and identify recurring patterns,
            emotional tendencies, apparent values, and persistent challenges.
            This takes 30-90 seconds.
          </div>
          <button
            className="pf-generate-btn"
            onClick={onGenerate}
            disabled={generating}
          >
            {generating
              ? <><Spinner /> ANALYZING ENTRIES...</>
              : 'GENERATE PROFILE'
            }
          </button>
        </>
      ) : (
        <>
          <div className="pf-empty-sub">
            {entryCount === 0
              ? `RECORD AT LEAST ${minEntries} ENTRIES TO GENERATE A PROFILE.`
              : `${entryCount} ${entryCount === 1 ? 'ENTRY' : 'ENTRIES'} ON RECORD. RECORD ${needed} MORE.`
            }
          </div>
          <div className="pf-empty-hint">
            The profile needs enough data to find patterns across time.
            Single entries are not enough. Keep recording.
          </div>
        </>
      )}
    </div>
  )
}

// ─── GENERATING STATE ────────────────────────────────────────────────────────

function GeneratingState({ entryCount }) {
  const containerRef = useRef(null)
  const glyphRef     = useRef(null)

  useGSAP(() => {
    // Target the glyph ref directly -- no class selector
    gsap.to(glyphRef.current, {
      rotation: 360,
      duration:  3,
      repeat:   -1,
      ease:     'none',
    })
    // Query children inside the scoped container
    gsap.from(containerRef.current.querySelectorAll('.pf-gen-title, .pf-gen-sub'), {
      opacity:  0,
      y:        10,
      duration: 0.4,
      stagger:  0.1,
      ease:     'power2.out',
    })
  }, { scope: containerRef })

  return (
    <div className="pf-generating" ref={containerRef}>
      <div className="pf-gen-glyph" ref={glyphRef}>◈</div>
      <div className="pf-gen-title">ANALYZING YOUR ENTRIES</div>
      <div className="pf-gen-sub">
        Reading {entryCount} {entryCount === 1 ? 'entry' : 'entries'} for
        patterns across time. This takes 30-90 seconds.
      </div>
    </div>
  )
}

// ─── PROFILE CONTENT ─────────────────────────────────────────────────────────

function ProfileContent({ profile }) {
  const ref = useRef(null)

  useGSAP(() => {
    const el = ref.current
    if (!el) return
    // All selectors are queried inside the ref -- no leaking to other screens
    gsap.from(el.querySelectorAll('.pf-meta-bar'), {
      opacity:  0,
      y:       -8,
      duration: 0.3,
      ease:    'power2.out',
    })
    gsap.from(el.querySelectorAll('.pf-summary-block'), {
      opacity:  0,
      y:        12,
      duration: 0.4,
      delay:    0.1,
      ease:     'power2.out',
    })
    gsap.from(el.querySelectorAll('.pf-section'), {
      opacity:  0,
      y:        18,
      duration: 0.4,
      stagger:  0.08,
      delay:    0.2,
      ease:     'power2.out',
    })
    gsap.from(el.querySelectorAll('.pf-disclaimer'), {
      opacity:  0,
      duration: 0.35,
      delay:    0.55,
      ease:     'power2.out',
    })
  }, { scope: ref, dependencies: [profile.generated_at] })

  const isStale    = profile.stale === true
  const genAt      = profile.generated_at
  const atGenCount = profile.entry_count_at_gen ?? 0
  const currCount  = profile.current_entry_count ?? 0

  return (
    <div ref={ref}>
      <div className="pf-meta-bar">
        <span className="pf-meta-item">
          GENERATED FROM {atGenCount} {atGenCount === 1 ? 'ENTRY' : 'ENTRIES'}
        </span>
        <span className="pf-meta-sep">·</span>
        <span className="pf-meta-item">{fmtDate(genAt)}</span>
        {isStale && (
          <>
            <span className="pf-meta-sep">·</span>
            <span className="pf-meta-item pf-meta-stale">
              {currCount - atGenCount} NEW {(currCount - atGenCount) === 1 ? 'ENTRY' : 'ENTRIES'} SINCE LAST GENERATION
            </span>
          </>
        )}
      </div>

      {profile.plain_summary && (
        <div className="pf-summary-block">
          <div className="pf-summary-label">SUMMARY</div>
          <p className="pf-summary-text">{profile.plain_summary}</p>
        </div>
      )}

      <div className="pf-grid">
        <Section title="RECURRING THEMES"     accentColor="#f5a830" borderColor="rgba(245,168,48,0.5)">
          <TagList items={profile.recurring_themes}     accentColor="#f5a830" />
        </Section>
        <Section title="EMOTIONAL PATTERNS"   accentColor="#c87850" borderColor="rgba(200,120,80,0.5)">
          <TagList items={profile.emotional_patterns}   accentColor="#c87850" />
        </Section>
        <Section title="APPARENT VALUES"      accentColor="#50a870" borderColor="rgba(80,168,112,0.5)">
          <TagList items={profile.apparent_values}      accentColor="#50a870" />
        </Section>
        <Section title="RECURRING CHALLENGES" accentColor="#e05050" borderColor="rgba(224,80,80,0.4)">
          <TagList items={profile.recurring_challenges} accentColor="#e05050" />
        </Section>
      </div>

      <div className="pf-disclaimer">
        This profile is generated from your journal entries only. It reflects what you
        choose to record, not who you are in full. Regenerate after adding more entries
        to improve accuracy. All data stays on your machine.
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function Profile() {
  const [profile,    setProfile]    = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState('')
  const headerRef = useRef(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res  = await fetch(`${API}/profile/`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed to load profile')
      setProfile(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setError('')
    try {
      const res  = await fetch(`${API}/profile/generate`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Generation failed')
      setProfile(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  useEffect(() => { load() }, [])

  // Animate header using its ref directly -- no class selector
  useGSAP(() => {
    if (!headerRef.current) return
    gsap.from(headerRef.current, {
      opacity:  0,
      y:       -10,
      duration: 0.35,
      ease:    'power2.out',
    })
  }, { scope: headerRef })

  const isNotGenerated = profile?.status === 'not_generated'
  const hasProfile     = profile?.status === 'ok' || profile?.status === 'generated'
  const isStale        = profile?.stale === true
  const entryCount     = profile?.current_entry_count ?? profile?.entry_count ?? 0
  const minEntries     = profile?.min_entries ?? 5

  if (loading) return (
    <div className="pf-screen">
      <div className="pf-loading">
        <Spinner />
        <span>LOADING PROFILE...</span>
      </div>
    </div>
  )

  return (
    <div className="pf-screen">

      <div className="pf-header page-header" ref={headerRef}>
        <div className="page-header-left">
          <h1 className="page-title">PROFILE</h1>
          <span className="page-subtitle">LONGITUDINAL SELF-MODEL</span>
        </div>
        <div className="page-header-right pf-header-actions">
          {isStale && !generating && (
            <span
              className="pf-stale-badge"
              title={`${profile.current_entry_count - profile.entry_count_at_gen} new entries since last generation`}
            >
              STALE -- UPDATE DUE
            </span>
          )}
          {hasProfile && !generating && (
            <button className="pf-regen-btn" onClick={handleGenerate}>
              REGENERATE
            </button>
          )}
        </div>
      </div>

      <div className="pf-content">

        {error && (
          <div className="pf-error">
            <span className="pf-error-label">ERROR</span>
            <span className="pf-error-msg">{error}</span>
            <button className="pf-retry-btn" onClick={hasProfile ? handleGenerate : load}>
              {hasProfile ? 'TRY AGAIN' : 'RETRY'}
            </button>
          </div>
        )}

        {generating && <GeneratingState entryCount={entryCount} />}

        {!generating && isNotGenerated && (
          <EmptyState
            entryCount={entryCount}
            minEntries={minEntries}
            onGenerate={handleGenerate}
            generating={generating}
          />
        )}

        {!generating && hasProfile && (
          <ProfileContent profile={profile} />
        )}

      </div>
    </div>
  )
}
