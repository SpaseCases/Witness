/**
 * WITNESS — Journal Entry Screen (Step 16)
 *
 * Save this file at: witness/src/JournalEntry.jsx
 * Replace the existing file completely.
 *
 * What changed from Step 12:
 *   - Real-time transcription via WebSocket.
 *     As you speak, partial transcript text appears live in the editor.
 *     When you stop, the full audio is uploaded for the clean final transcript.
 *     The final version replaces the partial — you see text the whole time.
 *   - WebSocket connects on record start, disconnects on stop.
 *   - Partial text appears in the transcript box with a blinking cursor indicator.
 *   - If the WebSocket fails (backend unreachable), recording still works —
 *     it falls back silently to the existing batch-upload-only flow.
 *   - All other behavior (questions, metrics, save, star) is unchanged.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { fetchWithRetry } from './fetchWithRetry'

const API    = 'http://127.0.0.1:8000'
const WS_URL = 'ws://127.0.0.1:8000/transcribe/stream'

// ─── WAVEFORM VISUALIZER ──────────────────────────────────────────────────────

function WaveformCanvas({ analyser, isRecording, isPaused }) {
  const canvasRef = useRef(null)
  const animRef   = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    const resize = () => {
      canvas.width  = canvas.offsetWidth  * window.devicePixelRatio
      canvas.height = canvas.offsetHeight * window.devicePixelRatio
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const W = () => canvas.offsetWidth
    const H = () => canvas.offsetHeight

    const drawIdle = () => {
      ctx.clearRect(0, 0, W(), H())
      const now  = Date.now() / 1000
      const mid  = H() / 2
      const bars = 80
      for (let i = 0; i < bars; i++) {
        const x      = (i / bars) * W()
        const noise  = Math.sin(now * 0.8 + i * 0.3) * 1.5
        const height = 2 + noise
        ctx.fillStyle = 'rgba(96, 96, 96, 0.4)'
        ctx.fillRect(x, mid - height / 2, W() / bars - 1, height)
      }
    }

    const drawActive = () => {
      if (!analyser) return
      const bufferLength = analyser.frequencyBinCount
      const dataArray    = new Uint8Array(bufferLength)
      analyser.getByteFrequencyData(dataArray)
      ctx.clearRect(0, 0, W(), H())
      const mid  = H() / 2
      const bars = 80
      const step = Math.floor(bufferLength / bars)
      const barW = W() / bars - 1
      for (let i = 0; i < bars; i++) {
        let sum = 0
        for (let j = 0; j < step; j++) sum += dataArray[i * step + j]
        const avg    = sum / step
        const height = Math.max(2, (avg / 255) * H() * 0.85)
        const x      = i * (barW + 1)
        ctx.fillStyle = `rgba(245, 168, 48, ${0.5 + (avg / 255) * 0.5})`
        ctx.fillRect(x, mid - height / 2, barW, height)
      }
    }

    const loop = () => {
      if (isRecording && !isPaused && analyser) drawActive()
      else drawIdle()
      animRef.current = requestAnimationFrame(loop)
    }

    animRef.current = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(animRef.current)
      ro.disconnect()
    }
  }, [analyser, isRecording, isPaused])

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}

// ─── TIMER ────────────────────────────────────────────────────────────────────

function RecordTimer({ seconds, isRecording }) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  return (
    <div className="record-timer">
      <span className={`timer-display ${isRecording ? 'timer-active' : ''}`}>{m}:{s}</span>
      {isRecording && <div className="timer-pip" />}
    </div>
  )
}

// ─── STATUS LINE ──────────────────────────────────────────────────────────────

function StatusLine({ status, isLive }) {
  const STATUS_COPY = {
    idle:         'READY TO RECORD',
    recording:    isLive ? 'RECORDING — TRANSCRIBING LIVE' : 'RECORDING — SPEAK FREELY',
    paused:       'PAUSED',
    transcribing: 'FINALIZING TRANSCRIPT...',
    generating:   'GENERATING FOLLOW-UP QUESTIONS...',
    done:         'ENTRY READY TO SAVE',
    saving:       'SAVING...',
    saved:        'ENTRY SAVED',
    error:        'ERROR — SEE MESSAGE BELOW'
  }
  return (
    <div className={`status-line status-${status}`}>
      <span>{STATUS_COPY[status] ?? status.toUpperCase()}</span>
      {isLive && status === 'recording' && <span className="status-live-badge">LIVE</span>}
    </div>
  )
}

// ─── FOLLOW-UP QUESTION CARD ──────────────────────────────────────────────────

function QuestionCard({ question, index, answer, onChange }) {
  return (
    <div className="qa-card">
      <div className="qa-q">
        <span className="qa-num">0{index + 1}</span>
        <span className="qa-text">{question}</span>
      </div>
      <textarea
        className="qa-answer"
        placeholder="TYPE YOUR ANSWER (OPTIONAL)"
        value={answer}
        onChange={e => onChange(e.target.value)}
        rows={3}
      />
    </div>
  )
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export default function JournalEntry({ onSaved }) {
  const [status,      setStatus]      = useState('idle')
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused,    setIsPaused]    = useState(false)
  const [seconds,     setSeconds]     = useState(0)
  const [errorMsg,    setErrorMsg]    = useState('')
  const [transcript,  setTranscript]  = useState('')
  const [isPartial,   setIsPartial]   = useState(false)   // true while live partial text is shown
  const [isLive,      setIsLive]      = useState(false)   // true if WebSocket connected OK
  const [questions,   setQuestions]   = useState([])
  const [answers,     setAnswers]     = useState({})
  const [starred,     setStarred]     = useState(false)

  const mediaRecorderRef = useRef(null)
  const audioContextRef  = useRef(null)
  const analyserRef      = useRef(null)
  const chunksRef        = useRef([])
  const timerRef         = useRef(null)
  const savedEntryIdRef  = useRef(null)
  const waveformRef      = useRef(null)
  const wsRef            = useRef(null)           // WebSocket reference

  // ── Timer ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isRecording && !isPaused) {
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [isRecording, isPaused])

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      wsRef.current?.close()
      if (audioContextRef.current?.state !== 'closed') {
        audioContextRef.current?.close()
      }
      clearInterval(timerRef.current)
    }
  }, [])

  // ─── Open WebSocket for live partials ─────────────────────────────────────
  // Called right before recording starts. If it fails, we just don't show
  // live partials — the batch upload at the end still works fine.

  const openWebSocket = useCallback(() => {
    try {
      const ws = new WebSocket(WS_URL)

      ws.onopen = () => {
        setIsLive(true)
        wsRef.current = ws
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'partial' && msg.text) {
            // Show the live partial text while still recording
            setTranscript(msg.text)
            setIsPartial(true)
          }
        } catch {
          // Ignore malformed messages
        }
      }

      ws.onerror = () => {
        // WebSocket failed — fall back to batch-only, no live partials
        setIsLive(false)
        wsRef.current = null
      }

      ws.onclose = () => {
        setIsLive(false)
        wsRef.current = null
      }

    } catch {
      // WebSocket not supported or connection refused — ignore
      setIsLive(false)
    }
  }, [])

  // ─── Start recording ──────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    setErrorMsg('')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

      const audioCtx = new AudioContext()
      const source   = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      audioContextRef.current = audioCtx
      analyserRef.current     = analyser

      chunksRef.current = []

      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
      })

      recorder.ondataavailable = e => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data)

          // Forward each audio chunk to the WebSocket for live transcription
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            e.data.arrayBuffer().then(buf => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(buf)
              }
            }).catch(() => {})
          }
        }
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        audioCtx.close()
        analyserRef.current = null

        // Close the WebSocket — tell the backend recording is done
        if (wsRef.current) {
          wsRef.current.close()
          wsRef.current = null
        }

        await handleRecordingComplete()
      }

      // Collect a chunk every 500ms — feeds the WebSocket smoothly
      recorder.start(500)
      mediaRecorderRef.current = recorder

      // Open the WebSocket in parallel with the recording starting
      openWebSocket()

      setIsRecording(true)
      setIsPaused(false)
      setStatus('recording')
      setSeconds(0)
      setTranscript('')
      setIsPartial(false)
      setQuestions([])
      setAnswers({})

      waveformRef.current?.classList.add('recording-active')

    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Microphone access denied. Check Windows privacy settings.'
        : `Microphone error: ${err.message}`
      setErrorMsg(msg)
      setStatus('error')
    }
  }, [openWebSocket])

  // ─── Stop recording ───────────────────────────────────────────────────────

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      setIsPaused(false)
      setStatus('transcribing')
      waveformRef.current?.classList.remove('recording-active')
    }
  }, [isRecording])

  // ─── Pause / resume ───────────────────────────────────────────────────────

  const togglePause = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder) return
    if (isPaused) {
      recorder.resume()
      setIsPaused(false)
      setStatus('recording')
    } else {
      recorder.pause()
      setIsPaused(true)
      setStatus('paused')
    }
  }, [isPaused])

  // ─── Handle complete recording (batch upload for final clean transcript) ──

  const handleRecordingComplete = useCallback(async () => {
    const chunks = chunksRef.current
    if (!chunks.length) { setStatus('idle'); return }

    setStatus('transcribing')

    try {
      const blob     = new Blob(chunks, { type: 'audio/webm' })
      const formData = new FormData()
      formData.append('file', blob, 'recording.webm')

      const res = await fetchWithRetry(`${API}/transcribe/upload`, {
        method: 'POST',
        body:   formData
      })

      if (!res.ok) throw new Error(`Backend returned ${res.status}`)
      const data = await res.json()
      const text = data.transcript || ''

      // Replace partial live text with the clean final version
      setTranscript(text)
      setIsPartial(false)

      if (text.length > 30) {
        setStatus('generating')
        await fetchQuestions(text)
      } else {
        setStatus('done')
      }

    } catch (err) {
      setErrorMsg(`Transcription failed: ${err.message}. Is the Python backend running?`)
      setStatus('error')
    }
  }, [])

  // ─── Fetch AI questions ───────────────────────────────────────────────────

  const fetchQuestions = useCallback(async (text) => {
    try {
      const res = await fetch(`${API}/transcribe/questions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transcript: text, count: 3 })
      })
      if (!res.ok) throw new Error(`Questions API returned ${res.status}`)
      const data = await res.json()
      setQuestions(data.questions || [])
      setStatus('done')
    } catch (err) {
      console.warn('Question generation failed:', err.message)
      setStatus('done')
    }
  }, [])

  // ─── Save entry ───────────────────────────────────────────────────────────

  const saveEntry = useCallback(async () => {
    if (!transcript.trim()) return
    setStatus('saving')

    try {
      const today = new Date().toISOString().slice(0, 10)

      const entryRes = await fetch(`${API}/entries/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ date: today, type: 'daily', transcript })
      })
      if (!entryRes.ok) throw new Error(`Save failed: ${entryRes.status}`)
      const entryData = await entryRes.json()
      const entryId   = entryData.id
      savedEntryIdRef.current = entryId

      if (starred) {
        await fetch(`${API}/entries/${entryId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ starred: true })
        })
      }

      for (let i = 0; i < questions.length; i++) {
        const answer = answers[i] || ''
        if (answer.trim()) {
          await fetch(`${API}/entries/${entryId}/qa`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ question: questions[i], answer })
          })
        }
      }

      // Fire-and-forget metric extraction (correct route + body)
      fetch(`${API}/transcribe/extract-metrics`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transcript, entry_id: entryId })
      }).catch(e => console.warn('Metrics failed:', e.message))

      // Fire-and-forget ChromaDB embed for semantic search
      fetch(`${API}/transcribe/embed`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entry_id: entryId, transcript, entry_date: today })
      }).catch(() => {})

      // Fire-and-forget good/bad day tagging
      fetch(`${API}/transcribe/tag-day`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transcript, entry_id: entryId })
      }).catch(() => {})

      // Fire-and-forget AI todo extraction (populates Tasks screen)
      fetch(`${API}/transcribe/extract-todos`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transcript, entry_id: entryId, entry_date: today })
      }).catch(() => {})

      setStatus('saved')
      setTimeout(() => { if (onSaved) onSaved(entryId) }, 1800)

    } catch (err) {
      setErrorMsg(`Save failed: ${err.message}`)
      setStatus('error')
    }
  }, [transcript, questions, answers, starred, onSaved])

  // ─── Reset ────────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    if (isRecording) stopRecording()
    wsRef.current?.close()
    setStatus('idle')
    setIsRecording(false)
    setIsPaused(false)
    setSeconds(0)
    setTranscript('')
    setIsPartial(false)
    setIsLive(false)
    setQuestions([])
    setAnswers({})
    setStarred(false)
    setErrorMsg('')
    chunksRef.current = []
  }, [isRecording, stopRecording])

  // ─── RENDER ───────────────────────────────────────────────────────────────

  const canRecord = status === 'idle'
  const isWorking = status === 'transcribing' || status === 'generating' || status === 'saving'

  return (
    <div className="journal-entry">

      <div className="je-header page-header">
        <div className="page-header-left">
          <h1 className="page-title">RECORD</h1>
          <span className="page-subtitle">
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            }).toUpperCase()}
          </span>
        </div>
        <div className="page-header-right" style={{ flexDirection: 'row', gap: '10px', alignItems: 'center' }}>
          <RecordTimer seconds={seconds} isRecording={isRecording} />
          {(status === 'done' || transcript) && (
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

      <div className="je-body">

        {/* WAVEFORM */}
        <div className="je-waveform-block" ref={waveformRef}>
          <WaveformCanvas
            analyser={analyserRef.current}
            isRecording={isRecording}
            isPaused={isPaused}
          />
          <StatusLine status={status} isLive={isLive} />
        </div>

        {/* CONTROLS */}
        <div className="je-controls">
          {canRecord && (
            <button className="je-btn je-btn-record" onClick={startRecording}>
              <span className="je-btn-icon">⬤</span>
              <span>BEGIN ENTRY</span>
            </button>
          )}
          {isRecording && (
            <>
              <button className="je-btn je-btn-pause" onClick={togglePause}>
                {isPaused ? '▶ RESUME' : '⏸ PAUSE'}
              </button>
              <button className="je-btn je-btn-stop" onClick={stopRecording}>
                <span className="je-btn-icon">■</span>
                <span>STOP + TRANSCRIBE</span>
              </button>
            </>
          )}
          {isWorking && (
            <div className="je-working">
              <div className="working-spinner" />
              <span>{
                status === 'transcribing' ? 'FINALIZING TRANSCRIPT...' :
                status === 'generating'   ? 'AI GENERATING QUESTIONS...' :
                'SAVING...'
              }</span>
            </div>
          )}
        </div>

        {/* ERROR */}
        {errorMsg && (
          <div className="je-error">
            <span className="je-error-label">ERROR</span>
            <span>{errorMsg}</span>
          </div>
        )}

        {/* TRANSCRIPT — shows live partial text while recording, then final */}
        {(transcript || isRecording) && (
          <div className="je-transcript-block">
            <div className="je-section-label">
              TRANSCRIPT
              {isPartial && isRecording && (
                <span className="transcript-live-tag">LIVE</span>
              )}
            </div>
            {isPartial && isRecording && !transcript && (
              <div className="transcript-waiting">LISTENING...</div>
            )}
            <textarea
              className={`je-transcript-editor ${isPartial ? 'transcript-partial' : ''}`}
              value={transcript}
              onChange={e => !isRecording && setTranscript(e.target.value)}
              readOnly={isRecording}
              rows={8}
              placeholder={isRecording ? 'Transcript will appear as you speak...' : ''}
            />
            {!isRecording && transcript && (
              <div className="je-transcript-hint">EDIT IF THE AI MISHEARD ANYTHING</div>
            )}
          </div>
        )}

        {/* FOLLOW-UP QUESTIONS */}
        {questions.length > 0 && (
          <div className="je-questions-block">
            <div className="je-section-label">FOLLOW-UP QUESTIONS</div>
            <div className="je-section-sub">
              AI NOTICED THESE — ANSWER WHAT'S USEFUL, SKIP WHAT ISN'T
            </div>
            <div className="qa-list">
              {questions.map((q, i) => (
                <QuestionCard
                  key={i}
                  index={i}
                  question={q}
                  answer={answers[i] || ''}
                  onChange={val => setAnswers(prev => ({ ...prev, [i]: val }))}
                />
              ))}
            </div>
          </div>
        )}

        {/* SAVE ROW */}
        {status === 'done' && transcript && (
          <div className="je-save-row">
            <button className="je-btn je-btn-save" onClick={saveEntry}>SAVE ENTRY</button>
            <button className="je-btn-ghost" onClick={reset}>DISCARD</button>
          </div>
        )}

        {/* SAVED CONFIRMATION */}
        {status === 'saved' && (
          <div className="save-confirm">
            <span className="save-confirm-icon">✓</span>
            <span className="save-confirm-text">ENTRY SAVED</span>
          </div>
        )}

        {/* ERROR RECOVERY */}
        {status === 'error' && (
          <div className="je-save-row">
            <button className="je-btn-ghost" onClick={reset}>START OVER</button>
            {transcript && (
              <button className="je-btn je-btn-save" onClick={saveEntry}>
                SAVE ANYWAY (NO AI METRICS)
              </button>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
