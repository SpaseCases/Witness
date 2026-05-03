/**
 * WITNESS -- Write Mode
 *
 * Save this file at: witness/src/WriteMode.jsx
 *
 * A plain-text journal entry mode. No audio, no recording.
 * The user types their entry and saves it. On save it runs through
 * the exact same backend analysis pipeline as a voice entry:
 * metrics extraction, ChromaDB embedding, structured summary,
 * good/bad day tagging, todo extraction, and context update.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import './styles/write-mode.css'

const API = 'http://127.0.0.1:8000'

// Minimum characters before the save button enables and analysis runs.
// Mirrors the questions threshold so analysis is always meaningful.
const MIN_LENGTH = 80

export default function WriteMode({ onSaved }) {
  const [text,       setText]       = useState('')
  const [status,     setStatus]     = useState('idle')   // idle | saving | saved | error
  const [errorMsg,   setErrorMsg]   = useState('')
  const [starred,    setStarred]    = useState(false)
  const [charCount,  setCharCount]  = useState(0)

  const textareaRef    = useRef(null)
  const savedEntryRef  = useRef(null)

  // Focus the textarea on mount
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleChange = useCallback((e) => {
    setText(e.target.value)
    setCharCount(e.target.value.length)
  }, [])

  // ─── Save ───────────────────────────────────────────────────────────────────

  const saveEntry = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || trimmed.length < MIN_LENGTH) return
    setStatus('saving')
    setErrorMsg('')

    try {
      const today = new Date().toISOString().slice(0, 10)

      // Save the entry to SQLite
      const entryRes = await fetch(`${API}/entries/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ date: today, type: 'write', transcript: trimmed })
      })
      if (!entryRes.ok) throw new Error(`Save failed: ${entryRes.status}`)
      const entryData = await entryRes.json()
      const entryId   = entryData.id
      savedEntryRef.current = entryId

      // Star if flagged
      if (starred) {
        await fetch(`${API}/entries/${entryId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ starred: true })
        })
      }

      // Fire-and-forget pipeline — identical to voice entry
      const ff = (url, body) => fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body)
      }).catch(e => console.warn(`[WITNESS] ${url} failed:`, e.message))

      ff(`${API}/transcribe/extract-metrics`, { transcript: trimmed, entry_id: entryId })
      ff(`${API}/transcribe/embed`,            { entry_id: entryId, transcript: trimmed, entry_date: today })
      ff(`${API}/transcribe/summarize`,         { transcript: trimmed, entry_id: entryId })
      ff(`${API}/transcribe/tag-day`,           { transcript: trimmed, entry_id: entryId })
      ff(`${API}/transcribe/extract-todos`,     { transcript: trimmed, entry_id: entryId, entry_date: today })
      ff(`${API}/transcribe/update-memory`,     { transcript: trimmed, entry_type: 'write' })

      setStatus('saved')
      setTimeout(() => { if (onSaved) onSaved(entryId) }, 1800)

    } catch (err) {
      setErrorMsg(`Save failed: ${err.message}`)
      setStatus('error')
    }
  }, [text, starred, onSaved])

  // ─── Reset ──────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setText('')
    setCharCount(0)
    setStatus('idle')
    setStarred(false)
    setErrorMsg('')
    setTimeout(() => textareaRef.current?.focus(), 50)
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────────────

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).toUpperCase()

  const canSave  = charCount >= MIN_LENGTH && status === 'idle'
  const isSaving = status === 'saving'
  const isSaved  = status === 'saved'

  return (
    <div className="write-screen">

      {/* Header */}
      <div className="write-header page-header">
        <div className="page-header-left">
          <h1 className="page-title">WRITE</h1>
          <span className="page-subtitle">{today}</span>
        </div>
        <div className="page-header-right" style={{ flexDirection: 'row', gap: '10px', alignItems: 'center' }}>
          {charCount > 0 && (
            <button
              className={`star-btn ${starred ? 'starred' : ''}`}
              onClick={() => setStarred(s => !s)}
              title="Star this entry"
            >
              {starred ? '★' : '☆'}
            </button>
          )}
        </div>
      </div>

      {/* Intro line */}
      {charCount === 0 && status === 'idle' && (
        <div className="write-intro">
          TYPE YOUR ENTRY. NO WORD LIMIT. AI ANALYZES WHEN YOU SAVE.
        </div>
      )}

      {/* Main textarea */}
      <div className="write-editor-block">
        <textarea
          ref={textareaRef}
          className="write-editor"
          value={text}
          onChange={handleChange}
          placeholder="Start writing..."
          disabled={isSaving || isSaved}
          spellCheck={true}
          lang="en"
        />
        <div className="write-char-row">
          <span className={`write-char-count ${charCount < MIN_LENGTH ? 'write-char-low' : ''}`}>
            {charCount} CHARS
            {charCount < MIN_LENGTH && charCount > 0 && (
              <span className="write-char-min"> — {MIN_LENGTH - charCount} MORE TO ENABLE SAVE</span>
            )}
          </span>
        </div>
      </div>

      {/* Error */}
      {errorMsg && (
        <div className="write-error">
          <span className="write-error-label">ERROR</span>
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Controls */}
      {status === 'idle' && (
        <div className="write-controls">
          <button
            className="write-save-btn"
            onClick={saveEntry}
            disabled={!canSave}
          >
            SAVE ENTRY
          </button>
          {charCount > 0 && (
            <button className="write-discard-btn" onClick={reset}>
              DISCARD
            </button>
          )}
        </div>
      )}

      {isSaving && (
        <div className="write-saving-row">
          <div className="write-spinner" />
          <span>SAVING + ANALYZING...</span>
        </div>
      )}

      {isSaved && (
        <div className="write-saved-confirm">
          <span className="write-saved-icon">✓</span>
          <span className="write-saved-text">ENTRY SAVED</span>
        </div>
      )}

      {status === 'error' && (
        <div className="write-controls">
          <button className="write-save-btn" onClick={saveEntry} disabled={!canSave}>
            RETRY SAVE
          </button>
          <button className="write-discard-btn" onClick={reset}>
            DISCARD
          </button>
        </div>
      )}

    </div>
  )
}
