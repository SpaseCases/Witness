/**
 * WITNESS -- Log Browser
 * ARCHIVE screen: searchable, filterable list of all entries + rants.
 *
 * Bug 2 fix:
 *   - EntryDetail always calls GET /entries/{id} regardless of type.
 *     No more special rant branch that skipped the API call.
 *     Rants are now first-class entries and the endpoint works for both.
 *   - For rant entries, the detail panel shows a TOPICS section (parsed
 *     tags array) where Q&A pairs would show for daily entries.
 *   - Semantic search rant branch simplified -- both types come back as
 *     normal entries from the entries table now.
 *
 * Step 7 addition:
 *   - SELECT MODE toggle in header bar.
 *   - When active: rows show checkboxes, clicking toggles selection instead
 *     of opening detail. Header shows count + DELETE SELECTED button.
 *   - Inline confirmation banner (no browser alert) with YES / CANCEL.
 *   - Confirmed delete: GSAP slide-out animation per row, then state removal.
 *   - CANCEL or ESC exits select mode and clears selection.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { gsap } from 'gsap'

const API = 'http://127.0.0.1:8000'

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }).toUpperCase()
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

// ─── METRIC PILL ─────────────────────────────────────────────────────────────

function MetricPill({ label, value }) {
  if (value == null) return null
  const n = Math.round(value * 10) / 10
  return (
    <div className="lb-metric-pill">
      <span className="lb-metric-label">{label}</span>
      <span className="lb-metric-val">{n}</span>
    </div>
  )
}

// ─── EXPANDED ENTRY DETAIL ────────────────────────────────────────────────────

function EntryDetail({ entry, onClose, onStar, onDelete }) {
  const [detail, setDetail]     = useState(null)
  const [loading, setLoading]   = useState(true)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`${API}/entries/${entry.id}`)
      .then(r => r.json())
      .then(d => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [entry.id])

  const handleDelete = async () => {
    if (!confirm('Delete this entry permanently?')) return
    setDeleting(true)
    await fetch(`${API}/entries/${entry.id}`, { method: 'DELETE' })
    onDelete(entry.id)
  }

  const handleStar = async () => {
    await fetch(`${API}/entries/${entry.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: !entry.starred })
    })
    onStar(entry.id)
  }

  const tags = Array.isArray(detail?.tags)
    ? detail.tags
    : (() => { try { return JSON.parse(detail?.tags || '[]') } catch { return [] } })()

  const goodTags = Array.isArray(detail?.good_tags)
    ? detail.good_tags
    : (() => { try { return JSON.parse(detail?.good_tags || '[]') } catch { return [] } })()

  const badTags = Array.isArray(detail?.bad_tags)
    ? detail.bad_tags
    : (() => { try { return JSON.parse(detail?.bad_tags || '[]') } catch { return [] } })()

  const hasDayTags = goodTags.length > 0 || badTags.length > 0

  // Parse structured summary — stored as JSON, may be null on older entries
  const structuredSummary = (() => {
    if (!detail?.structured_summary) return null
    try { return JSON.parse(detail.structured_summary) } catch { return null }
  })()

  return (
    <div className="lb-detail-overlay" onClick={onClose}>
      <div className="lb-detail-panel" onClick={e => e.stopPropagation()}>

        <div className="lb-detail-header">
          <div className="lb-detail-header-left">
            <span className={`lb-type-badge ${entry.type}`}>
              {entry.type === 'daily' ? 'ENTRY' : entry.type === 'write' ? 'WRITE' : 'DUMP'}
            </span>
            <span className="lb-detail-date">
              {fmtDate(entry.created_at)} · {fmtTime(entry.created_at)}
            </span>
          </div>
          <div className="lb-detail-header-right">
            <button
              className={`lb-star-btn ${entry.starred ? 'starred' : ''}`}
              onClick={handleStar}
            >
              {entry.starred ? '★' : '☆'}
            </button>
            <button className="lb-delete-btn" onClick={handleDelete} disabled={deleting}>
              {deleting ? '...' : '✕ DELETE'}
            </button>
            <button className="lb-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {loading ? (
          <div className="lb-detail-loading">
            <div className="lb-spinner" /> LOADING...
          </div>
        ) : detail ? (
          <div className="lb-detail-body">

            {detail.metrics && (
              <div className="lb-detail-metrics">
                <MetricPill label="MOOD"    value={detail.metrics.mood} />
                <MetricPill label="STRESS"  value={detail.metrics.stress} />
                <MetricPill label="ENERGY"  value={detail.metrics.energy} />
                <MetricPill label="ANXIETY" value={detail.metrics.anxiety} />
                <MetricPill label="CLARITY" value={detail.metrics.mental_clarity} />
              </div>
            )}

            <div className="lb-detail-section-label">TRANSCRIPT</div>
            {structuredSummary && (
              <div className="lb-summary-block">
                {structuredSummary.summary && (
                  <div className="lb-summary-sentence">{structuredSummary.summary}</div>
                )}
                {structuredSummary.highlights?.length > 0 && (
                  <ul className="lb-summary-highlights">
                    {structuredSummary.highlights.map((h, i) => (
                      <li key={i} className="lb-summary-highlight-item">{h}</li>
                    ))}
                  </ul>
                )}
                {structuredSummary.intentions?.length > 0 && (
                  <div className="lb-summary-intentions">
                    <span className="lb-summary-intentions-label">STATED INTENTIONS</span>
                    <ul className="lb-summary-intentions-list">
                      {structuredSummary.intentions.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <div className="lb-detail-transcript">
              {detail.transcript || '— no transcript —'}
            </div>

            {detail.type !== 'rant' && hasDayTags && (
              <div className="lb-tags-section">
                <div className="lb-detail-section-label">DAY TAGS</div>
                <div className="lb-tags-body">
                  {goodTags.length > 0 && (
                    <div className="lb-tags-row">
                      <span className="lb-tags-label lb-tags-label-good">GOOD</span>
                      <div className="lb-tags-chips">
                        {goodTags.map((t, i) => (
                          <span key={i} className="lb-tag-chip lb-tag-chip-good">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {badTags.length > 0 && (
                    <div className="lb-tags-row">
                      <span className="lb-tags-label lb-tags-label-bad">BAD</span>
                      <div className="lb-tags-chips">
                        {badTags.map((t, i) => (
                          <span key={i} className="lb-tag-chip lb-tag-chip-bad">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {detail.type === 'rant' && tags.length > 0 && (
              <div className="lb-detail-qa-block">
                <div className="lb-detail-section-label">TOPICS</div>
                <div className="lb-rant-tags-row">
                  {tags.map((tag, i) => (
                    <span key={i} className="lb-rant-tag">{tag}</span>
                  ))}
                </div>
              </div>
            )}

            {detail.type !== 'rant' && detail.qa_pairs?.length > 0 && (
              <div className="lb-detail-qa-block">
                <div className="lb-detail-section-label">FOLLOW-UP Q&A</div>
                {detail.qa_pairs.map((qa, i) => (
                  <div key={qa.id} className="lb-detail-qa-item">
                    <div className="lb-detail-q">
                      {String(i + 1).padStart(2, '0')} {qa.question}
                    </div>
                    {qa.answer && <div className="lb-detail-a">{qa.answer}</div>}
                  </div>
                ))}
              </div>
            )}

          </div>
        ) : (
          <div className="lb-detail-loading">Failed to load entry.</div>
        )}

      </div>
    </div>
  )
}

// ─── ENTRY ROW ───────────────────────────────────────────────────────────────

function EntryRow({ entry, onClick, showDistance, selectMode, selected, onToggleSelect, rowRef }) {
  const preview    = (entry.transcript || '').trim().slice(0, 140)
  const hasMetrics = entry.mood != null || entry.stress != null

  const relevance = showDistance && entry._semantic_distance != null
    ? Math.round((1 - entry._semantic_distance) * 100)
    : null

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect(entry.id)
    } else {
      onClick(entry)
    }
  }

  return (
    <div
      className={`lb-row ${selectMode ? 'lb-row-selectable' : ''} ${selected ? 'lb-row-selected' : ''}`}
      onClick={handleClick}
      ref={rowRef}
    >
      {/* Custom checkbox — only visible in select mode */}
      {selectMode && (
        <div className={`lb-checkbox ${selected ? 'lb-checkbox-checked' : ''}`}>
          {selected && <span className="lb-checkbox-mark">✓</span>}
        </div>
      )}

      <div className="lb-row-left">
        <span className={`lb-type-badge ${entry.type}`}>
          {entry.type === 'daily' ? 'ENTRY' : entry.type === 'write' ? 'WRITE' : 'DUMP'}
        </span>
        {entry.starred === 1 && <span className="lb-row-star">★</span>}
      </div>

      <div className="lb-row-main">
        <div className="lb-row-dateline">
          <span className="lb-row-date">{fmtDate(entry.created_at || entry.date)}</span>
          <span className="lb-row-time">{fmtTime(entry.created_at)}</span>
          {relevance !== null && (
            <span className="lb-relevance-pill">{relevance}% MATCH</span>
          )}
        </div>
        <div className="lb-row-preview">
          {preview
            ? `${preview}${(entry.transcript?.length || 0) > 140 ? '...' : ''}`
            : '— no transcript —'}
        </div>
      </div>

      {hasMetrics && !selectMode && (
        <div className="lb-row-metrics">
          {entry.mood   != null && <MetricPill label="MOOD"   value={entry.mood} />}
          {entry.stress != null && <MetricPill label="STRESS" value={entry.stress} />}
        </div>
      )}

      {!selectMode && <div className="lb-row-arrow">›</div>}
    </div>
  )
}

// ─── SEARCH MODE TOGGLE ───────────────────────────────────────────────────────

function SearchModeToggle({ mode, onChange }) {
  return (
    <div className="lb-mode-toggle" role="group" aria-label="Search mode">
      <button
        className={`lb-mode-btn ${mode === 'keyword' ? 'active' : ''}`}
        onClick={() => onChange('keyword')}
        title="Search by exact words and phrases"
      >
        KEYWORD
      </button>
      <button
        className={`lb-mode-btn ${mode === 'semantic' ? 'active' : ''}`}
        onClick={() => onChange('semantic')}
        title="Search by meaning"
      >
        SEMANTIC
      </button>
    </div>
  )
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export default function LogBrowser({ onNavigate }) {
  const [entries,     setEntries]     = useState([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [search,      setSearch]      = useState('')
  const [filter,      setFilter]      = useState('all')
  const [searchMode,  setSearchMode]  = useState('keyword')
  const [selected,    setSelected]    = useState(null)       // detail panel entry

  // ── Select mode state ─────────────────────────────────────────────────────
  const [selectMode,    setSelectMode]    = useState(false)
  const [selectedIds,   setSelectedIds]   = useState(new Set())
  const [showConfirm,   setShowConfirm]   = useState(false)
  const [deleting,      setDeleting]      = useState(false)

  const [total,      setTotal]      = useState(0)
  const searchRef                   = useRef(null)
  // Map of entry.id -> DOM ref for GSAP targeting during bulk delete
  const rowRefs = useRef({})

  const fetchKeyword = useCallback(async (q, f) => {
    const params = new URLSearchParams({ limit: 100 })
    if (q.trim())        params.set('keyword', q.trim())
    if (f === 'daily')   params.set('type', 'daily')
    if (f === 'rant')    params.set('type', 'rant')
    if (f === 'starred') params.set('starred', 'true')
    const res = await fetch(`${API}/entries/?${params}`)
    if (!res.ok) throw new Error('Failed to fetch')
    return res.json()
  }, [])

  const fetchSemantic = useCallback(async (q) => {
    if (!q.trim()) return []
    const params = new URLSearchParams({ q: q.trim(), n: 20 })
    const res = await fetch(`${API}/entries/search/semantic?${params}`)
    if (!res.ok) throw new Error('Semantic search failed')
    return res.json()
  }, [])

  const fetchEntries = useCallback(async (q = search, f = filter, mode = searchMode) => {
    setLoading(true)
    setError('')
    try {
      const data = (mode === 'semantic' && q.trim())
        ? await fetchSemantic(q)
        : await fetchKeyword(q, f)
      setEntries(data)
      setTotal(data.length)
    } catch {
      setError('Could not load entries -- is the backend running?')
    } finally {
      setLoading(false)
    }
  }, [search, filter, searchMode, fetchKeyword, fetchSemantic])

  // Single debounced effect covers both initial load and subsequent filter/search changes.
  // Removed the bare useEffect(() => { fetchEntries() }, []) that caused a double fetch
  // on mount: that effect fired immediately, then this one also fired (300ms later)
  // because its deps had initial values. One fetch per trigger is enough.
  useEffect(() => {
    const t = setTimeout(() => fetchEntries(search, filter, searchMode), 300)
    return () => clearTimeout(t)
  }, [search, filter, searchMode])

  useEffect(() => {
    if (!search.trim()) setSearchMode('keyword')
  }, [search])

  // ESC exits select mode
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && selectMode) exitSelectMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectMode])

  const handleStar = (id) => {
    setEntries(prev => prev.map(e =>
      e.id === id ? { ...e, starred: e.starred ? 0 : 1 } : e
    ))
    if (selected?.id === id) {
      setSelected(prev => ({ ...prev, starred: prev.starred ? 0 : 1 }))
    }
  }

  const handleDelete = (id) => {
    setEntries(prev => prev.filter(e => e.id !== id))
    setSelected(null)
  }

  // ── Select mode helpers ───────────────────────────────────────────────────

  const enterSelectMode = () => {
    setSelected(null)       // close any open detail panel
    setSelectMode(true)
    setSelectedIds(new Set())
    setShowConfirm(false)
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
    setShowConfirm(false)
  }

  const toggleSelectId = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
    setShowConfirm(false)   // hide confirm if selection changes
  }

  const selectAll = () => {
    setSelectedIds(new Set(entries.map(e => e.id)))
    setShowConfirm(false)
  }

  // ── Bulk delete ───────────────────────────────────────────────────────────

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return
    setShowConfirm(true)
  }

  const confirmBulkDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setShowConfirm(false)

    const ids = Array.from(selectedIds)

    // Animate each selected row out simultaneously
    const animPromises = ids.map(id => new Promise(resolve => {
      const el = rowRefs.current[id]
      if (el) {
        gsap.fromTo(el,
          { opacity: 1, x: 0 },
          {
            opacity: 0, x: -20, duration: 0.2, ease: 'power2.in',
            onComplete: resolve
          }
        )
      } else {
        resolve()
      }
    }))

    // Fire API call in parallel with animations
    const apiCall = fetch(`${API}/entries/bulk`, {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ids })
    }).catch(e => console.error('Bulk delete failed:', e))

    // Wait for all animations to finish, then remove from state
    await Promise.all(animPromises)
    await apiCall

    setEntries(prev => prev.filter(e => !selectedIds.has(e.id)))
    setTotal(prev => prev - ids.length)
    setDeleting(false)
    exitSelectMode()
  }

  const FILTERS = [
    { id: 'all',     label: 'ALL' },
    { id: 'daily',   label: 'ENTRIES' },
    { id: 'rant',    label: 'DUMPS' },
    { id: 'starred', label: '★ STARRED' },
  ]

  const isSemanticActive = searchMode === 'semantic' && search.trim().length > 0
  const showDistance     = isSemanticActive
  const selCount         = selectedIds.size

  return (
    <div className="lb-screen">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="lb-header">
        <div className="lb-header-left">
          <h1 className="page-title">ARCHIVE</h1>
          <span className="page-subtitle">
            {loading
              ? 'LOADING...'
              : selectMode
                ? `${selCount} OF ${total} SELECTED`
                : `${total} RECORD${total !== 1 ? 'S' : ''}${isSemanticActive ? ' — SEMANTIC' : ''}`
            }
          </span>
        </div>

        {/* Select mode controls */}
        <div className="lb-header-right">
          {!selectMode && (
            <button
              className="lb-filter-btn lb-select-btn"
              onClick={enterSelectMode}
              title="Select entries to bulk-delete"
            >
              SELECT
            </button>
          )}

          {selectMode && (
            <>
              <button
                className="lb-filter-btn"
                onClick={selectAll}
                title="Select all visible entries"
              >
                ALL
              </button>
              <button
                className="lb-bulk-delete-btn"
                onClick={handleDeleteSelected}
                disabled={selCount === 0 || deleting}
                title={`Delete ${selCount} selected entries`}
              >
                {deleting ? 'DELETING...' : `DELETE SELECTED${selCount > 0 ? ` (${selCount})` : ''}`}
              </button>
              <button
                className="lb-filter-btn lb-cancel-select-btn"
                onClick={exitSelectMode}
              >
                CANCEL
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Inline confirmation banner ──────────────────────────────────── */}
      {showConfirm && (
        <div className="lb-confirm-banner">
          <span className="lb-confirm-text">
            DELETE {selCount} ENTR{selCount === 1 ? 'Y' : 'IES'}? THIS CANNOT BE UNDONE.
          </span>
          <div className="lb-confirm-actions">
            <button className="lb-confirm-yes" onClick={confirmBulkDelete}>
              YES, DELETE
            </button>
            <button className="lb-confirm-cancel" onClick={() => setShowConfirm(false)}>
              CANCEL
            </button>
          </div>
        </div>
      )}

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div className="lb-controls">
        <div className="lb-search-row">
          <div className="lb-search-wrap">
            <span className="lb-search-icon">⌕</span>
            <input
              ref={searchRef}
              className="lb-search"
              placeholder={
                searchMode === 'semantic'
                  ? 'DESCRIBE WHAT YOU ARE LOOKING FOR...'
                  : 'SEARCH TRANSCRIPTS...'
              }
              value={search}
              onChange={e => setSearch(e.target.value)}
              spellCheck={false}
            />
            {search && (
              <button
                className="lb-search-clear"
                onClick={() => { setSearch(''); setSearchMode('keyword') }}
              >
                ✕
              </button>
            )}
          </div>

          {search.trim().length > 0 && (
            <SearchModeToggle mode={searchMode} onChange={setSearchMode} />
          )}
        </div>

        {!isSemanticActive && (
          <div className="lb-filter-row">
            {FILTERS.map(f => (
              <button
                key={f.id}
                className={`lb-filter-btn ${filter === f.id ? 'active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        {isSemanticActive && (
          <div className="lb-semantic-notice">
            Searching by meaning — finds entries related to your query even without exact word matches.
            <span className="lb-semantic-badge">SEMANTIC</span>
          </div>
        )}
      </div>

      {/* ── List ───────────────────────────────────────────────────────── */}
      <div className="lb-list">
        {loading && (
          <div className="lb-state-msg">
            <div className="lb-spinner" />
            {isSemanticActive ? 'SEARCHING BY MEANING...' : 'LOADING RECORDS...'}
          </div>
        )}

        {!loading && error && (
          <div className="lb-state-msg lb-error">{error}</div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="lb-empty">
            <div className="lb-empty-title">NO RECORDS FOUND</div>
            <div className="lb-empty-sub">
              {isSemanticActive
                ? 'No entries matched that meaning. Try different phrasing, or switch to KEYWORD mode.'
                : search || filter !== 'all'
                  ? 'Try a different search or filter.'
                  : 'Your journal entries will appear here after you record them.'}
            </div>
            {isSemanticActive && (
              <button
                className="lb-mode-fallback-btn"
                onClick={() => setSearchMode('keyword')}
              >
                SWITCH TO KEYWORD SEARCH
              </button>
            )}
          </div>
        )}

        {!loading && entries.map((entry, i) => (
          <EntryRow
            key={`${entry.type}-${entry.id}-${i}`}
            entry={entry}
            onClick={setSelected}
            showDistance={showDistance}
            selectMode={selectMode}
            selected={selectedIds.has(entry.id)}
            onToggleSelect={toggleSelectId}
            rowRef={el => { if (el) rowRefs.current[entry.id] = el }}
          />
        ))}
      </div>

      {/* ── Detail panel — suppressed in select mode ────────────────────── */}
      {selected && !selectMode && (
        <EntryDetail
          entry={selected}
          onClose={() => setSelected(null)}
          onStar={handleStar}
          onDelete={handleDelete}
        />
      )}

    </div>
  )
}
