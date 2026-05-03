/**
 * WITNESS — SITREP Screen
 * Weekly + Monthly recap with tab toggle.
 * Weekly tab: unchanged from original.
 * Monthly tab: 30-day rolling window, trend direction, recurring themes,
 *              honest observation, watch-next-month.
 *
 * Save at: witness/src/WeeklyRecap.jsx  (replaces existing file)
 */

import { useState, useEffect } from 'react'

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

const TREND_COLORS = {
  improving: '#50a870',
  declining: '#e05050',
  mixed:     '#f5a830',
  flat:      '#a09080',
}

const TREND_LABELS = {
  improving: '▲ IMPROVING',
  declining: '▼ DECLINING',
  mixed:     '◆ MIXED',
  flat:      '— FLAT',
}

// ─── SHARED SUB-COMPONENTS ───────────────────────────────────────────────────

function MetricBar({ label, value, inverted = false }) {
  const pct   = value != null ? (value / 10) * 100 : 0
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
        <div className="sr-metric-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

function StatPill({ label, value, color = '#f5a830' }) {
  return (
    <div className="sr-stat-pill">
      <span className="sr-stat-pill-label">{label}</span>
      <span className="sr-stat-pill-value" style={{ color }}>{value ?? '—'}</span>
    </div>
  )
}

function Section({ title, accent, children, animDelay = 0 }) {
  return (
    <div className="sr-section" style={{
      borderLeftColor: accent || 'rgba(245,168,48,0.4)',
      animationDelay: `${animDelay}ms`
    }}>
      <div className="sr-section-title" style={{ color: accent || '#a09080' }}>{title}</div>
      <div className="sr-section-body">{children}</div>
    </div>
  )
}

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

function DayCallout({ label, day, note, accent }) {
  if (!day) return null
  const entry = day.entry || {}
  return (
    <div className="sr-day-callout" style={{ borderColor: accent + '33' }}>
      <div className="sr-day-callout-badge" style={{ background: accent + '22', color: accent }}>{label}</div>
      <div className="sr-day-callout-date">{fmtDate(day.date)}</div>
      {note && <p className="sr-prose sr-prose-muted" style={{ marginTop: '0.4rem' }}>{note}</p>}
      <div className="sr-day-callout-metrics">
        {['stress','mood','energy'].map(k => entry[k] != null && (
          <span key={k} className="sr-day-metric-chip">
            <span className="sr-day-metric-key">{k.toUpperCase()}</span>
            <span className="sr-day-metric-val" style={{ color: scoreColor(entry[k], k === 'stress') }}>
              {entry[k]}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function Spinner() {
  return <div className="sr-spinner" />
}

// ─── METRIC COMPARISON BAR (monthly: first half vs second half) ───────────────

function CompareBar({ label, first, last, inverted = false }) {
  const pctFirst = first != null ? (first / 10) * 100 : 0
  const pctLast  = last  != null ? (last  / 10) * 100 : 0
  const colorF   = scoreColor(first, inverted)
  const colorL   = scoreColor(last,  inverted)

  const delta    = (first != null && last != null) ? last - first : null
  const improved = delta != null && (inverted ? delta < 0 : delta > 0)
  const worsened = delta != null && (inverted ? delta > 0 : delta < 0)

  return (
    <div className="sr-metric-bar" style={{ marginBottom: '14px' }}>
      <div className="sr-metric-bar-header">
        <span className="sr-metric-label">{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {delta != null && (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '9px',
              color: improved ? '#50a870' : worsened ? '#e05050' : '#a09080',
              letterSpacing: '1px'
            }}>
              {improved ? '▲' : worsened ? '▼' : '—'} {Math.abs(delta).toFixed(1)}
            </span>
          )}
          <span className="sr-metric-value" style={{ color: colorL }}>
            {last != null ? last.toFixed(1) : '—'}
          </span>
        </div>
      </div>
      {/* Two stacked bars: first half (dimmed) + last half (bright) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <div className="sr-metric-track" title={`First half: ${first ?? '—'}`}>
          <div className="sr-metric-fill" style={{ width: `${pctFirst}%`, background: colorF, opacity: 0.35 }} />
        </div>
        <div className="sr-metric-track" title={`Last half: ${last ?? '—'}`}>
          <div className="sr-metric-fill" style={{ width: `${pctLast}%`, background: colorL }} />
        </div>
      </div>
    </div>
  )
}

// ─── WEEKLY TAB ──────────────────────────────────────────────────────────────

function WeeklyTab() {
  const [recap,      setRecap]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState('')
  const [exported,   setExported]   = useState(false)

  const load = async (forceGenerate = false) => {
    if (forceGenerate) { setGenerating(true); setError('') }
    else               { setLoading(true) }

    try {
      const url    = forceGenerate ? `${API}/recap/regenerate` : `${API}/recap/current`
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

  const loadWeekData = async () => {
    try {
      const res  = await fetch(`${API}/recap/week-data`)
      const data = await res.json()
      setRecap(prev => prev ? prev : { status: 'no_data', ...data })
    } catch (_) {}
  }

  useEffect(() => { loadWeekData().then(() => load()) }, [])

  const handleExport = async () => {
    try {
      const res  = await fetch(`${API}/recap/export`)
      if (!res.ok) throw new Error('Export failed')
      const text = await res.text()
      const blob = new Blob([text], { type: 'text/markdown' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `witness-sitrep-${recap?.week_start || 'week'}.md`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExported(true)
    } catch (e) {
      setError('Export failed. Generate the recap first.')
    }
  }

  const hasRecap   = recap?.summary
  const isNoData   = recap?.status === 'no_data' || recap?.status === 'insufficient_data'
  const isCached   = recap?.status === 'cached'
  const entryCount = recap?.entry_count ?? 0
  const ma         = recap?.metric_avgs   || {}
  const ha         = recap?.health_avgs   || {}
  const ws         = recap?.workout_summary || {}

  if (loading && !recap) return (
    <div className="sr-loading"><Spinner /><span>LOADING SITREP...</span></div>
  )

  if (error) return (
    <div className="sr-error">
      <span className="sr-error-label">ERROR</span>
      <span>{error}</span>
      <button className="sr-action-btn" onClick={() => load()}>RETRY</button>
    </div>
  )

  if (isNoData) {
    const needed = Math.max(0, 3 - entryCount)
    return (
      <div className="sr-empty">
        <div className="sr-empty-week">{fmtDateShort(recap?.week_start)} — {fmtDateShort(recap?.week_end)}</div>
        <div className="sr-empty-glyph">◈</div>
        <div className="sr-empty-title">SITREP PENDING</div>
        <div className="sr-empty-sub">
          {entryCount === 0
            ? 'RECORD AT LEAST 3 ENTRIES THIS WEEK TO GENERATE A RECAP.'
            : `${entryCount} ${entryCount === 1 ? 'ENTRY' : 'ENTRIES'} LOGGED. RECORD ${needed} MORE.`}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Header actions */}
      <div className="sr-tab-actions">
        {isCached && <span className="sr-cache-badge">CACHED</span>}
        {hasRecap && (
          <>
            <button className="sr-action-btn" onClick={handleExport}>
              {exported ? 'EXPORTED' : 'EXPORT .MD'}
            </button>
            <button className="sr-action-btn sr-action-btn-accent" onClick={() => load(true)} disabled={generating}>
              {generating ? <><Spinner /> REGENERATING...</> : 'REGENERATE'}
            </button>
          </>
        )}
      </div>

      {/* Metrics */}
      <div className="sr-two-col">
        <Section title="PSYCH METRICS" accent="rgba(245,168,48,0.7)">
          <MetricBar label="MOOD"           value={ma.mood}           />
          <MetricBar label="ENERGY"         value={ma.energy}         />
          <MetricBar label="STRESS"         value={ma.stress}         inverted />
          <MetricBar label="ANXIETY"        value={ma.anxiety}        inverted />
          <MetricBar label="PRODUCTIVITY"   value={ma.productivity}   />
          <MetricBar label="MENTAL CLARITY" value={ma.mental_clarity} />
          <MetricBar label="SOCIAL SAT"     value={ma.social_sat}     />
        </Section>
        <div className="sr-right-col">
          <Section title="BIOMETRICS" accent="rgba(80,200,200,0.7)">
            <div className="sr-health-grid">
              <StatPill label="AVG HRV"    value={ha.hrv        != null ? `${Math.round(ha.hrv)} ms`           : null} color="#50c8c8" />
              <StatPill label="RESTING HR" value={ha.resting_hr != null ? `${Math.round(ha.resting_hr)} bpm`   : null} color="#e05050" />
              <StatPill label="AVG SLEEP"  value={ha.sleep_total_mins ? fmtMins(ha.sleep_total_mins)           : null} color="#9050e0" />
              <StatPill label="DEEP SLEEP" value={ha.sleep_deep_mins  ? fmtMins(ha.sleep_deep_mins)            : null} color="#5090e0" />
              <StatPill label="AVG STEPS"  value={ha.steps     != null ? Math.round(ha.steps).toLocaleString() : null} color="#50a870" />
              <StatPill label="ACTIVE CAL" value={ha.active_calories  != null ? `${Math.round(ha.active_calories)} kcal` : null} color="#c38c32" />
            </div>
          </Section>
          <Section title="WORKOUTS" accent="rgba(80,168,112,0.7)">
            {ws.session_count > 0 ? (
              <div className="sr-workout-summary">
                <div className="sr-workout-big">{ws.session_count}</div>
                <div className="sr-workout-label">SESSIONS</div>
                <div className="sr-workout-detail">
                  {fmtMins(ws.total_mins)} total
                  {ws.types?.length > 0 && (
                    <span className="sr-workout-types">{ws.types.map(t => t.toUpperCase()).join(' · ')}</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="sr-prose sr-prose-muted">No workouts logged this week.</p>
            )}
          </Section>
        </div>
      </div>

      {(recap?.best_day || recap?.worst_day) && (
        <div className="sr-day-row">
          <DayCallout label="BEST DAY"  day={recap.best_day}  note={recap.best_day_note}  accent="#50a870" />
          <DayCallout label="WORST DAY" day={recap.worst_day} note={recap.worst_day_note} accent="#e05050" />
        </div>
      )}

      {!hasRecap && entryCount >= 2 && (
        <div className="sr-generate-prompt">
          <div className="sr-generate-copy">
            <span className="sr-generate-count">{entryCount} {entryCount === 1 ? 'ENTRY' : 'ENTRIES'} THIS WEEK</span>
            <span className="sr-generate-sub">Recap has not been generated yet.</span>
          </div>
          <button className="sr-generate-btn" onClick={() => load(true)} disabled={generating}>
            {generating ? <><Spinner /> GENERATING...</> : 'GENERATE SITREP'}
          </button>
        </div>
      )}

      {hasRecap && (
        <>
          <Section title="SUMMARY" accent="rgba(245,168,48,0.6)" animDelay={180}>
            {recap.summary.split('\n').filter(Boolean).map((p, i) => (
              <p key={i} className="sr-prose">{p}</p>
            ))}
          </Section>

          {recap.patterns?.length > 0 && (
            <Section title="PATTERNS DETECTED" accent="rgba(224,149,32,0.5)" animDelay={220}>
              <ul className="sr-pattern-list">
                {recap.patterns.map((p, i) => (
                  <li key={i} className="sr-pattern-item">
                    <span className="sr-pattern-bullet">◆</span><span>{p}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

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

          {recap.goals_next?.length > 0 && (
            <Section title="NEXT WEEK — FOCUS AREAS" accent="rgba(80,168,112,0.6)" animDelay={300}>
              <GoalList goals={recap.goals_next} accent="#50a870" />
            </Section>
          )}
        </>
      )}
    </>
  )
}

// ─── MONTHLY TAB ─────────────────────────────────────────────────────────────

function MonthlyTab() {
  const [recap,      setRecap]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState('')
  const [exported,   setExported]   = useState(false)

  const load = async (forceGenerate = false) => {
    if (forceGenerate) { setGenerating(true); setError('') }
    else               { setLoading(true) }

    try {
      const url    = forceGenerate
        ? `${API}/recap/monthly/regenerate`
        : `${API}/recap/monthly/current`
      const method = forceGenerate ? 'POST' : 'GET'
      const res    = await fetch(url, { method })
      const data   = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed to load monthly recap')
      setRecap(data)
      setExported(false)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setGenerating(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleExport = async () => {
    try {
      const res  = await fetch(`${API}/recap/monthly/export`)
      if (!res.ok) throw new Error('Export failed')
      const text = await res.text()
      const blob = new Blob([text], { type: 'text/markdown' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `witness-monthly-${recap?.start || 'month'}.md`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setExported(true)
    } catch (e) {
      setError('Export failed. Generate the recap first.')
    }
  }

  if (loading && !recap) return (
    <div className="sr-loading"><Spinner /><span>LOADING MONTHLY RECAP...</span></div>
  )

  if (error) return (
    <div className="sr-error">
      <span className="sr-error-label">ERROR</span>
      <span>{error}</span>
      <button className="sr-action-btn" onClick={() => load()}>RETRY</button>
    </div>
  )

  const isNoData   = recap?.status === 'insufficient_data'
  const isCached   = recap?.status === 'cached'
  const hasRecap   = recap?.summary
  const entryCount = recap?.entry_count ?? 0
  const minEntries = recap?.min_entries ?? 5
  const oa         = recap?.overall_avgs     || {}
  const fa         = recap?.first_half_avgs  || {}
  const la         = recap?.last_half_avgs   || {}
  const ha         = recap?.health_avgs      || {}
  const ws         = recap?.workout_summary  || {}
  const trend      = recap?.trend_direction

  if (isNoData) {
    const needed = Math.max(0, minEntries - entryCount)
    return (
      <div className="sr-empty">
        <div className="sr-empty-week">
          {fmtDateShort(recap?.start)} — {fmtDateShort(recap?.end)}
        </div>
        <div className="sr-empty-glyph">◈</div>
        <div className="sr-empty-title">MONTHLY RECAP PENDING</div>
        <div className="sr-empty-sub">
          {entryCount === 0
            ? `RECORD AT LEAST ${minEntries} ENTRIES IN THE LAST 30 DAYS TO GENERATE THIS.`
            : `${entryCount} ${entryCount === 1 ? 'ENTRY' : 'ENTRIES'} IN 30 DAYS. RECORD ${needed} MORE.`}
        </div>
        <div className="sr-empty-hint">
          Monthly recaps need enough data to detect trends.
          Keep recording and check back once you have {minEntries}+ entries.
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Header actions */}
      <div className="sr-tab-actions">
        {isCached && <span className="sr-cache-badge">CACHED</span>}
        {trend && (
          <span className="sr-trend-badge" style={{ color: TREND_COLORS[trend] || '#a09080' }}>
            {TREND_LABELS[trend] || trend.toUpperCase()}
          </span>
        )}
        {hasRecap && (
          <>
            <button className="sr-action-btn" onClick={handleExport}>
              {exported ? 'EXPORTED' : 'EXPORT .MD'}
            </button>
            <button className="sr-action-btn sr-action-btn-accent" onClick={() => load(true)} disabled={generating}>
              {generating ? <><Spinner /> REGENERATING...</> : 'REGENERATE'}
            </button>
          </>
        )}
      </div>

      {/* Trend comparison metrics */}
      <div className="sr-two-col">
        <Section title="30-DAY TRENDS" accent="rgba(245,168,48,0.7)">
          <div className="sr-compare-legend">
            <span style={{ opacity: 0.4 }}>░░ FIRST 15 DAYS</span>
            <span>▓▓ LAST 15 DAYS</span>
          </div>
          <CompareBar label="MOOD"           first={fa.mood}           last={la.mood}           />
          <CompareBar label="ENERGY"         first={fa.energy}         last={la.energy}         />
          <CompareBar label="STRESS"         first={fa.stress}         last={la.stress}         inverted />
          <CompareBar label="ANXIETY"        first={fa.anxiety}        last={la.anxiety}        inverted />
          <CompareBar label="PRODUCTIVITY"   first={fa.productivity}   last={la.productivity}   />
          <CompareBar label="MENTAL CLARITY" first={fa.mental_clarity} last={la.mental_clarity} />
          <CompareBar label="SOCIAL SAT"     first={fa.social_sat}     last={la.social_sat}     />
        </Section>

        <div className="sr-right-col">
          <Section title="30-DAY BIOMETRICS" accent="rgba(80,200,200,0.7)">
            <div className="sr-health-grid">
              <StatPill label="AVG HRV"    value={ha.hrv        != null ? `${Math.round(ha.hrv)} ms`           : null} color="#50c8c8" />
              <StatPill label="RESTING HR" value={ha.resting_hr != null ? `${Math.round(ha.resting_hr)} bpm`   : null} color="#e05050" />
              <StatPill label="AVG SLEEP"  value={ha.sleep_total_mins ? fmtMins(ha.sleep_total_mins)           : null} color="#9050e0" />
              <StatPill label="AVG STEPS"  value={ha.steps     != null ? Math.round(ha.steps).toLocaleString() : null} color="#50a870" />
            </div>
          </Section>
          <Section title="WORKOUTS" accent="rgba(80,168,112,0.7)">
            {ws.session_count > 0 ? (
              <div className="sr-workout-summary">
                <div className="sr-workout-big">{ws.session_count}</div>
                <div className="sr-workout-label">SESSIONS / 30 DAYS</div>
                <div className="sr-workout-detail">
                  {fmtMins(ws.total_mins)} total
                  {ws.types?.length > 0 && (
                    <span className="sr-workout-types">{ws.types.map(t => t.toUpperCase()).join(' · ')}</span>
                  )}
                </div>
              </div>
            ) : (
              <p className="sr-prose sr-prose-muted">No workouts logged this month.</p>
            )}
          </Section>
        </div>
      </div>

      {(recap?.best_day || recap?.worst_day) && (
        <div className="sr-day-row">
          <DayCallout label="BEST DAY"  day={recap.best_day}  note={null} accent="#50a870" />
          <DayCallout label="WORST DAY" day={recap.worst_day} note={null} accent="#e05050" />
        </div>
      )}

      {/* Generate prompt if no AI content yet */}
      {!hasRecap && entryCount >= minEntries && (
        <div className="sr-generate-prompt">
          <div className="sr-generate-copy">
            <span className="sr-generate-count">{entryCount} ENTRIES IN 30 DAYS</span>
            <span className="sr-generate-sub">Monthly recap has not been generated yet.</span>
          </div>
          <button className="sr-generate-btn" onClick={() => load(true)} disabled={generating}>
            {generating ? <><Spinner /> GENERATING...</> : 'GENERATE MONTHLY RECAP'}
          </button>
        </div>
      )}

      {/* AI content */}
      {hasRecap && (
        <>
          <Section title="30-DAY SUMMARY" accent="rgba(245,168,48,0.6)" animDelay={180}>
            {recap.summary.split('\n').filter(Boolean).map((p, i) => (
              <p key={i} className="sr-prose">{p}</p>
            ))}
          </Section>

          {recap.biggest_shift && (
            <Section title="BIGGEST SHIFT" accent="rgba(224,149,32,0.6)" animDelay={210}>
              <p className="sr-prose">{recap.biggest_shift}</p>
            </Section>
          )}

          {recap.recurring_themes?.length > 0 && (
            <Section title="RECURRING THEMES" accent="rgba(200,168,80,0.5)" animDelay={240}>
              <ul className="sr-pattern-list">
                {recap.recurring_themes.map((t, i) => (
                  <li key={i} className="sr-pattern-item">
                    <span className="sr-pattern-bullet">◆</span><span>{t}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {recap.honest_observation && (
            <Section title="HONEST OBSERVATION" accent="rgba(224,80,80,0.5)" animDelay={270}>
              <p className="sr-prose">{recap.honest_observation}</p>
            </Section>
          )}

          {recap.watch_next_month && (
            <Section title="WATCH NEXT MONTH" accent="rgba(160,144,128,0.5)" animDelay={300}>
              <p className="sr-prose">{recap.watch_next_month}</p>
            </Section>
          )}

          {recap.goals_next?.length > 0 && (
            <Section title="NEXT MONTH — FOCUS AREAS" accent="rgba(80,168,112,0.6)" animDelay={330}>
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
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function WeeklyRecap() {
  const [tab, setTab] = useState('weekly')

  return (
    <div className="sr-screen">

      {/* Header */}
      <div className="sr-header">
        <div className="sr-header-left">
          <h1 className="page-title">SITREP</h1>
          <span className="page-subtitle">
            {tab === 'weekly' ? 'WEEKLY RECAP' : '30-DAY RECAP'}
          </span>
        </div>
        <div className="sr-header-right">
          {/* Tab toggle */}
          <div className="sr-tab-toggle">
            <button
              className={`sr-tab-btn ${tab === 'weekly' ? 'active' : ''}`}
              onClick={() => setTab('weekly')}
            >
              WEEKLY
            </button>
            <button
              className={`sr-tab-btn ${tab === 'monthly' ? 'active' : ''}`}
              onClick={() => setTab('monthly')}
            >
              MONTHLY
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="sr-content">
        {tab === 'weekly'  ? <WeeklyTab  /> : <MonthlyTab />}
      </div>

    </div>
  )
}
