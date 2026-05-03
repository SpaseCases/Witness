/**
 * WITNESS — Export.jsx  (Step 5)
 *
 * Save this file at: witness/src/Export.jsx
 *
 * The EXPORT screen. Lets the user:
 *   - Choose a date range (or export everything)
 *   - Export as plain .txt or as .pdf
 *
 * How it works:
 *   1. User picks format + optional date range
 *   2. React asks the Python backend for the file bytes
 *   3. Electron saves it to wherever the user picks (via dialog)
 *
 * If the user is running in dev mode without Electron, the file
 * downloads normally through the browser.
 */

import { useState, useRef, useEffect } from 'react'
import { gsap } from 'gsap'
import '../src/styles/export.css'

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD
}

function nDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toLocaleDateString('en-CA')
}

// Build the export URL from format + optional date range
function buildUrl(format, range, customStart, customEnd) {
  const base = `${API}/export/${format}`
  const params = new URLSearchParams()

  if (range === 'week')   { params.set('start', nDaysAgo(7));  params.set('end', todayStr()) }
  if (range === 'month')  { params.set('start', nDaysAgo(30)); params.set('end', todayStr()) }
  if (range === '3month') { params.set('start', nDaysAgo(90)); params.set('end', todayStr()) }
  if (range === 'year')   { params.set('start', nDaysAgo(365)); params.set('end', todayStr()) }
  if (range === 'custom') {
    if (customStart) params.set('start', customStart)
    if (customEnd)   params.set('end',   customEnd)
  }
  // range === 'all' — no params

  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function Export() {
  const [format,      setFormat]      = useState('pdf')
  const [range,       setRange]       = useState('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd,   setCustomEnd]   = useState(todayStr())
  const [status,      setStatus]      = useState('idle')   // idle | loading | done | error
  const [errorMsg,    setErrorMsg]    = useState('')
  const [entryCount,  setEntryCount]  = useState(null)

  const headerRef = useRef(null)
  const cardRef   = useRef(null)

  // Entrance animation
  useEffect(() => {
    if (headerRef.current) {
      gsap.fromTo(headerRef.current,
        { opacity: 0, y: -10 },
        { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' }
      )
    }
    if (cardRef.current) {
      gsap.fromTo(cardRef.current,
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', delay: 0.08 }
      )
    }
  }, [])

  const handleExport = async () => {
    if (status === 'loading') return

    setStatus('loading')
    setErrorMsg('')
    setEntryCount(null)

    const url = buildUrl(format, range, customStart, customEnd)
    const ext  = format === 'pdf' ? '.pdf' : '.txt'
    const mime = format === 'pdf' ? 'application/pdf' : 'text/plain'

    // Suggest a filename to Electron
    const suggested = `witness-export-${todayStr()}${ext}`

    try {
      const res = await fetch(url)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail || `Server returned ${res.status}`)
      }

      const count = res.headers.get('X-Entry-Count')
      if (count) setEntryCount(parseInt(count, 10))

      const bytes = await res.arrayBuffer()

      // ── Electron path: use IPC to open Save dialog ──────────────────────
      if (window.witness?.saveFile) {
        const uint8 = new Uint8Array(bytes)
        const result = await window.witness.saveFile({
          defaultName: suggested,
          filters: format === 'pdf'
            ? [{ name: 'PDF Files', extensions: ['pdf'] }]
            : [{ name: 'Text Files', extensions: ['txt'] }],
          buffer: Array.from(uint8),  // IPC can't send Uint8Array directly
        })
        if (result === 'cancelled') {
          setStatus('idle')
          return
        }
      } else {
        // ── Browser fallback: trigger a download ─────────────────────────
        const blob = new Blob([bytes], { type: mime })
        const a    = document.createElement('a')
        a.href     = URL.createObjectURL(blob)
        a.download = suggested
        a.click()
        URL.revokeObjectURL(a.href)
      }

      setStatus('done')

      // Reset status after 4 seconds
      setTimeout(() => setStatus('idle'), 4000)

    } catch (err) {
      console.error('Export error:', err)
      setErrorMsg(err.message || 'Unknown error')
      setStatus('error')
    }
  }

  const rangeValid = range !== 'custom' || (customStart && customEnd && customStart <= customEnd)

  return (
    <div className="export-page">

      {/* Page header */}
      <div className="page-header" ref={headerRef}>
        <div className="page-header-left">
          <h1 className="page-title">EXPORT</h1>
          <span className="page-subtitle">SAVE YOUR JOURNAL TO A FILE</span>
        </div>
      </div>

      {/* Main card */}
      <div className="export-card" ref={cardRef}>

        {/* Format picker */}
        <section className="export-section">
          <div className="export-section-label">FILE FORMAT</div>
          <div className="export-toggle-row">
            {[
              { id: 'pdf', label: 'PDF',        sub: 'Formatted, printable' },
              { id: 'txt', label: 'PLAIN TEXT',  sub: 'Markdown-friendly' },
            ].map(opt => (
              <button
                key={opt.id}
                className={`export-toggle-btn ${format === opt.id ? 'active' : ''}`}
                onClick={() => setFormat(opt.id)}
              >
                <span className="export-toggle-label">{opt.label}</span>
                <span className="export-toggle-sub">{opt.sub}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Date range picker */}
        <section className="export-section">
          <div className="export-section-label">DATE RANGE</div>
          <div className="export-range-grid">
            {[
              { id: 'all',    label: 'ALL ENTRIES' },
              { id: 'week',   label: 'LAST 7 DAYS' },
              { id: 'month',  label: 'LAST 30 DAYS' },
              { id: '3month', label: 'LAST 90 DAYS' },
              { id: 'year',   label: 'LAST YEAR' },
              { id: 'custom', label: 'CUSTOM RANGE' },
            ].map(opt => (
              <button
                key={opt.id}
                className={`export-range-btn ${range === opt.id ? 'active' : ''}`}
                onClick={() => setRange(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {range === 'custom' && (
            <div className="export-custom-range">
              <div className="export-date-field">
                <label className="export-date-label">FROM</label>
                <input
                  type="date"
                  className="export-date-input"
                  value={customStart}
                  max={customEnd || todayStr()}
                  onChange={e => setCustomStart(e.target.value)}
                />
              </div>
              <span className="export-date-sep">TO</span>
              <div className="export-date-field">
                <label className="export-date-label">TO</label>
                <input
                  type="date"
                  className="export-date-input"
                  value={customEnd}
                  max={todayStr()}
                  onChange={e => setCustomEnd(e.target.value)}
                />
              </div>
            </div>
          )}
        </section>

        {/* What gets exported */}
        <section className="export-section export-section-info">
          <div className="export-section-label">WHAT IS INCLUDED</div>
          <div className="export-includes-grid">
            {[
              'Full transcripts',
              'AI-generated summaries',
              'Mood / stress / energy scores',
              'Follow-up Q&A pairs',
              'Starred status',
              'Weekly and monthly recaps',
            ].map(item => (
              <div key={item} className="export-include-item">
                <span className="export-include-dot">◆</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
          <div className="export-privacy-note">
            FILES ARE SAVED LOCALLY. NOTHING IS UPLOADED OR SENT ANYWHERE.
          </div>
        </section>

        {/* Status / result */}
        {status === 'done' && (
          <div className="export-status export-status-done">
            {entryCount !== null
              ? `DONE. ${entryCount} ENTR${entryCount === 1 ? 'Y' : 'IES'} EXPORTED.`
              : 'FILE SAVED SUCCESSFULLY.'
            }
          </div>
        )}

        {status === 'error' && (
          <div className="export-status export-status-error">
            EXPORT FAILED: {errorMsg}
          </div>
        )}

        {/* Action button */}
        <button
          className={`export-run-btn ${status === 'loading' ? 'loading' : ''}`}
          onClick={handleExport}
          disabled={status === 'loading' || !rangeValid}
        >
          {status === 'loading'
            ? 'GENERATING...'
            : `EXPORT AS ${format.toUpperCase()}`
          }
        </button>

        {range === 'custom' && !rangeValid && (
          <div className="export-validation-msg">
            Set a valid date range before exporting.
          </div>
        )}

      </div>
    </div>
  )
}
