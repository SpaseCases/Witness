/**
 * WITNESS — Settings (Step 15)
 * CONFIG screen: model, context window, notifications, profile, question pool, danger zone.
 * Step 15 adds: Model Catalog section with hardware-aware badges and one-click download.
 *
 * Save this file at: witness/src/Settings.jsx
 */

import { useState, useEffect, useRef, useCallback } from 'react'

const API = 'http://127.0.0.1:8000'

// ─── CONTEXT WINDOW OPTIONS ───────────────────────────────────────────────────

const CTX_OPTIONS = [
  { value: '2048',  label: '2K' },
  { value: '4096',  label: '4K' },
  { value: '8192',  label: '8K' },
  { value: '16384', label: '16K' },
  { value: '32768', label: '32K' },
]

function getRecommendedCtx(modelName, vramGb = null) {
  if (!modelName) return '16384'
  const m = modelName.toLowerCase()
  if (m.includes('70b') || m.includes('65b')) return '4096'
  if (m.includes('32b') || m.includes('34b')) return '8192'
  const vram = vramGb != null ? vramGb : 0
  if (m.includes('14b') || m.includes('13b')) {
    if (vram >= 16) return '32768'
    if (vram >= 8)  return '16384'
    return '8192'
  }
  if (m.includes('7b') || m.includes('8b')) {
    if (vram >= 8) return '32768'
    return '16384'
  }
  if (vram >= 16) return '32768'
  if (vram >= 8)  return '16384'
  return '8192'
}

function getCtxNote(modelName, vramGb = null) {
  if (!modelName) return ''
  const m    = modelName.toLowerCase()
  const vram = vramGb != null ? vramGb : 0
  if (m.includes('70b') || m.includes('65b'))
    return 'Large model — 4K recommended to stay within VRAM limits on most GPUs.'
  if (m.includes('32b') || m.includes('34b'))
    return '32B may spill to system RAM above 8K. 8K is the safe ceiling on most GPUs.'
  if (m.includes('14b') || m.includes('13b')) {
    if (vram >= 16) return `${vram}GB VRAM detected — 32K context fits this model comfortably. Use it.`
    if (vram >= 8)  return `${vram}GB VRAM detected — 16K is the safe ceiling for this model.`
    return `${vram || 'unknown'}GB VRAM detected — keeping context at 8K to avoid memory pressure.`
  }
  if (m.includes('7b') || m.includes('8b')) {
    if (vram >= 8) return `${vram}GB VRAM detected — 32K context fits 7-8B models comfortably.`
    return '32K context may cause memory pressure on this GPU. Consider 16K if you see slowdowns.'
  }
  return 'Whisper runs on CPU. Your GPU handles LLM inference only — context limits are generous.'
}

// ─── SPINNER ─────────────────────────────────────────────────────────────────

function Spinner({ size = 14 }) {
  return (
    <span
      className="cfg-spinner"
      style={{ width: size, height: size }}
    />
  )
}

// ─── SECTION WRAPPER ─────────────────────────────────────────────────────────

function Section({ title, tag, children }) {
  return (
    <div className="cfg-section">
      <div className="cfg-section-header">
        <span className="cfg-section-title">{title}</span>
        {tag && <span className="cfg-section-tag">{tag}</span>}
      </div>
      <div className="cfg-section-body">
        {children}
      </div>
    </div>
  )
}

// ─── RECOMMENDATION BADGE STYLES ─────────────────────────────────────────────

const REC_STYLES = {
  'BEST FIT':   { color: '#f5a830', border: 'rgba(245,168,48,0.45)' },
  'COMPATIBLE': { color: '#a09080', border: 'rgba(160,144,128,0.3)' },
  'HEAVY':      { color: '#e05050', border: 'rgba(224,80,80,0.45)'  },
  'LIGHT':      { color: '#5090c0', border: 'rgba(80,144,192,0.35)' },
}

// ─── MODEL SELECTOR (installed models) ───────────────────────────────────────

function ModelSelector({ selectedModel, onSelect, models, loading, hardware }) {
  if (loading) {
    return (
      <div className="cfg-model-loading">
        <Spinner /> FETCHING INSTALLED MODELS...
      </div>
    )
  }
  if (models.length === 0) {
    return (
      <div className="cfg-model-empty">
        No models found. Make sure Ollama is running and you have at least one model pulled.
      </div>
    )
  }
  return (
    <div className="cfg-model-list">
      {models.map(m => {
        const rec      = m.recommendation || 'COMPATIBLE'
        const recStyle = REC_STYLES[rec] || REC_STYLES['COMPATIBLE']
        return (
          <button
            key={m.name}
            className={`cfg-model-row ${selectedModel === m.name ? 'active' : ''}`}
            onClick={() => onSelect(m.name)}
          >
            <div className="cfg-model-row-left">
              <div className="cfg-model-row-top">
                <span className="cfg-model-name">{m.name}</span>
                <span className="cfg-model-size">{m.size}</span>
              </div>
              {m.rec_note && (
                <span className="cfg-model-rec-note">{m.rec_note}</span>
              )}
            </div>
            <div className="cfg-model-row-right">
              {rec === 'HEAVY' && (
                <span className="cfg-model-heavy-warn">MAY RUN SLOWLY</span>
              )}
              <span
                className="cfg-model-rec-badge"
                style={{ color: recStyle.color, borderColor: recStyle.border }}
              >
                {rec}
              </span>
              {selectedModel === m.name && (
                <span className="cfg-model-check">SELECTED</span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ─── MODEL CATALOG (downloadable models) ─────────────────────────────────────

const TIER_LABELS = {
  1: 'ULTRA LIGHT',
  2: 'MID RANGE',
  3: 'HIGH END',
  4: 'WORKSTATION',
}

function ModelCatalog({ onModelInstalled }) {
  const [catalog,     setCatalog]     = useState([])
  const [hardware,    setHardware]    = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  // Pull state per model: null | { phase: 'pulling'|'done'|'error', pct: 0-100, status: '' }
  const [pullState,   setPullState]   = useState({})

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const res  = await fetch(`${API}/settings/model-catalog`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        setCatalog(data.catalog || [])
        setHardware(data.hardware || null)
      } catch (e) {
        setError('Could not load model catalog. Make sure the backend is running.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const startPull = async (modelName) => {
    // Reset/init state for this model
    setPullState(prev => ({
      ...prev,
      [modelName]: { phase: 'pulling', pct: 0, status: 'Connecting...' }
    }))

    try {
      const res = await fetch(`${API}/settings/pull-model`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: modelName }),
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.detail || `HTTP ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue
          let chunk
          try { chunk = JSON.parse(line) } catch { continue }

          if (chunk.error) {
            throw new Error(chunk.error)
          }

          const status    = chunk.status || ''
          const total     = chunk.total     || 0
          const completed = chunk.completed || 0
          const pct       = total > 0 ? Math.round((completed / total) * 100) : 0

          if (status === 'success') {
            setPullState(prev => ({
              ...prev,
              [modelName]: { phase: 'done', pct: 100, status: 'Download complete' }
            }))
            // Remove from catalog and trigger installed list refresh
            setCatalog(prev => prev.filter(m => m.name !== modelName))
            onModelInstalled?.()
            return
          }

          // Format a human-readable status line
          let displayStatus = status
          if (status.startsWith('pulling')) displayStatus = 'Pulling manifest...'
          else if (status.startsWith('downloading')) displayStatus = `Downloading... ${pct}%`
          else if (status.startsWith('verifying')) displayStatus = 'Verifying...'
          else if (status.startsWith('writing')) displayStatus = 'Writing to disk...'

          setPullState(prev => ({
            ...prev,
            [modelName]: { phase: 'pulling', pct, status: displayStatus }
          }))
        }
      }

    } catch (e) {
      setPullState(prev => ({
        ...prev,
        [modelName]: { phase: 'error', pct: 0, status: e.message || 'Download failed' }
      }))
    }
  }

  // ── Hardware summary line ──────────────────────────────────────────────────
  const hwLine = hardware
    ? (() => {
        const parts = []
        if (hardware.gpu_name) parts.push(hardware.gpu_name)
        if (hardware.vram_gb != null) parts.push(`${hardware.vram_gb}GB VRAM`)
        if (hardware.ram_gb  != null) parts.push(`${hardware.ram_gb}GB RAM`)
        return parts.length > 0
          ? parts.join(' · ') + ' — BEST FIT models highlighted'
          : null
      })()
    : null

  if (loading) {
    return (
      <div className="cfg-model-loading">
        <Spinner /> LOADING CATALOG...
      </div>
    )
  }
  if (error) {
    return <div className="cfg-catalog-error">{error}</div>
  }

  // Group by tier
  const tiers = {}
  for (const m of catalog) {
    const t = m.tier || 1
    if (!tiers[t]) tiers[t] = []
    tiers[t].push(m)
  }

  return (
    <div className="cfg-catalog">

      {/* Hardware summary */}
      <div className="cfg-catalog-hw">
        {hwLine
          ? <>
              <span className="cfg-catalog-hw-label">DETECTED:</span>
              <span className="cfg-catalog-hw-value">{hwLine}</span>
            </>
          : <span className="cfg-catalog-hw-unknown">
              HARDWARE UNKNOWN — SHOWING ALL MODELS
            </span>
        }
      </div>

      {catalog.length === 0 && (
        <div className="cfg-catalog-all-installed">
          All catalog models are already installed.
        </div>
      )}

      {Object.entries(tiers)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([tier, models]) => (
          <div key={tier} className="cfg-catalog-tier">
            <div className="cfg-catalog-tier-label">
              TIER {tier} — {TIER_LABELS[tier] || ''}
            </div>
            <div className="cfg-catalog-list">
              {models.map(m => {
                const rec      = m.recommendation || 'COMPATIBLE'
                const recStyle = REC_STYLES[rec] || REC_STYLES['COMPATIBLE']
                const ps       = pullState[m.name] || null

                return (
                  <div
                    key={m.name}
                    className={`cfg-catalog-row ${rec === 'BEST FIT' ? 'best-fit' : ''}`}
                  >
                    {/* Left: model info */}
                    <div className="cfg-catalog-row-left">
                      <div className="cfg-catalog-row-top">
                        <span className="cfg-model-name">{m.name}</span>
                        <div className="cfg-catalog-tags">
                          {m.is_reasoning  && <span className="cfg-catalog-tag reasoning">REASONING</span>}
                          {m.is_multimodal && <span className="cfg-catalog-tag multimodal">MULTIMODAL</span>}
                        </div>
                      </div>
                      <div className="cfg-catalog-meta">
                        <span className="cfg-catalog-meta-item">
                          {m.download_size_gb}GB DOWNLOAD
                        </span>
                        <span className="cfg-catalog-meta-sep">·</span>
                        <span className="cfg-catalog-meta-item">
                          {m.vram_min_gb}GB VRAM MIN
                        </span>
                        <span className="cfg-catalog-meta-sep">·</span>
                        <span className="cfg-catalog-meta-item">
                          {m.context_label} CTX
                        </span>
                      </div>
                      <div className="cfg-catalog-desc">{m.description}</div>
                      {m.rec_note && (
                        <div className="cfg-catalog-rec-note">{m.rec_note}</div>
                      )}

                      {/* Progress bar — only shown while pulling */}
                      {ps && (
                        <div className="cfg-catalog-pull-status">
                          {ps.phase === 'pulling' && (
                            <>
                              <div className="cfg-catalog-progress-bar">
                                <div
                                  className="cfg-catalog-progress-fill"
                                  style={{ width: `${ps.pct}%` }}
                                />
                              </div>
                              <div className="cfg-catalog-pull-text">
                                <Spinner size={10} />
                                {ps.status}
                                {ps.pct > 0 && (
                                  <span className="cfg-catalog-pull-pct">{ps.pct}%</span>
                                )}
                              </div>
                            </>
                          )}
                          {ps.phase === 'error' && (
                            <div className="cfg-catalog-pull-error">{ps.status}</div>
                          )}
                          {ps.phase === 'done' && (
                            <div className="cfg-catalog-pull-done">Download complete</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Right: badge + download button */}
                    <div className="cfg-catalog-row-right">
                      {rec === 'HEAVY' && (
                        <span className="cfg-model-heavy-warn">NEEDS MORE VRAM</span>
                      )}
                      <span
                        className="cfg-model-rec-badge"
                        style={{ color: recStyle.color, borderColor: recStyle.border }}
                      >
                        {rec}
                      </span>
                      {ps?.phase === 'pulling' ? (
                        <button className="cfg-catalog-dl-btn pulling" disabled>
                          PULLING...
                        </button>
                      ) : ps?.phase === 'done' ? (
                        <button className="cfg-catalog-dl-btn done" disabled>
                          INSTALLED
                        </button>
                      ) : (
                        <button
                          className="cfg-catalog-dl-btn"
                          onClick={() => startPull(m.name)}
                        >
                          DOWNLOAD
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))
      }
    </div>
  )
}

// ─── CONTEXT WINDOW SELECTOR ─────────────────────────────────────────────────

function ContextSelector({ value, onChange, modelName, hardware }) {
  const vramGb      = hardware?.vram_gb ?? null
  const recommended = getRecommendedCtx(modelName, vramGb)
  const note        = getCtxNote(modelName, vramGb)

  const hwLine = hardware
    ? [
        hardware.gpu_name || 'GPU UNKNOWN',
        hardware.vram_gb  != null ? `${hardware.vram_gb}GB VRAM` : 'VRAM UNKNOWN',
        hardware.ram_gb   != null ? `${hardware.ram_gb}GB RAM`   : 'RAM UNKNOWN',
        'WHISPER ON CPU · LLM ON GPU',
      ].join(' · ')
    : 'DETECTING HARDWARE...'

  return (
    <div className="cfg-ctx-wrap">
      <div className="cfg-ctx-options">
        {CTX_OPTIONS.map(opt => (
          <button
            key={opt.value}
            className={`cfg-ctx-btn ${value === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.value === recommended && (
              <span className="cfg-ctx-rec">REC</span>
            )}
          </button>
        ))}
      </div>
      {note && (
        <div className="cfg-ctx-note">
          <span className="cfg-ctx-note-pip">▸</span> {note}
        </div>
      )}
      <div className="cfg-ctx-hw">
        HARDWARE: {hwLine}
      </div>
    </div>
  )
}

// ─── QUESTION POOL ────────────────────────────────────────────────────────────

function QuestionPool({ questions, onChange }) {
  const [newQ,    setNewQ]    = useState('')
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)
  const inputRef              = useRef(null)

  const addQuestion = () => {
    const trimmed = newQ.trim()
    if (!trimmed) return
    onChange([...questions, trimmed])
    setNewQ('')
    inputRef.current?.focus()
  }

  const removeQuestion = (idx) => onChange(questions.filter((_, i) => i !== idx))

  const onDragStart = (e, idx) => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move' }
  const onDragOver  = (e, idx) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverIdx(idx) }
  const onDrop      = (e, idx) => {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) { setDragIdx(null); setOverIdx(null); return }
    const reordered = [...questions]
    const [moved]   = reordered.splice(dragIdx, 1)
    reordered.splice(idx, 0, moved)
    onChange(reordered)
    setDragIdx(null); setOverIdx(null)
  }
  const onDragEnd = () => { setDragIdx(null); setOverIdx(null) }

  return (
    <div className="cfg-qpool">
      <div className="cfg-qpool-desc">
        These questions are drawn from when the AI generates follow-up prompts after your
        daily entry. Drag to reorder. Questions higher in the list are used more often.
      </div>
      <div className="cfg-qpool-list">
        {questions.length === 0 && (
          <div className="cfg-qpool-empty">No custom questions yet. Add some below.</div>
        )}
        {questions.map((q, i) => (
          <div
            key={i}
            className={`cfg-qpool-item ${dragIdx === i ? 'dragging' : ''} ${overIdx === i && dragIdx !== i ? 'drag-over' : ''}`}
            draggable
            onDragStart={e => onDragStart(e, i)}
            onDragOver={e  => onDragOver(e, i)}
            onDrop={e      => onDrop(e, i)}
            onDragEnd={onDragEnd}
          >
            <span className="cfg-qpool-handle" title="Drag to reorder">⠿</span>
            <span className="cfg-qpool-num">{String(i + 1).padStart(2, '0')}</span>
            <span className="cfg-qpool-text">{q}</span>
            <button className="cfg-qpool-del" onClick={() => removeQuestion(i)} title="Remove">✕</button>
          </div>
        ))}
      </div>
      <div className="cfg-qpool-add">
        <input
          ref={inputRef}
          className="cfg-qpool-input"
          type="text"
          placeholder="TYPE A NEW QUESTION AND PRESS ENTER..."
          value={newQ}
          onChange={e => setNewQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addQuestion() }}
          maxLength={200}
        />
        <button
          className="cfg-qpool-add-btn"
          onClick={addQuestion}
          disabled={!newQ.trim()}
        >
          ADD
        </button>
      </div>
    </div>
  )
}

// ─── DANGER ZONE ─────────────────────────────────────────────────────────────

function DangerZone() {
  const [confirm, setConfirm] = useState(null)
  const [wiping,  setWiping]  = useState(false)
  const [doneMsg, setDoneMsg] = useState('')

  const wipe = async (type) => {
    setWiping(true)
    try {
      const endpoint = type === 'all' ? '/settings/wipe-all' : '/settings/wipe-entries'
      const res  = await fetch(`${API}${endpoint}`, { method: 'POST' })
      const data = await res.json()
      if (data.status === 'ok') {
        setDoneMsg(type === 'all'
          ? 'All data wiped. Witness is now fresh.'
          : 'All journal entries deleted. Settings and health data retained.')
      } else {
        setDoneMsg('Something went wrong. Check the backend logs.')
      }
    } catch {
      setDoneMsg('Could not reach backend.')
    } finally {
      setWiping(false)
      setConfirm(null)
      setTimeout(() => setDoneMsg(''), 6000)
    }
  }

  return (
    <div className="cfg-danger-zone">
      <div className="cfg-danger-label">DANGER ZONE</div>
      {doneMsg && <div className="cfg-danger-done">{doneMsg}</div>}
      <div className="cfg-danger-actions">

        {confirm === 'entries' ? (
          <div className="cfg-danger-confirm">
            <span className="cfg-danger-confirm-text">
              Delete all journal entries, metrics, flags, and recaps? Health data and settings are kept.
            </span>
            <div className="cfg-danger-confirm-btns">
              <button className="cfg-danger-confirm-yes" onClick={() => wipe('entries')} disabled={wiping}>
                {wiping ? 'WIPING...' : 'YES, DELETE ENTRIES'}
              </button>
              <button className="cfg-danger-cancel" onClick={() => setConfirm(null)}>CANCEL</button>
            </div>
          </div>
        ) : (
          <div className="cfg-danger-row">
            <div className="cfg-danger-row-info">
              <span className="cfg-danger-row-title">WIPE JOURNAL DATA</span>
              <span className="cfg-danger-row-sub">
                Deletes all entries, metrics, flags, and recaps. Health data and settings are kept.
              </span>
            </div>
            <button className="cfg-danger-btn" onClick={() => setConfirm('entries')}>WIPE ENTRIES</button>
          </div>
        )}

        {confirm === 'all' ? (
          <div className="cfg-danger-confirm cfg-danger-confirm-all">
            <span className="cfg-danger-confirm-text">
              Wipe everything? All entries, health data, settings, and flags will be permanently deleted. This cannot be undone.
            </span>
            <div className="cfg-danger-confirm-btns">
              <button className="cfg-danger-confirm-yes cfg-danger-confirm-yes-all" onClick={() => wipe('all')} disabled={wiping}>
                {wiping ? 'WIPING...' : 'YES, WIPE EVERYTHING'}
              </button>
              <button className="cfg-danger-cancel" onClick={() => setConfirm(null)}>CANCEL</button>
            </div>
          </div>
        ) : (
          <div className="cfg-danger-row">
            <div className="cfg-danger-row-info">
              <span className="cfg-danger-row-title">FACTORY RESET</span>
              <span className="cfg-danger-row-sub">
                Wipes everything. All data, all history, all settings. Witness starts fresh.
              </span>
            </div>
            <button className="cfg-danger-btn cfg-danger-btn-hard" onClick={() => setConfirm('all')}>WIPE ALL DATA</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── HEALTH IMPORT ────────────────────────────────────────────────────────────

function HealthImport() {
  const [importing,    setImporting]    = useState(false)
  const [msg,          setMsg]          = useState('')
  const fileRef                         = useRef(null)
  const [watchPath,    setWatchPath]    = useState('')
  const [watchSaving,  setWatchSaving]  = useState(false)
  const [watchSaveMsg, setWatchSaveMsg] = useState('')
  const [checking,     setChecking]     = useState(false)
  const [checkMsg,     setCheckMsg]     = useState('')
  const [lastImport,   setLastImport]   = useState(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [settingsRes, statusRes] = await Promise.all([
          fetch(`${API}/settings/`),
          fetch(`${API}/health/import-status`),
        ])
        if (settingsRes.ok) {
          const data = await settingsRes.json()
          setWatchPath(data.health_watch_path || '')
        }
        if (statusRes.ok) {
          setLastImport(await statusRes.json())
        }
      } catch {}
    }
    load()
  }, [])

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true); setMsg('Reading file...')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res  = await fetch(`${API}/health/import`, { method: 'POST', body: formData })
      const data = await res.json()
      if (data.status === 'ok') {
        setMsg(`Import complete. ${data.imported} new days added, ${data.updated} updated.`)
      } else {
        setMsg(data.detail || 'Import failed. Check the file and try again.')
      }
    } catch {
      setMsg('Could not reach backend. Make sure the app is running.')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
      setTimeout(() => setMsg(''), 8000)
    }
  }

  const saveWatchPath = async () => {
    setWatchSaving(true); setWatchSaveMsg('')
    try {
      const res = await fetch(`${API}/settings/health_watch_path`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: watchPath.trim() }),
      })
      setWatchSaveMsg(res.ok ? 'SAVED' : 'SAVE FAILED')
    } catch {
      setWatchSaveMsg('SAVE FAILED')
    } finally {
      setWatchSaving(false)
      setTimeout(() => setWatchSaveMsg(''), 4000)
    }
  }

  const checkNow = async () => {
    setChecking(true); setCheckMsg('')
    try {
      const res  = await fetch(`${API}/health/test-inbox`, { method: 'POST' })
      const data = await res.json()
      if (data.status === 'ok') {
        if (data.found === 0)          setCheckMsg('No .xml files found in watch folder.')
        else if (data.imported === 0)  setCheckMsg(`${data.found} file(s) found — all already imported.`)
        else                           setCheckMsg(`${data.imported} of ${data.found} file(s) imported successfully.`)
        const statusRes = await fetch(`${API}/health/import-status`)
        if (statusRes.ok) setLastImport(await statusRes.json())
      } else {
        setCheckMsg('Check failed. See backend logs.')
      }
    } catch {
      setCheckMsg('Could not reach backend.')
    } finally {
      setChecking(false)
      setTimeout(() => setCheckMsg(''), 8000)
    }
  }

  const formatImportDate = (row) => {
    if (!row) return 'NEVER'
    try {
      const d = new Date(row.imported_at)
      return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }).toUpperCase()
    } catch { return row.imported_at }
  }

  return (
    <div className="cfg-health-import">
      <div className="cfg-health-watch">
        <div className="cfg-field-label" style={{ marginBottom: 8 }}>WATCH FOLDER</div>
        <div className="cfg-health-desc" style={{ marginBottom: 10 }}>
          Witness will scan this folder for new Apple Health .xml exports once per hour
          and import them automatically. Paste the full folder path below.
          Imported files are moved to an <span className="cfg-health-mono">imported/</span> subfolder
          so they are never processed twice.
        </div>
        <div className="cfg-health-watch-row">
          <input
            className="cfg-health-watch-input"
            type="text"
            placeholder="C:\Users\YourName\Downloads\health-inbox"
            value={watchPath}
            onChange={e => setWatchPath(e.target.value)}
            spellCheck={false}
          />
          <button className="cfg-health-btn" onClick={saveWatchPath} disabled={watchSaving}>
            {watchSaving ? <><Spinner size={11} /> SAVING...</> : 'SAVE'}
          </button>
          <button className="cfg-health-btn" onClick={checkNow} disabled={checking} style={{ marginLeft: 6 }}>
            {checking ? <><Spinner size={11} /> CHECKING...</> : 'CHECK NOW'}
          </button>
        </div>
        <div className="cfg-health-watch-status">
          {checkMsg && <span className="cfg-health-msg" style={{ marginRight: 16 }}>{checkMsg}</span>}
          {watchSaveMsg && (
            <span className={`cfg-health-msg ${watchSaveMsg.includes('FAILED') ? 'error' : ''}`} style={{ marginRight: 16 }}>
              {watchSaveMsg}
            </span>
          )}
          <span className="cfg-health-last-import">
            LAST AUTO-IMPORT: {formatImportDate(lastImport)}
            {lastImport?.filename && (
              <span className="cfg-health-mono" style={{ marginLeft: 8, opacity: 0.6 }}>({lastImport.filename})</span>
            )}
          </span>
        </div>
      </div>
      <div className="cfg-health-divider" />
      <div className="cfg-field-label" style={{ marginBottom: 8 }}>MANUAL IMPORT</div>
      <div className="cfg-health-desc">
        Export your Apple Health data from the Health app on iPhone:
        Profile icon → Export All Health Data → Share the ZIP → extract
        <span className="cfg-health-mono"> export.xml</span> and select it here.
      </div>
      <div className="cfg-health-actions">
        <input ref={fileRef} type="file" accept=".xml" style={{ display: 'none' }} onChange={handleFile} />
        <button className="cfg-health-btn" onClick={() => fileRef.current?.click()} disabled={importing}>
          {importing ? <><Spinner size={11} /> IMPORTING...</> : 'SELECT EXPORT.XML'}
        </button>
        {msg && <span className="cfg-health-msg">{msg}</span>}
      </div>
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function Settings() {
  const [models,        setModels]        = useState([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [loading,       setLoading]       = useState(true)
  const [saving,        setSaving]        = useState(false)
  const [saveMsg,       setSaveMsg]       = useState('')
  const [dirty,         setDirty]         = useState(false)
  const [hardware,      setHardware]      = useState(null)

  const [selectedModel,  setSelectedModel]  = useState('gemma4:3b')
  const [contextWindow,  setContextWindow]  = useState('16384')
  const [notifyTime,     setNotifyTime]     = useState('20:00')
  const [notifyEnabled,  setNotifyEnabled]  = useState(true)
  const [warmupOnStart,  setWarmupOnStart]  = useState(true)
  const [userProfile,    setUserProfile]    = useState('')
  const [questionPool,   setQuestionPool]   = useState([])

  // catalog key — incrementing this forces ModelCatalog to reload
  const [catalogKey, setCatalogKey] = useState(0)

  const refreshModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const res = await fetch(`${API}/settings/models`)
      if (res.ok) {
        const data = await res.json()
        setModels(data.models || [])
      }
    } catch {}
    finally { setModelsLoading(false) }
  }, [])

  useEffect(() => {
    const init = async () => {
      try {
        const [settingsRes, modelsRes, hardwareRes] = await Promise.all([
          fetch(`${API}/settings/`),
          fetch(`${API}/settings/models`),
          fetch(`${API}/settings/hardware`),
        ])
        if (settingsRes.ok) {
          const data = await settingsRes.json()
          setSelectedModel(data.model || 'gemma4:3b')
          setContextWindow(data.context_window || '16384')
          setNotifyTime(data.notify_time        || '20:00')
          setNotifyEnabled(data.notify_enabled  !== '0')
          setWarmupOnStart(data.warmup_on_start !== '0')
          setUserProfile(data.user_profile      || '')
          try { setQuestionPool(JSON.parse(data.question_pool || '[]')) }
          catch { setQuestionPool([]) }
        }
        if (modelsRes.ok) {
          const mData = await modelsRes.json()
          setModels(mData.models || [])
        }
        if (hardwareRes.ok) {
          const hwData = await hardwareRes.json()
          setHardware(hwData)
          if (settingsRes.ok) {
            const sData = await settingsRes.json().catch(() => null)
            if (!sData?.context_window) {
              const model = sData?.model || 'gemma4:3b'
              setContextWindow(getRecommendedCtx(model, hwData?.vram_gb ?? null))
            }
          }
        }
      } catch (e) {
        console.error('Settings load error:', e)
      } finally {
        setLoading(false)
        setModelsLoading(false)
      }
    }
    init()
  }, [])

  const mark = useCallback((setter) => (val) => { setter(val); setDirty(true) }, [])

  const handleModelSelect = (name) => {
    setSelectedModel(name)
    setContextWindow(getRecommendedCtx(name, hardware?.vram_gb ?? null))
    setDirty(true)
  }

  // Called when ModelCatalog finishes a download — refresh installed list
  const handleModelInstalled = useCallback(() => {
    refreshModels()
    setCatalogKey(k => k + 1)
  }, [refreshModels])

  const saveAll = async () => {
    setSaving(true); setSaveMsg('')
    const updates = {
      model:           selectedModel,
      context_window:  contextWindow,
      notify_time:     notifyTime,
      notify_enabled:  notifyEnabled  ? '1' : '0',
      warmup_on_start: warmupOnStart  ? '1' : '0',
      user_profile:    userProfile,
      question_pool:   JSON.stringify(questionPool),
    }
    try {
      await Promise.all(
        Object.entries(updates).map(([key, value]) =>
          fetch(`${API}/settings/${key}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: String(value) }),
          })
        )
      )
      setSaveMsg('SETTINGS SAVED')
      setDirty(false)
    } catch {
      setSaveMsg('SAVE FAILED — CHECK BACKEND')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 4000)
    }
  }

  if (loading) {
    return (
      <div className="cfg-screen">
        <div className="cfg-loading"><Spinner size={16} /> LOADING CONFIGURATION...</div>
      </div>
    )
  }

  return (
    <div className="cfg-screen">

      {/* Header */}
      <div className="cfg-header">
        <div className="cfg-header-left">
          <h1 className="page-title">CONFIG</h1>
          <span className="page-subtitle">SYSTEM CONFIGURATION</span>
        </div>
        {dirty && <div className="cfg-unsaved-badge">UNSAVED CHANGES</div>}
      </div>

      {/* Scrollable content */}
      <div className="cfg-content">

        {/* 1. MODEL — INSTALLED */}
        <Section title="AI MODEL" tag="INSTALLED">
          <ModelSelector
            selectedModel={selectedModel}
            onSelect={handleModelSelect}
            models={models}
            loading={modelsLoading}
            hardware={hardware}
          />
        </Section>

        {/* 2. MODEL CATALOG — AVAILABLE TO DOWNLOAD */}
        <Section title="MODEL CATALOG" tag="AVAILABLE TO DOWNLOAD">
          <ModelCatalog
            key={catalogKey}
            onModelInstalled={handleModelInstalled}
          />
        </Section>

        {/* 3. CONTEXT WINDOW */}
        <Section title="CONTEXT WINDOW" tag="MEMORY DEPTH">
          <ContextSelector
            value={contextWindow}
            onChange={mark(setContextWindow)}
            modelName={selectedModel}
            hardware={hardware}
          />
        </Section>

        {/* 4. NOTIFICATIONS */}
        <Section title="DAILY REMINDER" tag="NOTIFICATIONS">
          <div className="cfg-notify-row">
            <div className="cfg-notify-toggle-wrap">
              <span className="cfg-field-label">REMINDER ENABLED</span>
              <button
                className={`cfg-toggle ${notifyEnabled ? 'on' : 'off'}`}
                onClick={() => { setNotifyEnabled(v => !v); setDirty(true) }}
              >
                <span className="cfg-toggle-knob" />
                <span className="cfg-toggle-label">{notifyEnabled ? 'ON' : 'OFF'}</span>
              </button>
            </div>
            <div className="cfg-notify-time-wrap">
              <span className="cfg-field-label">REMINDER TIME</span>
              <input
                className="cfg-time-input"
                type="time"
                value={notifyTime}
                onChange={e => { setNotifyTime(e.target.value); setDirty(true) }}
                disabled={!notifyEnabled}
              />
            </div>
          </div>
          <div className="cfg-field-hint">
            Witness will remind you to record your daily entry at this time.
            Notifications are local — nothing leaves your machine.
          </div>
          <div className="cfg-notify-row" style={{ marginTop: '16px' }}>
            <div className="cfg-notify-toggle-wrap">
              <span className="cfg-field-label">PRE-LOAD MODEL ON STARTUP</span>
              <button
                className={`cfg-toggle ${warmupOnStart ? 'on' : 'off'}`}
                onClick={() => { setWarmupOnStart(v => !v); setDirty(true) }}
              >
                <span className="cfg-toggle-knob" />
                <span className="cfg-toggle-label">{warmupOnStart ? 'ON' : 'OFF'}</span>
              </button>
            </div>
          </div>
          <div className="cfg-field-hint">
            ON: model loads at startup — first AI query is instant.
            OFF: faster app start, but first AI query takes 10-30 seconds to load the model.
          </div>
        </Section>

        {/* 5. PERSONAL PROFILE */}
        <Section title="PERSONAL PROFILE" tag="AI CONTEXT DOCUMENT">
          <div className="cfg-profile-wrap">
            <div className="cfg-field-hint cfg-profile-hint">
              Write anything the AI should know about you: job, relationships, health
              history, goals, recurring stressors, context. The AI reads this before
              generating insights and follow-up questions. Be specific — vague profiles
              produce generic output.
            </div>
            <textarea
              className="cfg-profile-textarea"
              placeholder="Example: I'm a 34 year old software engineer working remotely. I have a history of anxiety and insomnia..."
              value={userProfile}
              onChange={e => { setUserProfile(e.target.value); setDirty(true) }}
              spellCheck={true}
            />
            <div className="cfg-profile-count">{userProfile.length} CHARACTERS</div>
          </div>
        </Section>

        {/* 6. QUESTION POOL */}
        <Section title="QUESTION POOL" tag="FOLLOW-UP PROMPTS">
          <QuestionPool
            questions={questionPool}
            onChange={(q) => { setQuestionPool(q); setDirty(true) }}
          />
        </Section>

        {/* 7. APPLE HEALTH */}
        <Section title="APPLE HEALTH" tag="DATA IMPORT">
          <HealthImport />
        </Section>

        {/* 8. DANGER ZONE */}
        <DangerZone />

      </div>

      {/* Sticky footer */}
      <div className="cfg-footer">
        {saveMsg && (
          <span className={`cfg-save-msg ${saveMsg.includes('FAILED') ? 'error' : 'ok'}`}>
            {saveMsg}
          </span>
        )}
        <button
          className={`cfg-save-btn ${dirty ? 'ready' : ''}`}
          onClick={saveAll}
          disabled={saving || !dirty}
        >
          {saving ? <><Spinner size={12} /> SAVING...</> : 'SAVE SETTINGS'}
        </button>
      </div>

    </div>
  )
}
