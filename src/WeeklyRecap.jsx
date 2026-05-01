/**
 * WITNESS — Weekly Recap  (Step 14)
 * SITREP screen: Mon–Sun week, cached AI summary, metric grid,
 * best/worst day, goal review, workout summary, export.
 *
 * Save at: witness/src/WeeklyRecap.jsx
 */

import { useState, useEffect, useRef } from 'react'

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  const s = iso.length === 10 ? iso + 'T12:00:00' : iso
  return new Date(s).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  }).toUpperCase()
}

function fmtDateShort(iso) {
  if (!iso) return '—'
  const s = iso.length === 10 ? iso + 'T12:00:00' : iso
  return new Date(s).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric'
  }).toUpperCase()
}

function fmtMins(mins) {
  if (!mins) return '—'
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function scoreColor(val, inverted = false) {
  if (val == null) return 'rgba(255,255,255,0.3)'
  const good = inverted ? val <= 4 : val >= 7
  const bad  = inverted ? val >= 7 : val <= 4
  if (good) return '#50a870'
  if (bad)  return '#e05050'
  return '#f5a830'
}

// ─── METRIC BAR ──────────────────────────────────────────────────────────────

function MetricBar({ label, value, inverted = false, max = 10 }) {
  const pct   = value != null ? (value / max) * 100 : 0
  const color = scoreColor(value, inverted)

  return (
    <div className="sr-metric-bar">
      <div className="sr-metric-bar-header">
        <span className="sr-metric-label">{label}</span>
        <span className="sr-metric-value" style={{ color }}>
          {value != null ? value.toFixed(1) : '—'}
        </span>
      </div>
      <div className="sr-metric-track">
        <div
          className="sr-metric-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}

// ─── STAT PILL ────────────────────────────────────────────────────────────────

function StatPill({ label, value, color = '#f5a830' }) {
  return (
    <div className="sr-stat-pill">
      <span className="sr-stat-pill-label">{label}</span>
      <span className="sr-stat-pill-value" style={{ color }}>{value ?? '—'}</span>
    </div>
  )
}

// ─── SECTION BLOCK ────────────────────────────────────────────────────────────

function Section({ title, accent, children, animDelay = 0 }) {
  return (
    <div
      className="sr-section"
      style={{
        borderLeftColor: accent || 'rgba(245,168,48,0.4)',
        animationDelay: `${animDelay}ms`
      }}
    >
      <div className="sr-section-title" style={{ color: accent || '#a09080' }}>
        {title}
      </div>
      <div className="sr-section-body">{children}</div>
    </div>
  )
}

// ─── GOAL LIST ────────────────────────────────────────────────────────────────

function GoalList({ goals, accent = '#f5a830' }) {
  if (!goals || goals.length === 0) return (
    <p className="sr-prose sr-prose-muted">No goals recorded.</p>
  )
  return (
    <ol className="sr-goal-list">
      {goals.map((g, i) => (
        <li key={i} className="sr-goal-item">
          <span className="sr-goal-num" style={{ color: accent }}>{i + 1}</span>
          <span className="sr-goal-text">{g}</span>
        </li>
      ))}
    </ol>
  )
}

// ─── DAY CALLOUT ─────────────────────────────────────────────────────────────

function DayCallout({ label, day, note, accent }) {
  if (!day) return null
  const entry  = day.entry || {}
  return (
    <div className="sr-day-callout" style={{ borderColor: accent + '33' }}>
      <div className="sr-day-callout-badge" style={{ background: accent + '22', color: accent }}>
        {label}
      </div>
      <div className="sr-day-callout-date">{fmtDate(day.date)}</div>
      {note && <p className="sr-prose sr-prose-muted" style={{ marginTop: '0.4rem' }}>{note}</p>}
      <div className="sr-day-callout-metrics">
        {['stress','mood','energy'].map(k => entry[k] != null && (
          <span key={k} className="sr-day-metric-chip">
            <span className="sr-day-metric-key">{k.toUpperCase()}</span>
            <span className="sr-day-metric-val"
              style={{ color: scoreColor(entry[k], k === 'stress') }}>
              {entry[k]}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── EMPTY STATE ─────────────────────────────────────────────────────────────

function EmptyState({ entryCount, weekStart, weekEnd }) {
  const needed = Math.max(0, 3 - (entryCount || 0))
  return (
    <div className="sr-empty">
      <div className="sr-empty-week">
        {fmtDateShort(weekStart)} — {fmtDateShort(weekEnd)}
      </div>
      <div className="sr-empty-glyph">◈</div>
      <div className="sr-empty-title">SITREP PENDING</div>
      <div className="sr-empty-sub">
        {entryCount === 0
          ? 'RECORD AT LEAST 3 ENTRIES THIS WEEK TO GENERATE A RECAP.'
          : `${entryCount} ${entryCount === 1 ? 'ENTRY' : 'ENTRIES'} LOGGED THIS WEEK. RECORD ${needed} MORE TO GENERATE THE RECAP.`}
      </div>
      <div className="sr-empty-hint">
        A recap with fewer than 3 entries is not meaningful. Keep recording —
        the recap generates on demand and caches for the rest of the week.
      </div>
    </div>
  )
}

// ─── GENERATE PROMPT ─────────────────────────────────────────────────────────

function GeneratePrompt({ entryCount, onGenerate, generating }) {
  return (
    <div className="sr-generate-prompt">
      <div className="sr-generate-copy">
        <span className="sr-generate-count">{entryCount} {entryCount === 1 ? 'ENTRY' : 'ENTRIES'} THIS WEEK</span>
        <span className="sr-generate-sub">Recap has not been generated yet.</span>
      </div>
      <button
        className="sr-generate-btn"
        onClick={onGenerate}
        disabled={generating}
      >
        {generating ? (
          <><div className="sr-spinner" /> GENERATING...</>
        ) : (
          'GENERATE SITREP'
        )}
      </button>
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function WeeklyRecap() {
  const [recap,      setRecap]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState('')
  const [exported,   setExported]   = useState(false)

  const load = async (forceGenerate = false) => {
    if (forceGenerate) {
      setGenerating(true)
      setError('')
    } else {
      setLoading(true)
    }

    try {
      const url = forceGenerate
        ? `${API}/recap/regenerate`
        : `${API}/recap/current`

      const method = forceGenerate ? 'POST' : 'GET'
      const res    = await fetch(url, { method })
      const data   = await res.json()

      if (!res.ok) throw new Error(data.detail || 'Failed to load recap')
      setRecap(data)
      setExported(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setGenerating(false)
    }
  }

  // Load week-data immediately (for metric display before AI runs)
  const loadWeekData = async () => {
    try {
      const res  = await fetch(`${API}/recap/week-data`)
      const data = await res.json()
      // If no cached recap yet, pre-populate with the raw data
      setRecap(prev => prev ? prev : { status: 'no_data', ...data })
    } catch (e) {
      // Non-fatal — just won't pre-populate
    }
  }

  useEffect(() => {
    // Load week-data first (fast), then try to get cached recap
    loadWeekData().then(() => load())
  }, [])

  const handleExport = async () => {
    try {
      const res  = await fetch(`${API}/recap/export`)
      if (!res.ok) throw new Error('Export failed')
      const text = await res.text()

      // Trigger browser download via Blob
      const blob = new Blob([text], { type: 'text/markdown' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      const week = recap?.week_start || 'week'
      a.href     = url
      a.download = `witness-sitrep-${week}.md`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExported(true)
    } catch (e) {
      setError('Export failed. Generate the recap first.')
    }
  }

  // Derived state
  const hasRecap    = recap && recap.summary
  // Handle both old 'no_data' and new 'insufficient_data' status values
  const isNoData    = recap?.status === 'no_data' || recap?.status === 'insufficient_data'
  const isCached    = recap?.status === 'cached'
  const weekStart   = recap?.week_start
  const weekEnd     = recap?.week_end
  const entryCount  = recap?.entry_count ?? 0
  const ma          = recap?.metric_avgs || {}
  const ha          = recap?.health_avgs || {}
  const ws          = recap?.workout_summary || {}

  return (
    <div className="sr-screen">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="sr-header">
        <div className="sr-header-left">
          <h1 className="page-title">SITREP</h1>
          <span className="page-subtitle">
            {weekStart && weekEnd
              ? `${fmtDateShort(weekStart)} — ${fmtDateShort(weekEnd)}`
              : 'WEEKLY RECAP'}
          </span>
        </div>
        <div className="sr-header-right">
          {hasRecap && (
            <>
              {isCached && (
                <span className="sr-cache-badge">CACHED</span>
              )}
              <button
                className="sr-action-btn"
                onClick={handleExport}
                title="Export as Markdown"
              >
                {exported ? 'EXPORTED' : 'EXPORT .MD'}
              </button>
              <button
                className="sr-action-btn sr-action-btn-accent"
                onClick={() => load(true)}
                disabled={generating}
              >
                {generating ? <><div className="sr-spinner sr-spinner-sm" /> REGENERATING...</> : 'REGENERATE'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div className="sr-content">

        {loading && !recap ? (
          <div className="sr-loading">
            <div className="sr-spinner" />
            <span>LOADING SITREP...</span>
          </div>
        ) : error ? (
          <div className="sr-error">
            <span className="sr-error-label">ERROR</span>
            <span>{error}</span>
            <button className="sr-action-btn" onClick={() => load()}>RETRY</button>
          </div>
        ) : isNoData ? (
          <EmptyState entryCount={entryCount} weekStart={weekStart} weekEnd={weekEnd} />
        ) : (
          <>
            {/* ── Metric grid always visible ─────────────────────── */}
            <div className="sr-two-col">

              {/* Left: journal metrics */}
              <Section title="PSYCH METRICS" accent="rgba(245,168,48,0.7)" animDelay={0}>
                <MetricBar label="MOOD"          value={ma.mood}          />
                <MetricBar label="ENERGY"        value={ma.energy}        />
                <MetricBar label="STRESS"        value={ma.stress}        inverted />
                <MetricBar label="ANXIETY"       value={ma.anxiety}       inverted />
                <MetricBar label="PRODUCTIVITY"  value={ma.productivity}  />
                <MetricBar label="MENTAL CLARITY" value={ma.mental_clarity} />
                <MetricBar label="SOCIAL SAT"    value={ma.social_sat}    />
              </Section>

              {/* Right: health + workout */}
              <div className="sr-right-col">
                <Section title="BIOMETRICS" accent="rgba(80,200,200,0.7)" animDelay={60}>
                  <div className="sr-health-grid">
                    <StatPill label="AVG HRV"     value={ha.hrv       != null ? `${Math.round(ha.hrv)} ms`       : null} color="#50c8c8" />
                    <StatPill label="RESTING HR"  value={ha.resting_hr != null ? `${Math.round(ha.resting_hr)} bpm` : null} color="#e05050" />
                    <StatPill label="AVG SLEEP"   value={ha.sleep_total_mins ? fmtMins(ha.sleep_total_mins) : null} color="#9050e0" />
                    <StatPill label="DEEP SLEEP"  value={ha.sleep_deep_mins  ? fmtMins(ha.sleep_deep_mins)  : null} color="#5090e0" />
                    <StatPill label="AVG STEPS"   value={ha.steps     != null ? Math.round(ha.steps).toLocaleString() : null} color="#50a870" />
                    <StatPill label="ACTIVE CAL"  value={ha.active_calories != null ? `${Math.round(ha.active_calories)} kcal` : null} color="#c38c32" />
                  </div>
                </Section>

                <Section title="WORKOUTS" accent="rgba(80,168,112,0.7)" animDelay={120}>
                  {ws.session_count > 0 ? (
                    <div className="sr-workout-summary">
                      <div className="sr-workout-big">{ws.session_count}</div>
                      <div className="sr-workout-label">SESSIONS</div>
                      <div className="sr-workout-detail">
                        {fmtMins(ws.total_mins)} total
                        {ws.types?.length > 0 && (
                          <span className="sr-workout-types">
                            {ws.types.map(t => t.toUpperCase()).join(' · ')}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="sr-prose sr-prose-muted">No workouts logged this week.</p>
                  )}
                </Section>
              </div>
            </div>

            {/* ── Best / Worst day ──────────────────────────────────── */}
            {(recap?.best_day || recap?.worst_day) && (
              <div className="sr-day-row">
                <DayCallout
                  label="BEST DAY"
                  day={recap.best_day}
                  note={recap.best_day_note}
                  accent="#50a870"
                />
                <DayCallout
                  label="WORST DAY"
                  day={recap.worst_day}
                  note={recap.worst_day_note}
                  accent="#e05050"
                />
              </div>
            )}

            {/* ── Generate prompt if no AI summary yet ─────────────── */}
            {!hasRecap && entryCount >= 2 && (
              <GeneratePrompt
                entryCount={entryCount}
                onGenerate={() => load(true)}
                generating={generating}
              />
            )}

            {/* ── AI content (only if recap generated) ─────────────── */}
            {hasRecap && (
              <>
                {/* Summary */}
                <Section title="SUMMARY" accent="rgba(245,168,48,0.6)" animDelay={180}>
                  {recap.summary.split('\n').filter(Boolean).map((para, i) => (
                    <p key={i} className="sr-prose">{para}</p>
                  ))}
                </Section>

                {/* Patterns */}
                {recap.patterns?.length > 0 && (
                  <Section title="PATTERNS DETECTED" accent="rgba(224,149,32,0.5)" animDelay={220}>
                    <ul className="sr-pattern-list">
                      {recap.patterns.map((p, i) => (
                        <li key={i} className="sr-pattern-item">
                          <span className="sr-pattern-bullet">◆</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {/* Goal review */}
                {recap.goals_review && (
                  <Section title="LAST WEEK'S GOALS — REVIEW" accent="rgba(160,144,128,0.5)" animDelay={260}>
                    <p className="sr-prose">{recap.goals_review}</p>
                    {recap.prior_goals?.length > 0 && (
                      <div className="sr-prior-goals">
                        {recap.prior_goals.map((g, i) => (
                          <div key={i} className="sr-prior-goal-item">
                            <span className="sr-prior-bullet">—</span>
                            <span className="sr-prose sr-prose-muted">{g}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </Section>
                )}

                {/* Next week goals */}
                {recap.goals_next?.length > 0 && (
                  <Section title="NEXT WEEK — FOCUS AREAS" accent="rgba(80,168,112,0.6)" animDelay={300}>
                    <GoalList goals={recap.goals_next} accent="#50a870" />
                  </Section>
                )}
              </>
            )}

            {error && (
              <div className="sr-error">
                <span className="sr-error-label">ERROR</span>
                <span>{error}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
