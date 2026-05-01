import { useState, useEffect, useRef, useCallback } from 'react'
import { gsap } from 'gsap'
import { fetchWithRetry } from './fetchWithRetry'

const BACKEND = 'http://127.0.0.1:8000'

// ─── WAVEFORM ─────────────────────────────────────────────────────────────────

function Waveform({ analyser, isRecording }) {
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)

  useEffect(() => {
    if (!isRecording || !analyser) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      return
    }

    const canvas  = canvasRef.current
    const ctx     = canvas.getContext('2d')
    const bufLen  = analyser.frequencyBinCount
    const dataArr = new Uint8Array(bufLen)
    const BAR_COUNT = 48

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArr)
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const barW = canvas.width / BAR_COUNT
      for (let i = 0; i < BAR_COUNT; i++) {
        const idx = Math.floor((i / BAR_COUNT) * bufLen * 0.6)
        const val = dataArr[idx] / 255
        const h   = Math.max(4, val * canvas.height * 0.85)
        const x   = i * barW + barW * 0.15

        const r = Math.floor(220 + val * 35)
        const g = Math.floor(60 + val * 40)
        const b = 50
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(x, (canvas.height - h) / 2, barW * 0.7, h)
      }
    }
    draw()
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [isRecording, analyser])

  return (
    <canvas
      ref={canvasRef}
      className="rant-waveform-canvas"
      width={600}
      height={100}
    />
  )
}

// ─── TAG CHIP ─────────────────────────────────────────────────────────────────

function TagChip({ tag }) {
  const chipRef = useRef(null)
  useEffect(() => {
    requestAnimationFrame(() => {
      gsap.fromTo(chipRef.current,
        { scale: 0.5, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(1.7)" })
    })
  }, [])
  return <span className="rant-tag-chip" ref={chipRef}>{tag}</span>
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────
// backendReady: passed from App.jsx — true once the Python backend is confirmed up.
// The mount-time ping is gated on this so we never fire a fetch before the
// backend process has started (avoids red console errors during the boot splash).

export default function RantMode({ onSaved, backendReady }) {
  const [phase, setPhase]           = useState('idle')
  const [timer, setTimer]           = useState(0)
  const [transcript, setTranscript] = useState('')
  const [tags, setTags]             = useState([])
  const [saveStatus, setSaveStatus] = useState('')
  const [analyser, setAnalyser]     = useState(null)
  const [backendOk, setBackendOk]   = useState(null)

  const mediaRecRef  = useRef(null)
  const chunksRef    = useRef([])
  const streamRef    = useRef(null)
  const timerRef     = useRef(null)
  const audioCtxRef  = useRef(null)

  // ── Backend ping ─────────────────────────────────────────────────────────────
  // Only runs after the backend is confirmed ready — avoids fetch errors during
  // the boot splash window when the Python process hasn't started yet.
  useEffect(() => {
    if (!backendReady) return
    fetch(`${BACKEND}/`)
      .then(r => setBackendOk(r.ok))
      .catch(() => setBackendOk(false))
  }, [backendReady])

  // ── Timer ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phase === 'recording') {
      timerRef.current = setInterval(() => setTimer(t => t + 1), 1000)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [phase])

  // ── Cleanup on unmount ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearInterval(timerRef.current)
      if (audioCtxRef.current?.state !== 'closed') {
        audioCtxRef.current?.close()
      }
    }
  }, [])

  const fmtTime = s =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  // ── Start recording ──────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioCtx  = new AudioContext()
      const source    = audioCtx.createMediaStreamSource(stream)
      const anlsr     = audioCtx.createAnalyser()
      anlsr.fftSize   = 256
      source.connect(anlsr)
      audioCtxRef.current = audioCtx
      setAnalyser(anlsr)

      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.start()
      mediaRecRef.current = rec

      setPhase('recording')
      setTimer(0)
    } catch {
      alert('Microphone access denied. Enable it in Windows Settings > Privacy & Security > Microphone.')
    }
  }, [])

  // ── Stop + transcribe ────────────────────────────────────────────────────────
  const stopAndProcess = useCallback(async () => {
    if (!mediaRecRef.current) return
    setPhase('processing')

    await new Promise(resolve => {
      mediaRecRef.current.onstop = resolve
      mediaRecRef.current.stop()
    })

    streamRef.current?.getTracks().forEach(t => t.stop())
    if (audioCtxRef.current?.state !== 'closed') {
      audioCtxRef.current?.close()
    }
    setAnalyser(null)

    const blob     = new Blob(chunksRef.current, { type: 'audio/webm' })
    const formData = new FormData()
    formData.append('file', blob, 'rant.webm')

    try {
      const txRes = await fetchWithRetry(`${BACKEND}/transcribe/upload`, {
        method: 'POST',
        body: formData
      })
      if (!txRes.ok) throw new Error('Transcription failed')
      const txData = await txRes.json()
      const text   = txData.transcript || ''
      setTranscript(text)

      // Tag extraction — optional, non-blocking
      if (text.trim()) {
        try {
          const tagRes = await fetch(`${BACKEND}/rant/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript: text })
          })
          if (tagRes.ok) {
            const tagData = await tagRes.json()
            setTags(tagData.tags || [])
          }
        } catch (_) { /* tags are optional */ }
      }

      setPhase('done')
    } catch {
      setTranscript('[Transcription failed — is the Python backend running?]')
      setPhase('done')
    }
  }, [])

  // ── Save ──────────────────────────────────────────────────────────────────────
  const saveRant = useCallback(async () => {
    if (!transcript.trim()) return
    setSaveStatus('saving')

    try {
      const res = await fetch(`${BACKEND}/rant/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, tags })
      })
      if (!res.ok) throw new Error('Save failed')
      setSaveStatus('saved')
      setTimeout(() => onSaved?.(), 2000)
    } catch {
      setSaveStatus('error')
    }
  }, [transcript, tags, onSaved])

  // ── Discard ───────────────────────────────────────────────────────────────────
  const discard = () => {
    setPhase('idle')
    setTimer(0)
    setTranscript('')
    setTags([])
    setSaveStatus('')
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="rant-screen">
      <div className="rant-header">
        <div className="page-header-left">
          <h1 className="page-title">DUMP</h1>
          <span className="page-subtitle">RANT MODE — UNSTRUCTURED INTELLIGENCE</span>
        </div>
        {backendOk === false && (
          <div className="rant-backend-warn">⚠ BACKEND OFFLINE — transcription unavailable</div>
        )}
      </div>

      <div className="rant-body">

        {phase === 'idle' && (
          <div className="rant-intro-block">
            <div className="rant-intro-text">
              No structure. No daily entry. No format.<br />
              Say anything — past experiences, relationships, opinions, memories, backstory.<br />
              AI tags it by topic and builds a richer picture of who you are over time.
            </div>
          </div>
        )}

        <div className={`rant-recorder-block ${phase === 'recording' ? 'active' : ''}`}>
          <div className="rant-timer">{fmtTime(timer)}</div>
          <div className="rant-waveform-wrap">
            <Waveform analyser={analyser} isRecording={phase === 'recording'} />
            {phase !== 'recording' && (
              <div className="rant-waveform-idle">
                {phase === 'idle'       ? '— IDLE —'       :
                 phase === 'processing' ? 'PROCESSING...'  : '— DONE —'}
              </div>
            )}
          </div>
        </div>

        <div className="rant-controls">
          {phase === 'idle' && (
            <button className="rant-begin-btn" onClick={startRecording}>
              <span className="rant-begin-icon">⬤</span> BEGIN RANT
            </button>
          )}
          {phase === 'recording' && (
            <button className="rant-stop-btn" onClick={stopAndProcess}>
              ■ STOP + TRANSCRIBE
            </button>
          )}
          {phase === 'processing' && (
            <div className="rant-processing-row">
              <div className="rant-spinner" />
              <span>Transcribing — this may take 15–40 seconds</span>
            </div>
          )}
        </div>

        {phase === 'done' && (
          <div className="rant-result-block">
            <div className="rant-result-label">TRANSCRIPT</div>
            <textarea
              className="rant-transcript-box"
              value={transcript}
              onChange={e => setTranscript(e.target.value)}
              spellCheck={false}
            />

            {tags.length > 0 && (
              <div className="rant-tags-block">
                <div className="rant-tags-label">AI TOPICS DETECTED</div>
                <div className="rant-tags-row">
                  {tags.map((t, i) => <TagChip key={i} tag={t} />)}
                </div>
              </div>
            )}

            <div className="rant-action-row">
              <button className="rant-discard-btn" onClick={discard}>DISCARD</button>
              <button
                className={`rant-save-btn ${saveStatus}`}
                onClick={saveRant}
                disabled={saveStatus === 'saving' || saveStatus === 'saved'}
              >
                {saveStatus === ''       && 'SAVE TO LOG'}
                {saveStatus === 'saving' && 'SAVING...'}
                {saveStatus === 'saved'  && '✓ SAVED'}
                {saveStatus === 'error'  && '✗ RETRY'}
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
