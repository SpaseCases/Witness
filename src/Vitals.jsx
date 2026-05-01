/**
 * WITNESS — Vitals (Step 13 — revised)
 * Changes from original:
 *   1. Crosshair hover on all charts — vertical line, riding dot, floating tooltip
 *   2. Delete panel — date-range wipe + nuclear full-clear option
 *   3. Auto-upload status indicator (backend watches a folder + exposes POST endpoint)
 *
 * Save this file at: witness/src/Vitals.jsx
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  const s = iso.length === 10 ? iso + 'T12:00:00' : iso
  return new Date(s).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric'
  }).toUpperCase()
}

function fmtDateFull(iso) {
  if (!iso) return '—'
  const s = iso.length === 10 ? iso + 'T12:00:00' : iso
  return new Date(s).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  }).toUpperCase()
}

function fmtMins(mins) {
  if (mins == null || mins === 0) return '—'
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function avg(arr) {
  const vals = arr.filter(v => v != null)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

// ─── CROSSHAIR TOOLTIP ───────────────────────────────────────────────────────
// Shared floating tooltip. Renders above the hovered x position.

function CrosshairTooltip({ x, y, lines, visible }) {
  if (!visible) return null
  return (
    <div
      className="vt-crosshair-tooltip"
      style={{ left: x, top: y }}
    >
      {lines.map((line, i) => (
        <div key={i} className="vt-crosshair-line">
          {line.dot && (
            <span
              className="vt-crosshair-dot"
              style={{ background: line.color }}
            />
          )}
          <span className="vt-crosshair-label">{line.label}</span>
          <span className="vt-crosshair-value" style={{ color: line.color }}>
            {line.value}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── SPARKLINE WITH CROSSHAIR ─────────────────────────────────────────────────

function Sparkline({ data, dates, color = '#c38c32', height = 48, label = '', unit = '' }) {
  const containerRef = useRef(null)
  const svgRef       = useRef(null)
  const [svgW, setSvgW]         = useState(200)
  const [hoverIdx, setHoverIdx] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!svgRef.current) return
    const ro = new ResizeObserver(e => setSvgW(e[0].contentRect.width))
    ro.observe(svgRef.current)
    return () => ro.disconnect()
  }, [])

  if (!data || data.length < 2) return <span className="vt-spark-empty">NO DATA</span>

  const points = data.map((v, i) => (v != null ? { i, v } : null)).filter(Boolean)
  if (points.length < 2) return <span className="vt-spark-empty">NO DATA</span>

  const vals  = points.map(p => p.v)
  const min   = Math.min(...vals)
  const max   = Math.max(...vals)
  const range = max - min || 1
  const total = data.length - 1
  const pad   = 4

  const toCoord = ({ i, v }) => {
    const x = pad + (i / total) * (svgW - pad * 2)
    const y = height - pad - ((v - min) / range) * (height - pad * 2)
    return { x, y }
  }

  const coords   = points.map(toCoord)
  const polyline = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')

  // Find nearest data point to mouse x
  const handleMouseMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const mouseX = e.clientX - rect.left
    // map mouseX → data index
    const rawIdx = ((mouseX - pad) / (svgW - pad * 2)) * total
    const nearest = points.reduce((best, p) => {
      return Math.abs(p.i - rawIdx) < Math.abs(best.i - rawIdx) ? p : best
    }, points[0])
    setHoverIdx(nearest.i)
    const coord = toCoord(nearest)
    // tooltip offset relative to container
    const containerRect = containerRef.current?.getBoundingClientRect()
    setTooltipPos({
      x: rect.left - containerRect.left + coord.x,
      y: rect.top  - containerRect.top  + coord.y - 8
    })
  }

  const hoverPoint = hoverIdx !== null ? points.find(p => p.i === hoverIdx) : null
  const hoverCoord = hoverPoint ? toCoord(hoverPoint) : null

  return (
    <div
      ref={containerRef}
      className="vt-sparkline-wrap"
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        className="vt-sparkline"
        preserveAspectRatio="none"
        onMouseMove={handleMouseMove}
        style={{ cursor: 'crosshair' }}
      >
        <polyline
          points={polyline}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={hoverIdx !== null ? 0.5 : 1}
        />

        {/* Vertical crosshair */}
        {hoverCoord && (
          <line
            x1={hoverCoord.x.toFixed(1)} y1={pad}
            x2={hoverCoord.x.toFixed(1)} y2={height - pad}
            stroke={color}
            strokeWidth="1"
            strokeOpacity="0.35"
            strokeDasharray="3 2"
          />
        )}

        {/* Riding dot — all points dim, hovered one bright */}
        {points.map(p => {
          const c = toCoord(p)
          const isHovered = p.i === hoverIdx
          return (
            <circle
              key={p.i}
              cx={c.x.toFixed(1)}
              cy={c.y.toFixed(1)}
              r={isHovered ? 4 : 2.5}
              fill={color}
              opacity={hoverIdx === null ? (p.i === points[points.length - 1].i ? 1 : 0) : (isHovered ? 1 : 0.2)}
              style={{ transition: 'r 0.1s, opacity 0.1s' }}
            />
          )
        })}
      </svg>

      <CrosshairTooltip
        x={tooltipPos.x}
        y={tooltipPos.y}
        visible={hoverCoord !== null}
        lines={[
          { label: dates?.[hoverIdx] ? fmtDateFull(dates[hoverIdx]) : '', value: '', color: 'rgba(255,255,255,0.3)', dot: false },
          { label: label, value: hoverPoint ? `${hoverPoint.v.toFixed(1)}${unit}` : '—', color, dot: true },
        ]}
      />
    </div>
  )
}

// ─── SLEEP BARS WITH CROSSHAIR ────────────────────────────────────────────────

function SleepBars({ data }) {
  const containerRef = useRef(null)
  const [hoverIdx, setHoverIdx] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  if (!data || data.length === 0) return <span className="vt-spark-empty">NO DATA</span>

  const maxMins = Math.max(...data.map(d =>
    (d.sleep_deep_mins || 0) + (d.sleep_rem_mins || 0) + (d.sleep_light_mins || 0)
  ), 1)

  const barW = 100 / data.length
  const h    = 48

  const handleMouseMove = (e) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const pct = (e.clientX - rect.left) / rect.width
    const idx = Math.min(data.length - 1, Math.max(0, Math.floor(pct * data.length)))
    setHoverIdx(idx)
    setTooltipPos({
      x: rect.width * ((idx + 0.5) / data.length),
      y: 0
    })
  }

  const hd = hoverIdx !== null ? data[hoverIdx] : null

  return (
    <div
      ref={containerRef}
      className="vt-sparkline-wrap"
      style={{ cursor: 'crosshair' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg width="100%" height={h} className="vt-sleep-bars">
        {data.map((d, i) => {
          const deep  = d.sleep_deep_mins  || 0
          const rem   = d.sleep_rem_mins   || 0
          const light = d.sleep_light_mins || 0
          const total = deep + rem + light
          if (total === 0) return null

          const scale = (mins) => (mins / maxMins) * (h - 4)
          const x     = i * barW + 0.25
          const w     = barW - 0.5
          const isHovered = i === hoverIdx

          let y = h - 2
          return [
            { mins: deep,  color: '#5090e0' },
            { mins: rem,   color: '#9050e0' },
            { mins: light, color: '#506080' },
          ].map(({ mins, color }, si) => {
            const sh = scale(mins)
            y -= sh
            return (
              <rect
                key={`${i}-${si}`}
                x={`${x}%`} y={y}
                width={`${w}%`} height={sh}
                fill={color}
                opacity={hoverIdx === null ? 0.85 : isHovered ? 1 : 0.3}
                style={{ transition: 'opacity 0.1s' }}
              />
            )
          })
        })}

        {/* Vertical crosshair line */}
        {hoverIdx !== null && (
          <line
            x1={`${(hoverIdx + 0.5) * barW}%`} y1={0}
            x2={`${(hoverIdx + 0.5) * barW}%`} y2={h}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth="1"
            strokeDasharray="3 2"
          />
        )}
      </svg>

      {hd && (
        <CrosshairTooltip
          x={tooltipPos.x}
          y={tooltipPos.y}
          visible={true}
          lines={[
            { label: fmtDateFull(hd.date), value: '', color: 'rgba(255,255,255,0.3)', dot: false },
            { label: 'DEEP',  value: fmtMins(hd.sleep_deep_mins),  color: '#5090e0', dot: true },
            { label: 'REM',   value: fmtMins(hd.sleep_rem_mins),   color: '#9050e0', dot: true },
            { label: 'LIGHT', value: fmtMins(hd.sleep_light_mins), color: '#506080', dot: true },
            { label: 'TOTAL', value: fmtMins(hd.sleep_total_mins), color: 'rgba(255,255,255,0.5)', dot: false },
          ]}
        />
      )}
    </div>
  )
}

// ─── DUAL-AXIS OVERLAY WITH CROSSHAIR ────────────────────────────────────────

function OverlayChart({ data }) {
  const containerRef = useRef(null)
  const svgRef       = useRef(null)
  const [svgW, setSvgW]         = useState(400)
  const [hoverIdx, setHoverIdx] = useState(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })

  const height = 100
  const pad    = { t: 8, r: 8, b: 20, l: 8 }

  useEffect(() => {
    if (!svgRef.current) return
    const ro = new ResizeObserver(e => setSvgW(e[0].contentRect.width))
    ro.observe(svgRef.current)
    return () => ro.disconnect()
  }, [])

  const filtered = data.filter(d => d.hrv != null && d.stress != null)
  if (filtered.length < 2) return (
    <div className="vt-overlay-empty">
      Need journal metrics AND health data on the same dates to draw this overlay.
      Record more entries after importing health data.
    </div>
  )

  const total  = filtered.length - 1
  const innerW = svgW - pad.l - pad.r
  const innerH = height - pad.t - pad.b

  const hrvals = filtered.map(d => d.hrv)
  const stvals = filtered.map(d => d.stress)
  const hrMin = Math.min(...hrvals), hrMax = Math.max(...hrvals)
  const stMin = Math.min(...stvals), stMax = Math.max(...stvals)
  const hrR   = hrMax - hrMin || 1
  const stR   = stMax - stMin || 1

  const getHrvCoord = (d, i) => ({
    x: pad.l + (i / total) * innerW,
    y: pad.t + innerH - ((d.hrv - hrMin) / hrR) * innerH
  })
  const getStCoord = (d, i) => ({
    x: pad.l + (i / total) * innerW,
    y: pad.t + innerH - ((d.stress - stMin) / stR) * innerH
  })

  const hrPts = filtered.map((d, i) => {
    const c = getHrvCoord(d, i)
    return `${c.x.toFixed(1)},${c.y.toFixed(1)}`
  }).join(' ')

  const stPts = filtered.map((d, i) => {
    const c = getStCoord(d, i)
    return `${c.x.toFixed(1)},${c.y.toFixed(1)}`
  }).join(' ')

  const labelIdxs = [0, Math.floor(total/4), Math.floor(total/2), Math.floor(3*total/4), total]
    .filter((v, i, a) => a.indexOf(v) === i && v <= total)

  const handleMouseMove = (e) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const mouseX = e.clientX - rect.left
    const rawIdx = ((mouseX - pad.l) / innerW) * total
    const idx = Math.min(total, Math.max(0, Math.round(rawIdx)))
    setHoverIdx(idx)
    const c = getHrvCoord(filtered[idx], idx)
    const containerRect = containerRef.current?.getBoundingClientRect()
    setTooltipPos({
      x: rect.left - containerRect.left + c.x,
      y: rect.top  - containerRect.top  + pad.t
    })
  }

  const hd = hoverIdx !== null ? filtered[hoverIdx] : null
  const hoverHrvC = hd ? getHrvCoord(hd, hoverIdx) : null
  const hoverStC  = hd ? getStCoord(hd, hoverIdx)  : null

  return (
    <div
      ref={containerRef}
      className="vt-sparkline-wrap"
      onMouseLeave={() => setHoverIdx(null)}
    >
      <svg
        ref={svgRef}
        width="100%"
        height={height + 4}
        className="vt-overlay-svg"
        onMouseMove={handleMouseMove}
        style={{ cursor: 'crosshair' }}
      >
        <polyline points={hrPts} fill="none" stroke="#50c8c8" strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round"
          opacity={hoverIdx !== null ? 0.4 : 1}
        />
        <polyline points={stPts} fill="none" stroke="#e05050" strokeWidth="1.5"
          strokeLinejoin="round" strokeLinecap="round" strokeDasharray="4 2"
          opacity={hoverIdx !== null ? 0.4 : 1}
        />

        {/* Vertical crosshair */}
        {hoverHrvC && (
          <line
            x1={hoverHrvC.x.toFixed(1)} y1={pad.t}
            x2={hoverHrvC.x.toFixed(1)} y2={height - pad.b}
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="1"
            strokeDasharray="3 2"
          />
        )}

        {/* HRV dot */}
        {hoverHrvC && (
          <circle cx={hoverHrvC.x.toFixed(1)} cy={hoverHrvC.y.toFixed(1)}
            r="4" fill="#50c8c8" />
        )}
        {/* Stress dot */}
        {hoverStC && (
          <circle cx={hoverStC.x.toFixed(1)} cy={hoverStC.y.toFixed(1)}
            r="4" fill="#e05050" />
        )}

        {labelIdxs.map(idx => {
          const x = pad.l + (idx / total) * innerW
          return (
            <text key={idx} x={x.toFixed(1)} y={height + 2} textAnchor="middle"
              fontSize="7" fill="rgba(255,255,255,0.2)" fontFamily="IBM Plex Mono">
              {fmtDate(filtered[idx].date)}
            </text>
          )
        })}
      </svg>

      {hd && (
        <CrosshairTooltip
          x={tooltipPos.x}
          y={tooltipPos.y}
          visible={true}
          lines={[
            { label: fmtDateFull(hd.date), value: '', color: 'rgba(255,255,255,0.3)', dot: false },
            { label: 'HRV',    value: `${hd.hrv.toFixed(1)} ms`,    color: '#50c8c8', dot: true },
            { label: 'STRESS', value: `${hd.stress.toFixed(1)} / 10`, color: '#e05050', dot: true },
          ]}
        />
      )}
    </div>
  )
}

// ─── CHART BLOCK ─────────────────────────────────────────────────────────────

function ChartBlock({ title, children, hint }) {
  return (
    <div className="vt-chart-block">
      <div className="vt-chart-header">
        <span className="vt-chart-title">{title}</span>
        {hint && <span className="vt-chart-hint">{hint}</span>}
      </div>
      <div className="vt-chart-body">{children}</div>
    </div>
  )
}

// ─── STAT CARD ────────────────────────────────────────────────────────────────

function StatCard({ label, value, unit, sub, color = '#c38c32' }) {
  return (
    <div className="vt-stat-card">
      <div className="vt-stat-label">{label}</div>
      <div className="vt-stat-value" style={{ color }}>
        {value ?? '—'}{value != null && unit ? <span className="vt-stat-unit">{unit}</span> : null}
      </div>
      {sub && <div className="vt-stat-sub">{sub}</div>}
    </div>
  )
}

// ─── IMPORT PANEL ─────────────────────────────────────────────────────────────

function ImportPanel({ onImported }) {
  const [dragging,  setDragging]  = useState(false)
  const [importing, setImporting] = useState(false)
  const [result,    setResult]    = useState(null)
  const [error,     setError]     = useState('')
  const inputRef = useRef(null)

  const doImport = async (file) => {
    if (!file || !file.name.endsWith('.xml')) {
      setError('Please select a .xml file exported from Apple Health.')
      return
    }
    setImporting(true)
    setError('')
    setResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res  = await fetch(`${API}/health/import`, { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Import failed')
      setResult(data)
      onImported()
    } catch (e) {
      setError(`Import failed: ${e.message}`)
    } finally {
      setImporting(false)
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) doImport(file)
  }

  return (
    <div
      className={`vt-import-zone ${dragging ? 'vt-import-zone-drag' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xml"
        style={{ display: 'none' }}
        onChange={e => { if (e.target.files[0]) doImport(e.target.files[0]) }}
      />

      {importing ? (
        <div className="vt-import-loading">
          <div className="vt-spinner" />
          <span>PARSING APPLE HEALTH XML — THIS MAY TAKE A MOMENT FOR LARGE FILES...</span>
        </div>
      ) : result ? (
        <div className="vt-import-success">
          <span className="vt-import-check">✓</span>
          <div className="vt-import-result-text">
            <span className="vt-import-result-main">
              {result.imported + (result.updated || 0)} DAYS IMPORTED
            </span>
            {result.date_from && result.date_to && (
              <span className="vt-import-result-sub">
                {fmtDate(result.date_from)} — {fmtDate(result.date_to)}
              </span>
            )}
          </div>
          <button className="vt-btn-ghost" onClick={() => { setResult(null); inputRef.current?.click() }}>
            IMPORT AGAIN
          </button>
        </div>
      ) : (
        <>
          <div className="vt-import-icon">⬡</div>
          <div className="vt-import-title">APPLE HEALTH EXPORT</div>
          <div className="vt-import-desc">DRAG A .XML FILE HERE OR CLICK TO BROWSE</div>
          <div className="vt-import-sub">
            On your iPhone: Health → your profile → Export All Health Data → share to your PC
          </div>
          <button className="vt-btn-primary" onClick={() => inputRef.current?.click()}>
            SELECT FILE
          </button>
          {error && <div className="vt-import-error">{error}</div>}
        </>
      )}
    </div>
  )
}

// ─── DELETE PANEL ─────────────────────────────────────────────────────────────

function DeletePanel({ summary, onDeleted }) {
  const [mode,      setMode]      = useState(null)   // 'range' | 'all'
  const [dateFrom,  setDateFrom]  = useState('')
  const [dateTo,    setDateTo]    = useState('')
  const [confirming, setConfirming] = useState(false)
  const [working,   setWorking]   = useState(false)
  const [result,    setResult]    = useState(null)
  const [error,     setError]     = useState('')

  const doDelete = async () => {
    setWorking(true)
    setError('')
    try {
      let url
      if (mode === 'all') {
        url = `${API}/health/delete-all`
      } else {
        if (!dateFrom || !dateTo) { setError('Select both dates.'); setWorking(false); return }
        url = `${API}/health/delete-range?date_from=${dateFrom}&date_to=${dateTo}`
      }
      const res  = await fetch(url, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Delete failed')
      setResult(data)
      setConfirming(false)
      onDeleted()
    } catch (e) {
      setError(e.message)
    } finally {
      setWorking(false)
    }
  }

  if (result) {
    return (
      <div className="vt-delete-panel">
        <div className="vt-delete-result">
          <span className="vt-delete-result-icon">✓</span>
          <span className="vt-delete-result-text">
            {result.deleted} {result.deleted === 1 ? 'DAY' : 'DAYS'} DELETED
          </span>
          <button className="vt-btn-ghost" onClick={() => { setResult(null); setMode(null) }}>
            DONE
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="vt-delete-panel">
      <div className="vt-delete-header">
        <span className="vt-chart-title">DELETE HEALTH DATA</span>
        <span className="vt-chart-hint">
          {summary?.count ? `${summary.count} DAYS ON RECORD` : ''}
        </span>
      </div>

      {!mode && (
        <div className="vt-delete-options">
          <button className="vt-delete-opt" onClick={() => setMode('range')}>
            <span className="vt-delete-opt-label">DELETE DATE RANGE</span>
            <span className="vt-delete-opt-sub">Remove specific days from storage</span>
          </button>
          <button className="vt-delete-opt vt-delete-opt-danger" onClick={() => { setMode('all'); setConfirming(true) }}>
            <span className="vt-delete-opt-label">WIPE ALL DATA</span>
            <span className="vt-delete-opt-sub">Permanently removes all health records</span>
          </button>
        </div>
      )}

      {mode === 'range' && !confirming && (
        <div className="vt-delete-range">
          <div className="vt-delete-range-inputs">
            <div className="vt-date-field">
              <label className="vt-date-label">FROM</label>
              <input
                type="date"
                className="vt-date-input"
                value={dateFrom}
                min={summary?.date_from || ''}
                max={summary?.date_to   || ''}
                onChange={e => setDateFrom(e.target.value)}
              />
            </div>
            <div className="vt-delete-range-sep">→</div>
            <div className="vt-date-field">
              <label className="vt-date-label">TO</label>
              <input
                type="date"
                className="vt-date-input"
                value={dateTo}
                min={dateFrom || summary?.date_from || ''}
                max={summary?.date_to || ''}
                onChange={e => setDateTo(e.target.value)}
              />
            </div>
          </div>
          {error && <div className="vt-import-error">{error}</div>}
          <div className="vt-delete-actions">
            <button
              className="vt-btn-ghost"
              onClick={() => { setMode(null); setDateFrom(''); setDateTo(''); setError('') }}
            >
              CANCEL
            </button>
            <button
              className="vt-delete-confirm-btn"
              onClick={() => setConfirming(true)}
              disabled={!dateFrom || !dateTo}
            >
              CONTINUE
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <div className="vt-delete-confirm">
          <div className="vt-delete-confirm-msg">
            {mode === 'all'
              ? 'This will permanently delete ALL health data. This cannot be undone.'
              : `This will permanently delete data from ${fmtDate(dateFrom)} to ${fmtDate(dateTo)}. Cannot be undone.`}
          </div>
          {error && <div className="vt-import-error">{error}</div>}
          <div className="vt-delete-actions">
            <button className="vt-btn-ghost" onClick={() => { setConfirming(false); if (mode === 'all') setMode(null) }}>
              CANCEL
            </button>
            <button className="vt-delete-final-btn" onClick={doDelete} disabled={working}>
              {working ? 'DELETING...' : mode === 'all' ? 'WIPE ALL DATA' : 'CONFIRM DELETE'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── AUTO-UPLOAD STATUS ───────────────────────────────────────────────────────
// Shows the status of the watch-folder and network endpoint.
// The backend checks the watch folder on startup and exposes POST /health/auto-import.

function AutoUploadInfo({ autoStatus }) {
  return (
    <div className="vt-auto-upload">
      <div className="vt-auto-header">
        <span className="vt-chart-title">AUTO-IMPORT</span>
        <span className="vt-chart-hint">RUNS EACH TIME THE APP STARTS</span>
      </div>
      <div className="vt-auto-rows">
        <div className="vt-auto-row">
          <div className={`vt-auto-pip ${autoStatus?.folder_watch ? 'active' : 'inactive'}`} />
          <div className="vt-auto-row-text">
            <span className="vt-auto-row-label">WATCH FOLDER</span>
            <span className="vt-auto-row-sub">
              Drop export.xml into <code className="vt-code">witness/health-inbox/</code> — auto-imports on next launch
            </span>
          </div>
          {autoStatus?.folder_last_import && (
            <span className="vt-auto-row-time">
              LAST: {fmtDate(autoStatus.folder_last_import)}
            </span>
          )}
        </div>
        <div className="vt-auto-row">
          <div className={`vt-auto-pip ${autoStatus?.endpoint_ready ? 'active' : 'inactive'}`} />
          <div className="vt-auto-row-text">
            <span className="vt-auto-row-label">NETWORK ENDPOINT</span>
            <span className="vt-auto-row-sub">
              iOS Shortcut POSTs to <code className="vt-code">http://[YOUR-PC-IP]:8000/health/auto-import</code>
            </span>
          </div>
          {autoStatus?.endpoint_last_import && (
            <span className="vt-auto-row-time">
              LAST: {fmtDate(autoStatus.endpoint_last_import)}
            </span>
          )}
        </div>
      </div>
      <div className="vt-auto-note">
        Set up the iOS Shortcut when ready — the endpoint is already live whenever Witness is running.
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function Vitals() {
  const [summary,     setSummary]     = useState(null)
  const [health,      setHealth]      = useState([])
  const [overlay,     setOverlay]     = useState([])
  const [autoStatus,  setAutoStatus]  = useState(null)
  const [days,        setDays]        = useState(30)
  const [loading,     setLoading]     = useState(true)
  const [showImport,  setShowImport]  = useState(false)
  const [showDelete,  setShowDelete]  = useState(false)
  const [showAuto,    setShowAuto]    = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sumRes, healthRes, overlayRes, autoRes] = await Promise.all([
        fetch(`${API}/health/summary`),
        fetch(`${API}/health/data?days=${days}`),
        fetch(`${API}/insights/trends?days=${days}`),
        fetch(`${API}/health/auto-status`),
      ])

      setSummary(sumRes.ok         ? await sumRes.json()     : null)
      setHealth(healthRes.ok       ? await healthRes.json()  : [])
      setOverlay(overlayRes.ok     ? await overlayRes.json() : [])
      setAutoStatus(autoRes.ok     ? await autoRes.json()    : null)
    } catch (e) {
      console.error('Vitals load error:', e)
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => { load() }, [load])

  const hasData  = summary && summary.count > 0
  const DAYS_OPT = [7, 14, 30, 90]

  const stats = {
    hrv:       avg(health.map(d => d.hrv)),
    restingHr: avg(health.map(d => d.resting_hr)),
    sleep:     avg(health.map(d => d.sleep_total_mins)),
    steps:     avg(health.map(d => d.steps)),
    calories:  avg(health.map(d => d.active_calories)),
  }

  const dates = health.map(d => d.date)

  return (
    <div className="vt-screen">

      {/* Header */}
      <div className="vt-header">
        <div className="vt-header-left">
          <h1 className="page-title">VITALS</h1>
          <span className="page-subtitle">
            {hasData
              ? `${summary.count} DAYS ON RECORD · ${fmtDate(summary.date_from)} — ${fmtDate(summary.date_to)}`
              : 'HEALTH DASHBOARD'}
          </span>
        </div>
        <div className="vt-header-right">
          {hasData && (
            <div className="vt-days-selector">
              {DAYS_OPT.map(d => (
                <button key={d}
                  className={`vt-days-btn ${days === d ? 'active' : ''}`}
                  onClick={() => setDays(d)}>
                  {d}D
                </button>
              ))}
            </div>
          )}
          <button
            className={`vt-import-btn ${showAuto ? 'active' : ''}`}
            onClick={() => { setShowAuto(s => !s); setShowImport(false); setShowDelete(false) }}
            title="Auto-import settings"
          >
            AUTO
          </button>
          {hasData && (
            <button
              className={`vt-import-btn vt-import-btn-danger ${showDelete ? 'active' : ''}`}
              onClick={() => { setShowDelete(s => !s); setShowImport(false); setShowAuto(false) }}
            >
              DELETE
            </button>
          )}
          <button
            className={`vt-import-btn ${showImport ? 'active' : ''}`}
            onClick={() => { setShowImport(s => !s); setShowDelete(false); setShowAuto(false) }}
          >
            {showImport ? 'HIDE IMPORT' : '+ IMPORT'}
          </button>
        </div>
      </div>

      {/* Panels — only one shows at a time */}
      {showImport && (
        <ImportPanel onImported={() => { setShowImport(false); load() }} />
      )}
      {showDelete && (
        <DeletePanel
          summary={summary}
          onDeleted={() => { setShowDelete(false); load() }}
        />
      )}
      {showAuto && (
        <AutoUploadInfo autoStatus={autoStatus} />
      )}

      {/* Content */}
      <div className="vt-content">
        {loading ? (
          <div className="vt-state-msg">
            <div className="vt-spinner" /> LOADING...
          </div>
        ) : !hasData ? (
          <div className="vt-empty">
            <div className="vt-empty-glyph">⬡</div>
            <div className="vt-empty-title">NO HEALTH DATA</div>
            <div className="vt-empty-sub">
              Import your Apple Health export to unlock HRV tracking, sleep
              analysis, and the HRV vs Stress correlation chart.
            </div>
            <div className="vt-empty-sub">
              On your iPhone: Health → your profile photo → Export All Health Data.
              Transfer the .zip to your PC, unzip it, then import the
              <strong> export.xml</strong> file using the import button above.
            </div>
            <button className="vt-btn-primary" onClick={() => setShowImport(true)}>
              IMPORT APPLE HEALTH
            </button>
          </div>
        ) : (
          <>
            <div className="vt-stats-row">
              <StatCard label="AVG HRV"    value={stats.hrv != null ? Math.round(stats.hrv) : null} unit="ms"   color="#50c8c8" sub={`${days}D AVG`} />
              <StatCard label="RESTING HR" value={stats.restingHr != null ? Math.round(stats.restingHr) : null} unit="bpm" color="#e05050" sub={`${days}D AVG`} />
              <StatCard label="AVG SLEEP"  value={stats.sleep != null ? fmtMins(Math.round(stats.sleep)) : null} color="#9050e0" sub={`${days}D AVG`} />
              <StatCard label="AVG STEPS"  value={stats.steps != null ? Math.round(stats.steps).toLocaleString() : null} color="#50a870" sub={`${days}D AVG`} />
              <StatCard label="ACTIVE CAL" value={stats.calories != null ? Math.round(stats.calories) : null} unit="kcal" color="#c38c32" sub={`${days}D AVG`} />
            </div>

            <ChartBlock title="HRV VS STRESS OVERLAY" hint="CYAN = HRV (ms) · RED DASHED = STRESS (1-10)">
              <OverlayChart data={overlay} />
            </ChartBlock>

            <ChartBlock title="HEART RATE VARIABILITY" hint="HIGHER = BETTER RECOVERY">
              <Sparkline data={health.map(d => d.hrv)} dates={dates} color="#50c8c8" height={56} label="HRV" unit=" ms" />
              <div className="vt-chart-axis">
                <span>{fmtDate(health[0]?.date)}</span>
                <span>{fmtDate(health[health.length - 1]?.date)}</span>
              </div>
            </ChartBlock>

            <ChartBlock title="RESTING HEART RATE" hint="LOWER = BETTER">
              <Sparkline data={health.map(d => d.resting_hr)} dates={dates} color="#e05050" height={56} label="HR" unit=" bpm" />
              <div className="vt-chart-axis">
                <span>{fmtDate(health[0]?.date)}</span>
                <span>{fmtDate(health[health.length - 1]?.date)}</span>
              </div>
            </ChartBlock>

            <ChartBlock title="SLEEP" hint="BLUE = DEEP · PURPLE = REM · SLATE = LIGHT">
              <SleepBars data={health} />
              <div className="vt-chart-axis">
                <span>{fmtDate(health[0]?.date)}</span>
                <span>{stats.sleep != null ? `AVG ${fmtMins(Math.round(stats.sleep))}` : ''}</span>
                <span>{fmtDate(health[health.length - 1]?.date)}</span>
              </div>
            </ChartBlock>

            <ChartBlock title="DAILY STEPS">
              <Sparkline data={health.map(d => d.steps)} dates={dates} color="#50a870" height={56} label="STEPS" unit="" />
              <div className="vt-chart-axis">
                <span>{fmtDate(health[0]?.date)}</span>
                <span>{fmtDate(health[health.length - 1]?.date)}</span>
              </div>
            </ChartBlock>

            <ChartBlock title="ACTIVE CALORIES">
              <Sparkline data={health.map(d => d.active_calories)} dates={dates} color="#c38c32" height={56} label="CAL" unit=" kcal" />
              <div className="vt-chart-axis">
                <span>{fmtDate(health[0]?.date)}</span>
                <span>{fmtDate(health[health.length - 1]?.date)}</span>
              </div>
            </ChartBlock>
          </>
        )}
      </div>
    </div>
  )
}
