/**
 * WITNESS — Debrief (Step 12)
 * INSIGHTS & FLAGS screen: behavioral patterns, metric trends, AI flags.
 *
 * Save this file at: witness/src/Debrief.jsx
 *
 * Fixes vs the draft from the other Claude instance:
 *   - fmtDate: YYYY-MM-DD strings now get T12:00:00 appended before parsing
 *     so they don't shift one day back in US timezones (UTC midnight bug)
 *   - Sparkline: null metric values are skipped rather than collapsed to 0,
 *     which was distorting the chart on days with no data
 *   - resolveFlag / dismissFlag now have try/catch so a failed request
 *     doesn't silently remove the card from the UI
 *   - TrendChart "latest" value now finds the most recent non-null point
 *     instead of always using the last array index (which may be null)
 */

import { useState, useEffect, useCallback } from 'react'

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  // YYYY-MM-DD strings must get a noon time appended so they parse as local
  // time, not UTC midnight (which shifts the date back one day in US zones)
  const s = iso.length === 10 ? iso + 'T12:00:00' : iso
  return new Date(s).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  }).toUpperCase()
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
// Mini inline trend line. Null values are skipped — the line connects only
// real data points, preserving their x-position in the overall timeline.
// The original draft used (d ?? 0) which collapsed nulls to 0 and dragged
// the line to the floor on sparse data.

function Sparkline({ data, color = '#c38c32', height = 32 }) {
  if (!data || data.length < 2) return <span className="db-spark-empty">—</span>

  const w   = 120
  const pad = 2

  // Keep index position so x-axis reflects actual date spacing
  const points = data
    .map((v, i) => (v != null ? { i, v } : null))
    .filter(Boolean)

  if (points.length < 2) return <span className="db-spark-empty">—</span>

  const vals  = points.map(p => p.v)
  const min   = Math.min(...vals)
  const max   = Math.max(...vals)
  const range = max - min || 1
  const total = data.length - 1

  const svgPoints = points.map(({ i, v }) => {
    const x = pad + (i / total) * (w - pad * 2)
    const y = height - pad - ((v - min) / range) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  return (
    <svg width={w} height={height} className="db-sparkline">
      <polyline
        points={svgPoints}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ─── SCORE GAUGE ─────────────────────────────────────────────────────────────

function ScoreGauge({ label, value, color }) {
  if (value == null) return (
    <div className="db-gauge">
      <div className="db-gauge-label">{label}</div>
      <div className="db-gauge-val">—</div>
      <div className="db-gauge-bar-wrap">
        <div className="db-gauge-bar-fill" style={{ width: 0 }} />
      </div>
    </div>
  )
  const pct = clamp((value / 10) * 100, 0, 100)
  return (
    <div className="db-gauge">
      <div className="db-gauge-label">{label}</div>
      <div className="db-gauge-val" style={{ color }}>{Math.round(value * 10) / 10}</div>
      <div className="db-gauge-bar-wrap">
        <div className="db-gauge-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

// ─── FLAG CARD ────────────────────────────────────────────────────────────────

function FlagCard({ flag, onDismiss, onResolve, muted = false }) {
  const SEVERITY_COLOR = { low: '#a0a060', medium: '#c38c32', high: '#e05050' }
  const color = SEVERITY_COLOR[flag.severity] || '#c38c32'

  let evidence = []
  try { evidence = JSON.parse(flag.evidence || '[]') } catch {}

  return (
    <div
      className={`db-flag-card ${muted ? 'db-flag-card-muted' : ''}`}
      style={{ borderLeftColor: muted ? 'rgba(160,144,128,0.25)' : color }}
    >
      <div className="db-flag-header">
        <div className="db-flag-header-left">
          <span className="db-flag-severity" style={{ color: muted ? 'rgba(160,144,128,0.5)' : color }}>
            {flag.severity.toUpperCase()}
          </span>
          <span className="db-flag-category">{flag.category.toUpperCase()}</span>
          <span className="db-flag-title">{flag.title}</span>
        </div>
        {!muted && (
          <div className="db-flag-actions">
            <button className="db-flag-btn" onClick={() => onResolve(flag.id)}>
              RESOLVE
            </button>
            <button className="db-flag-btn db-flag-btn-dim" onClick={() => onDismiss(flag.id)}>
              DISMISS
            </button>
          </div>
        )}
        {muted && (
          <div className="db-flag-dismissed-label">DISMISSED</div>
        )}
      </div>
      <div className="db-flag-desc">{flag.description}</div>
      {evidence.length > 0 && (
        <div className="db-flag-evidence">
          CITED: {evidence.map(d => fmtDate(d)).join(' · ')}
        </div>
      )}
    </div>
  )
}

// ─── TREND CHART ─────────────────────────────────────────────────────────────

function TrendChart({ trends }) {
  if (!trends || trends.length < 2) return (
    <div className="db-trend-empty">
      Not enough data yet. Need at least 2 entries with metrics to draw trends.
    </div>
  )

  const METRICS = [
    { key: 'mood',           label: 'MOOD',    color: '#c38c32' },
    { key: 'stress',         label: 'STRESS',  color: '#e05050' },
    { key: 'energy',         label: 'ENERGY',  color: '#50c878' },
    { key: 'anxiety',        label: 'ANXIETY', color: '#e08050' },
    { key: 'mental_clarity', label: 'CLARITY', color: '#5090e0' },
  ]

  return (
    <div className="db-trend-grid">
      {METRICS.map(m => {
        // Find the most recent non-null value for the right-hand readout
        const latestPoint = [...trends].reverse().find(t => t[m.key] != null)
        const latestVal   = latestPoint ? latestPoint[m.key] : null

        return (
          <div key={m.key} className="db-trend-row">
            <div className="db-trend-row-label" style={{ color: m.color }}>{m.label}</div>
            <Sparkline data={trends.map(t => t[m.key])} color={m.color} height={36} />
            <div className="db-trend-row-latest">
              {latestVal != null ? Math.round(latestVal * 10) / 10 : '—'}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function Debrief() {
  const [flags,          setFlags]          = useState([])
  const [dismissedFlags, setDismissedFlags] = useState([])
  const [showDismissed,  setShowDismissed]  = useState(false)
  const [loadingDismissed, setLoadingDismissed] = useState(false)
  const [trends,         setTrends]         = useState([])
  const [avgMetrics,     setAvgMetrics]     = useState(null)
  const [loading,        setLoading]        = useState(true)
  const [running,        setRunning]        = useState(false)
  const [runMsg,         setRunMsg]         = useState('')
  const [days,           setDays]           = useState(30)
  const [tab,            setTab]            = useState('flags') // 'flags' | 'trends'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [flagsRes, trendsRes] = await Promise.all([
        fetch(`${API}/insights/flags`),
        fetch(`${API}/insights/trends?days=${days}`)
      ])

      const flagsData  = flagsRes.ok  ? await flagsRes.json()  : []
      const trendsData = trendsRes.ok ? await trendsRes.json() : []

      setFlags(flagsData)
      setTrends(trendsData)

      // Average each metric — filter nulls so missing days don't drag values down
      if (trendsData.length > 0) {
        const avg = (key) => {
          const vals = trendsData.map(t => t[key]).filter(v => v != null)
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
        }
        setAvgMetrics({
          mood:           avg('mood'),
          stress:         avg('stress'),
          energy:         avg('energy'),
          anxiety:        avg('anxiety'),
          mental_clarity: avg('mental_clarity'),
          productivity:   avg('productivity'),
          social_sat:     avg('social_sat'),
        })
      } else {
        setAvgMetrics(null)
      }
    } catch (e) {
      console.error('Debrief load error:', e)
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  const runAnalysis = async () => {
    setRunning(true)
    setRunMsg('Running AI analysis — this takes 30-60 seconds...')
    try {
      const res  = await fetch(`${API}/insights/run-flags?days=${days}`, { method: 'POST' })
      const data = await res.json()
      if (data.status === 'insufficient_data') {
        setRunMsg(data.message)
      } else if (data.status === 'ok') {
        setRunMsg(`Analysis complete. ${data.flags_generated} flag${data.flags_generated !== 1 ? 's' : ''} generated.`)
        await load()
      } else {
        setRunMsg('Analysis failed. Check the backend logs.')
      }
    } catch {
      setRunMsg('Could not reach backend.')
    } finally {
      setRunning(false)
      setTimeout(() => setRunMsg(''), 6000)
    }
  }

  const dismissFlag = async (id) => {
    try {
      const res = await fetch(`${API}/insights/flags/${id}/dismiss`, { method: 'POST' })
      if (res.ok) setFlags(prev => prev.filter(f => f.id !== id))
    } catch {
      // Flag stays visible if the request failed
    }
  }

  const resolveFlag = async (id) => {
    try {
      const res = await fetch(`${API}/insights/flags/${id}/resolve`, { method: 'POST' })
      if (res.ok) setFlags(prev => prev.filter(f => f.id !== id))
    } catch {}
  }

  const toggleShowDismissed = async () => {
    if (showDismissed) {
      // Closing — just hide
      setShowDismissed(false)
      return
    }
    // Opening — fetch dismissed flags from backend
    setShowDismissed(true)
    setLoadingDismissed(true)
    try {
      const res = await fetch(`${API}/insights/flags?dismissed=true`)
      if (res.ok) {
        const data = await res.json()
        setDismissedFlags(data)
      }
    } catch {
      setDismissedFlags([])
    } finally {
      setLoadingDismissed(false)
    }
  }

  const DAYS_OPTIONS = [7, 14, 30, 60, 90]

  return (
    <div className="db-screen">

      {/* Header */}
      <div className="db-header">
        <div className="db-header-left">
          <h1 className="page-title">DEBRIEF</h1>
          <span className="page-subtitle">INSIGHTS & BEHAVIORAL FLAGS</span>
        </div>
        <div className="db-header-right">
          <div className="db-days-selector">
            {DAYS_OPTIONS.map(d => (
              <button
                key={d}
                className={`db-days-btn ${days === d ? 'active' : ''}`}
                onClick={() => setDays(d)}
              >
                {d}D
              </button>
            ))}
          </div>
          <button
            className={`db-run-btn ${running ? 'running' : ''}`}
            onClick={runAnalysis}
            disabled={running}
          >
            {running ? 'ANALYZING...' : 'RUN ANALYSIS'}
          </button>
        </div>
      </div>

      {runMsg && <div className="db-run-msg">{runMsg}</div>}

      {/* Average metric gauges — only rendered when there is trend data */}
      {avgMetrics && (
        <div className="db-gauges-row">
          <ScoreGauge label="MOOD"       value={avgMetrics.mood}           color="#c38c32" />
          <ScoreGauge label="STRESS"     value={avgMetrics.stress}         color="#e05050" />
          <ScoreGauge label="ENERGY"     value={avgMetrics.energy}         color="#50c878" />
          <ScoreGauge label="ANXIETY"    value={avgMetrics.anxiety}        color="#e08050" />
          <ScoreGauge label="CLARITY"    value={avgMetrics.mental_clarity} color="#5090e0" />
          <ScoreGauge label="SOCIAL"     value={avgMetrics.social_sat}     color="#9050e0" />
          <ScoreGauge label="PRODUCTIVE" value={avgMetrics.productivity}   color="#50c0c0" />
        </div>
      )}

      {/* Tab switcher */}
      <div className="db-tabs">
        <button
          className={`db-tab ${tab === 'flags' ? 'active' : ''}`}
          onClick={() => setTab('flags')}
        >
          FLAGS
          {flags.length > 0 && <span className="db-tab-count">{flags.length}</span>}
        </button>
        <button
          className={`db-tab ${tab === 'trends' ? 'active' : ''}`}
          onClick={() => setTab('trends')}
        >
          TRENDS
        </button>
      </div>

      {/* Content */}
      <div className="db-content">
        {loading ? (
          <div className="db-state-msg">
            <div className="db-spinner" /> LOADING...
          </div>
        ) : tab === 'flags' ? (
          <div className="db-flags-list">
            {flags.length === 0 ? (
              <div className="db-empty">
                <div className="db-empty-title">NO ACTIVE FLAGS</div>
                <div className="db-empty-sub">
                  Run analysis after recording 5 or more entries to surface behavioral
                  patterns. Flags appear when the AI detects consistent patterns across
                  multiple days, not one-off events.
                </div>
              </div>
            ) : (
              flags.map(flag => (
                <FlagCard
                  key={flag.id}
                  flag={flag}
                  onDismiss={dismissFlag}
                  onResolve={resolveFlag}
                />
              ))
            )}

            {/* ── SHOW DISMISSED toggle ── */}
            <div className="db-dismissed-toggle-row">
              <button
                className={`db-dismissed-toggle ${showDismissed ? 'active' : ''}`}
                onClick={toggleShowDismissed}
              >
                {showDismissed ? 'HIDE DISMISSED' : 'SHOW DISMISSED'}
                {showDismissed && dismissedFlags.length > 0 && (
                  <span className="db-dismissed-count">{dismissedFlags.length}</span>
                )}
              </button>
            </div>

            {/* ── Dismissed flags archive ── */}
            {showDismissed && (
              <div className="db-dismissed-section">
                <div className="db-dismissed-header">DISMISSED FLAGS</div>
                {loadingDismissed ? (
                  <div className="db-state-msg" style={{ padding: '16px 0' }}>
                    <div className="db-spinner" /> LOADING...
                  </div>
                ) : dismissedFlags.length === 0 ? (
                  <div className="db-dismissed-empty">
                    No dismissed flags on record.
                  </div>
                ) : (
                  dismissedFlags.map(flag => (
                    <FlagCard
                      key={flag.id}
                      flag={flag}
                      onDismiss={null}
                      onResolve={null}
                      muted
                    />
                  ))
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="db-trends-panel">
            <div className="db-trends-header">
              <span className="db-trends-label">METRIC TRENDS — LAST {days} DAYS</span>
              <span className="db-trends-sub">
                {trends.length} data point{trends.length !== 1 ? 's' : ''}
              </span>
            </div>
            <TrendChart trends={trends} />
          </div>
        )}
      </div>

    </div>
  )
}
