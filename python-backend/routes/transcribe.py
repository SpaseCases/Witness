# Bug fix: beam_size split (base=1 greedy, turbo=5); condition_on_previous_text
#          split (base=False, turbo=True); temperature corrections per task table
#          (todos 0.1, questions 0.7, metrics 0.1, tag-day 0.1, context extract 0.15,
#          summary 0.1); fmt="json" added to all JSON-returning generate() calls;
#          safe_send now sets connected=False on exception to stop retry loop.
"""
WITNESS -- Transcription + AI Follow-Up API
# Updated: Two-model architecture — base model for live WebSocket partials,
#           large-v3-turbo for final upload. Both models use _detect_device()
#           instead of hardcoded "cpu". Turbo model pre-loads at startup in a
#           background thread via preload_turbo(). WebSocket now sends live
#           partials immediately (every 6 chunks) from the base model.

Endpoints:
  POST /transcribe/upload          -- transcribe a complete audio file (turbo model)
  POST /transcribe/questions       -- generate AI follow-up questions from transcript
  POST /transcribe/extract-metrics -- extract mood/stress scores from transcript
  POST /transcribe/embed           -- embed a saved entry into ChromaDB (call after save)
  WS   /transcribe/stream          -- real-time streaming transcription (base model)
"""

import asyncio
import logging
import os
import re
import tempfile
import json
import threading
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from pydantic import BaseModel
from ollama_manager import clean_llm_json

log    = logging.getLogger("witness.transcribe")
router = APIRouter()


# ─── GLOBALS: Two separate model slots ───────────────────────────────────────

_base_model  = None          # WhisperModel("base")  — live WebSocket partials
_turbo_model = None          # WhisperModel("large-v3-turbo") — final /upload transcript
_turbo_ready = threading.Event()   # set() when turbo model has finished loading


# ─── DEVICE AUTO-DETECTION ───────────────────────────────────────────────────

def _detect_device() -> str:
    """
    Try CUDA (Nvidia), fall back to CPU.
    ROCm on Windows does not support RX 6000 series, so AMD users land on CPU.
    Code stays device-agnostic so it works unchanged for Nvidia or RX 7000 users.
    """
    try:
        import torch
        if torch.cuda.is_available():
            log.info("Whisper device: CUDA detected.")
            return "cuda"
    except ImportError:
        pass
    log.info("Whisper device: falling back to CPU.")
    return "cpu"


# ─── MODEL LOADERS ────────────────────────────────────────────────────────────

def get_base() -> "WhisperModel":
    """
    Return the base model, loading it on first call (~1-2 seconds).
    Used exclusively by the WebSocket for live partial transcription.
    """
    global _base_model
    if _base_model is None:
        from faster_whisper import WhisperModel
        device = _detect_device()
        log.info(f"Loading Whisper base model on {device}...")
        _base_model = WhisperModel("base", device=device, compute_type="int8")
        log.info("Whisper base model ready.")
    return _base_model


def get_turbo() -> "WhisperModel":
    """
    Return the large-v3-turbo model, loading it if necessary.
    Used exclusively by POST /upload for the clean final transcript.
    Normally pre-loaded at startup by preload_turbo() so this is instant.
    """
    global _turbo_model
    if _turbo_model is None:
        from faster_whisper import WhisperModel
        device = _detect_device()
        log.info(f"Loading Whisper large-v3-turbo on {device} (lazy load)...")
        _turbo_model = WhisperModel("large-v3-turbo", device=device, compute_type="int8")
        _turbo_ready.set()
        log.info("Whisper large-v3-turbo ready (lazy).")
    return _turbo_model


def preload_turbo():
    """
    Pre-load the turbo model in a background thread at startup.
    Called from main.py lifespan — does not block app startup.
    Sets _turbo_ready when done so the WebSocket can inform the frontend.
    """
    global _turbo_model
    try:
        from faster_whisper import WhisperModel
        device = _detect_device()
        log.info(f"Preloading Whisper large-v3-turbo on {device}...")
        _turbo_model = WhisperModel("large-v3-turbo", device=device, compute_type="int8")
        _turbo_ready.set()
        log.info("Whisper large-v3-turbo preload complete.")
    except Exception as e:
        log.warning(f"Turbo preload failed ({e}) — will load on first /upload call.")


# ─── AUDIO TRANSCRIPTION HELPERS ─────────────────────────────────────────────

def _run_transcription_base(model, audio_bytes: bytes, language: str = "en") -> dict:
    """
    Live-preview transcription using the base model.
    beam_size=1 (greedy) for speed. condition_on_previous_text=False to
    prevent hallucination loops on repeated partials.
    vad_filter=True prevents hallucinations on silence segments.
    """
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=1,                        # greedy — fast for live preview
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,   # prevents hallucination loops in live mode
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        log.info(f"Base partial transcribed {info.duration:.1f}s — {len(text)} chars")
        return {"transcript": text, "duration": round(info.duration, 1), "language": info.language}
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def _run_transcription_turbo(model, audio_bytes: bytes, language: str = "en") -> dict:
    """
    Final accurate transcription using the turbo model.
    beam_size=5 for accuracy. condition_on_previous_text=True for coherent
    multi-segment transcription. vad_filter=True to skip silence.
    """
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,                        # standard accuracy beam
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=True,    # improves coherence across segments
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        log.info(f"Turbo transcribed {info.duration:.1f}s — {len(text)} chars, lang={info.language}")
        return {"transcript": text, "duration": round(info.duration, 1), "language": info.language}
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


def transcribe_audio_file(audio_bytes: bytes, language: str = "en") -> dict:
    """Final transcript — always uses the turbo model with accuracy settings."""
    return _run_transcription_turbo(get_turbo(), audio_bytes, language)


def transcribe_audio_partial(audio_bytes: bytes) -> dict:
    """Live preview partial — always uses the base model with speed settings."""
    return _run_transcription_base(get_base(), audio_bytes)


# ─── REST: Upload and transcribe ─────────────────────────────────────────────

@router.post("/upload")
async def transcribe_upload(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        if len(audio_bytes) < 1000:
            return {"transcript": "", "duration": 0, "status": "too_short"}
        result = await asyncio.to_thread(transcribe_audio_file, audio_bytes)

        transcript_text = result.get("transcript", "")
        if transcript_text.strip():
            start_context_update(transcript_text, entry_type='daily')
            from routes.memory import start_memory_update
            start_memory_update(transcript_text, entry_type='daily')

        return {**result, "status": "ok"}
    except Exception as e:
        log.error(f"Transcription upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


# ─── REST: Trigger todo extraction after entry is saved ──────────────────────

class TodoExtractRequest(BaseModel):
    transcript:  str
    entry_id:    int
    entry_date:  str   # e.g. "2025-04-28"


@router.post("/extract-todos")
async def extract_todos_endpoint(body: TodoExtractRequest):
    """
    Fire-and-forget: launch AI todo extraction in a background thread.
    Returns immediately. Todos appear in the list within ~10-30 seconds.
    """
    if not body.transcript or len(body.transcript.strip()) < 30:
        return {"status": "skipped", "reason": "transcript too short"}

    t = threading.Thread(
        target=_extract_todos_background,
        args=(body.transcript, body.entry_id, body.entry_date),
        daemon=True
    )
    t.start()
    return {"status": "extraction_started"}


# ─── BACKGROUND: Extract todos from transcript ───────────────────────────────

_TODO_EXTRACT_PROMPT = """You are analyzing a private journal entry to find actionable items.

Look for:
- Things the person said they need to do, schedule, or follow up on
- Unresolved situations that clearly need action
- Projects or ongoing efforts they mentioned (multi-step, not a single action)
- Appointments, calls, decisions they haven't made yet

For each item, determine:
- "text": a clear, specific description (max 12 words)
- "is_project": true if this is a multi-step project or ongoing effort, false if it's a single task
- "type": "project" or "task"
- "due_date": ISO date string (YYYY-MM-DD) if the entry implies a deadline, null otherwise
  Examples: "study for test on Tuesday" -> next Tuesday's date, "doctor appointment Friday" -> next Friday
  Use today's date as reference: {today}
  If no clear deadline is mentioned, always return null

Rules:
- Maximum 4 items total
- Skip vague feelings or observations that don't require action
- Be specific — use names and details from the entry
- Return ONLY a JSON array, nothing else. No explanation. No markdown fences. Empty array [] if nothing actionable.

Entry:
{transcript}

Return format:
[
  {{"text": "Schedule dentist appointment", "is_project": false, "due_date": null}},
  {{"text": "Research options for career change", "is_project": true, "due_date": null}},
  {{"text": "Submit report by Friday", "is_project": false, "due_date": "2025-05-09"}}
]"""

_SIMILARITY_PROMPT = """You are checking if two to-do items refer to the same underlying topic.

Existing todo: "{existing}"
New item: "{new_item}"

Do these refer to the same task or project? Answer with ONLY one word: YES or NO."""


def _items_are_similar(existing_text: str, new_text: str) -> bool:
    """Ask the AI if two todo texts refer to the same underlying topic."""
    try:
        from ollama_manager import generate
        prompt = _SIMILARITY_PROMPT.format(
            existing=existing_text[:200],
            new_item=new_text[:200]
        )
        loop = asyncio.new_event_loop()
        try:
            raw = loop.run_until_complete(generate(
                prompt=prompt,
                temperature=0.1,
                max_tokens=5,
                num_ctx=2048,       # tiny prompt — minimal context window needed
            ))
        finally:
            loop.close()
        answer = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip().upper()
        return answer.startswith("YES")
    except Exception as e:
        log.debug(f"Similarity check failed: {e}")
        return False


def _extract_todos_background(transcript: str, entry_id: int, entry_date: str):
    """
    Background thread: scan a journal transcript for actionable items.
    Never raises — all errors are logged and swallowed so the thread dies quietly.
    """
    from datetime import date as _date
    log.info(f"Todo extraction starting for entry {entry_id}...")

    try:
        from ollama_manager import generate
        from database import get_conn

        today = _date.today().strftime('%Y-%m-%d')
        prompt = _TODO_EXTRACT_PROMPT.format(transcript=transcript[:3000], today=today)

        loop = asyncio.new_event_loop()
        try:
            # temperature=0.1: deterministic JSON extraction per task table
            raw = loop.run_until_complete(generate(
                prompt=prompt,
                temperature=0.1,
                max_tokens=500,
                fmt="json",         # enable Ollama JSON mode for reliable output
            ))
        finally:
            loop.close()

        clean  = clean_llm_json(raw)

        match = re.search(r'\[.*?\]', clean, re.DOTALL)
        if not match:
            log.debug(f"Todo extraction: no JSON array found in response for entry {entry_id}")
            return

        items = json.loads(match.group())
        if not isinstance(items, list) or len(items) == 0:
            log.debug(f"Todo extraction: empty list for entry {entry_id}")
            return

        conn = get_conn()
        try:
            undone_count = conn.execute(
                "SELECT COUNT(*) FROM todos WHERE done = 0"
            ).fetchone()[0]

            if undone_count >= 20:
                log.info(f"Todo extraction: flood guard hit ({undone_count} undone). Skipping entry {entry_id}.")
                return

            existing_todos = conn.execute(
                "SELECT id, text, notes FROM todos WHERE done = 0"
            ).fetchall()

            added    = 0
            appended = 0

            for item in items[:4]:
                if not isinstance(item, dict):
                    continue

                text = str(item.get("text", "")).strip()
                if not text or len(text) > 120:
                    continue

                is_project = 1 if item.get("is_project") else 0
                due_date   = item.get("due_date")
                # Validate due_date format — reject anything that doesn't look like YYYY-MM-DD
                if due_date and not re.match(r'^\d{4}-\d{2}-\d{2}$', str(due_date)):
                    due_date = None

                matched_id = None
                for existing in existing_todos:
                    if _items_are_similar(existing["text"], text):
                        matched_id = existing["id"]
                        break

                if matched_id:
                    try:
                        existing_notes_row = conn.execute(
                            "SELECT notes FROM todos WHERE id = ?", (matched_id,)
                        ).fetchone()
                        existing_notes = json.loads(existing_notes_row["notes"] or "[]")
                    except Exception:
                        existing_notes = []

                    note = f"[From entry {entry_date}] {text}"
                    existing_notes.append(note)
                    conn.execute(
                        "UPDATE todos SET notes = ? WHERE id = ?",
                        (json.dumps(existing_notes), matched_id)
                    )
                    appended += 1
                    log.debug(f"Todo extraction: appended note to todo {matched_id}")
                else:
                    conn.execute("""
                        INSERT INTO todos (text, source_entry_id, source_date, notes, is_project, due_date)
                        VALUES (?, ?, ?, '[]', ?, ?)
                    """, (text, entry_id, entry_date, is_project, due_date))
                    added += 1
                    log.debug(f"Todo extraction: added new todo '{text[:50]}' (project={is_project}, due={due_date})")

            conn.commit()
            log.info(f"Todo extraction complete for entry {entry_id}: {added} added, {appended} appended.")

        finally:
            conn.close()

    except Exception as e:
        log.warning(f"Todo extraction failed for entry {entry_id} (non-fatal): {e}")


def start_todo_extraction(transcript: str, entry_id: int, entry_date: str):
    """Launch _extract_todos_background in a daemon thread. Call fire-and-forget."""
    t = threading.Thread(
        target=_extract_todos_background,
        args=(transcript, entry_id, entry_date),
        daemon=True
    )
    t.start()


# ─── REST: Generate follow-up questions ──────────────────────────────────────

class QuestionsRequest(BaseModel):
    transcript: str
    count:      int = 3


@router.post("/questions")
async def generate_questions(body: QuestionsRequest):
    from ollama_manager import generate

    transcript_len = len(body.transcript.strip()) if body.transcript else 0
    log.info(f"Questions endpoint called — transcript length: {transcript_len} chars")

    if not body.transcript or transcript_len < 300:
        log.warning(f"Questions skipped — transcript too short ({transcript_len} chars, minimum 300)")
        return {"questions": [], "status": "transcript_too_short", "detail": f"Transcript is {transcript_len} chars, minimum 300"}

    try:
        from routes.memory import build_memory_context_block
        memory_context = build_memory_context_block(body.transcript, n=3)
    except Exception as mem_err:
        log.warning(f"Memory context injection failed (non-fatal): {mem_err}")
        memory_context = ''

    memory_section = f"\n\n{memory_context}\n" if memory_context else ''

    prompt = f"""You are analyzing a private journal entry. Generate exactly {body.count} specific, honest follow-up questions based on what this person actually said.
{memory_section}
Rules:
- Ask about specific things they mentioned, not generic wellness topics
- If relevant past entries are provided above, you may reference patterns across time
- Be direct, not therapeutic or coddling
- Surface contradictions or things they glossed over
- Do not ask yes/no questions
- Keep each question under 15 words
- Return ONLY a JSON array of strings, nothing else
- No preamble, no explanation, no markdown fences

Journal entry:
{body.transcript[:2000]}

Return format: ["question 1", "question 2", "question 3"]"""

    try:
        # temperature=0.7: some variety for questions, per task table
        raw = await generate(prompt=prompt, temperature=0.7, max_tokens=500, fmt="json")
        log.debug(f"Questions raw AI response ({len(raw)} chars): {raw[:300]}")

        clean = clean_llm_json(raw)
        log.debug(f"Questions after clean_llm_json: {clean[:200]}")

        match = re.search(r'\[[\s\S]*?\]', clean)

        if not match:
            log.debug("Questions: non-greedy regex found nothing, trying permissive match")
            match = re.search(r'\[[\s\S]+\]', clean)

        if not match:
            log.debug("Questions: trying raw response for array extraction")
            match = re.search(r'\[[\s\S]+\]', raw)

        if not match:
            log.warning(f"Questions: no JSON array found anywhere. Full cleaned response: {clean}")
            return {"questions": [], "status": "parse_failed", "detail": "No JSON array in AI response"}

        matched_text = match.group()
        log.debug(f"Questions matched text: {matched_text[:200]}")

        try:
            questions = json.loads(matched_text)
        except json.JSONDecodeError as json_err:
            log.warning(f"Questions: JSON parse error: {json_err}. Matched text: {matched_text[:200]}")
            return {"questions": [], "status": "parse_failed", "detail": f"JSON error: {json_err}"}

        if not isinstance(questions, list):
            log.warning(f"Questions: parsed value is not a list: {type(questions)}")
            return {"questions": [], "status": "parse_failed", "detail": "AI returned non-list JSON"}

        questions = [str(q).strip() for q in questions if q and str(q).strip()]
        result = questions[:body.count]
        log.info(f"Questions generated successfully: {len(result)} questions")
        return {"questions": result, "status": "ok"}

    except Exception as e:
        log.error(f"Question generation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ─── REST: Extract metrics from transcript ────────────────────────────────────

class MetricsRequest(BaseModel):
    transcript: str
    entry_id:   Optional[int] = None

_METRICS_PROMPT_TEMPLATE = """Extract psychological metrics from this journal entry. Score only what the person actually describes. Do not infer what they did not mention.

Use these anchored definitions for each 1-10 scale:

STRESS: How burdened or pressured does the person feel?
  1-2=calm, no pressure  3-4=mild manageable pressure  5-6=noticeable stress, coping  7-8=high stress, frequently overwhelmed  9-10=extreme, crisis-level

MOOD: Overall emotional quality of their day
  1-2=very low/depressed/empty  3-4=sad/irritable/discouraged  5-6=neutral to slightly positive  7-8=good, upbeat, satisfied  9-10=excellent, very happy

ANXIETY: Worry, fear, nervousness, or dread expressed
  1-2=no anxiety  3-4=mild worry about specific things  5-6=moderate, intrusive thoughts  7-8=high, persistent worry or physical symptoms  9-10=severe/panic-level
  Return null if anxiety is not mentioned.

ENERGY: Physical and mental energy levels
  1-2=exhausted, can barely function  3-4=low/sluggish  5-6=average/functional  7-8=good energy, productive  9-10=very high energy

MENTAL_CLARITY: Focus and cognitive sharpness
  1-2=very foggy, can't concentrate  3-4=scattered/distracted  5-6=average  7-8=clear, focused  9-10=sharp/in flow state
  Return null if not mentioned.

PRODUCTIVITY: How much was accomplished vs intended
  1-2=nothing done  3-4=very little, avoided tasks  5-6=partially productive  7-8=mostly completed tasks  9-10=highly productive, exceeded goals
  Return null if not mentioned.

SOCIAL_SAT: Satisfaction with social interactions
  1-2=isolated or negative social experiences  3-4=lonely or social friction  5-6=neutral/ordinary contact  7-8=good connections, felt supported  9-10=very connected
  Return null if social interactions not mentioned.

SENTIMENT (-1.0 to 1.0): Overall emotional tone
  -1.0=entirely negative  -0.5=mostly negative  0.0=neutral/mixed  +0.5=mostly positive  +1.0=entirely positive

SCREEN_TIME_HRS: Estimated hours of phone/screen use IF the person explicitly mentions it.
  Return null if not mentioned — do not assume.

NOTE: Excessive screen use mentioned as passive coping (scrolling, can't put phone down) is a mild negative signal for mood and energy — factor it in proportionally.

Return ONLY a valid JSON object. No explanation. No preamble. No markdown fences.
{{"stress": 6, "mood": 4, "anxiety": 7, "energy": 3, "mental_clarity": null, "productivity": 4, "social_sat": null, "sentiment": -0.4, "screen_time_hrs": null}}

Journal entry:
{transcript}"""


@router.post("/extract-metrics")
async def extract_metrics(body: MetricsRequest):
    from ollama_manager import generate

    log.info(f"extract-metrics called: entry_id={body.entry_id}, transcript_len={len(body.transcript) if body.transcript else 0}")

    if not body.transcript or len(body.transcript.strip()) < 30:
        return {"metrics": {}, "status": "skipped", "detail": "transcript too short"}

    prompt = _METRICS_PROMPT_TEMPLATE.format(transcript=body.transcript[:3000])

    try:
        # temperature=0.1: deterministic JSON extraction per task table
        raw   = await generate(prompt=prompt, temperature=0.1, max_tokens=400, fmt="json", num_ctx=8192)
        clean = clean_llm_json(raw)

        metrics = None
        for pat in [r'\{[\s\S]+\}', r'\{[^{}]+\}']:
            m = re.search(pat, clean)
            if m:
                try:
                    metrics = json.loads(m.group())
                    break
                except json.JSONDecodeError:
                    continue

        if not metrics:
            log.warning(f"Metrics: could not parse JSON from AI response. Snippet: {clean[:200]}")
            return {"metrics": {}, "status": "parse_failed"}

        if body.entry_id:
            from database import get_conn
            conn = get_conn()
            try:
                entry_row = conn.execute(
                    "SELECT date FROM entries WHERE id = ?", (body.entry_id,)
                ).fetchone()
                entry_date = entry_row["date"] if entry_row else None

                conn.execute("""
                    INSERT OR REPLACE INTO metrics
                    (entry_id, date, stress, mood, anxiety, energy,
                     mental_clarity, productivity, social_sat, sentiment, raw_extraction)
                    VALUES (?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    body.entry_id,
                    entry_date,
                    metrics.get("stress"),
                    metrics.get("mood"),
                    metrics.get("anxiety"),
                    metrics.get("energy"),
                    metrics.get("mental_clarity"),
                    metrics.get("productivity"),
                    metrics.get("social_sat"),
                    metrics.get("sentiment"),
                    json.dumps(metrics)
                ))

                # Auto-save screen time to health_data if AI detected it
                screen_hrs = metrics.get("screen_time_hrs")
                if screen_hrs is not None and entry_date:
                    try:
                        screen_mins = float(screen_hrs) * 60
                        existing = conn.execute(
                            "SELECT id, screen_time_mins FROM health_data WHERE date = ?",
                            (entry_date,)
                        ).fetchone()
                        if existing:
                            # Only overwrite if no manual entry exists
                            if existing["screen_time_mins"] is None:
                                conn.execute(
                                    "UPDATE health_data SET screen_time_mins = ? WHERE date = ?",
                                    (screen_mins, entry_date)
                                )
                        else:
                            conn.execute(
                                "INSERT INTO health_data (date, screen_time_mins) VALUES (?, ?)",
                                (entry_date, screen_mins)
                            )
                        log.info(f"Auto-saved screen time from journal: {entry_date} = {screen_mins:.0f} mins")
                    except Exception as e:
                        log.warning(f"Could not auto-save screen time: {e}")

                conn.commit()
            finally:
                conn.close()

        return {"metrics": metrics, "status": "ok"}

    except Exception as e:
        log.error(f"Metrics extraction error: {e}")
        return {"metrics": {}, "status": "error", "detail": str(e)}


# ─── REST: Embed a saved entry into ChromaDB ─────────────────────────────────

class EmbedRequest(BaseModel):
    entry_id:   int
    transcript: str
    entry_date: str = ""


def _embed_background(entry_id: int, transcript: str, entry_date: str):
    """Runs in a background thread -- never blocks the HTTP response."""
    try:
        from chroma_manager import embed_entry
        result = embed_entry(entry_id=entry_id, text=transcript, entry_date=entry_date)
        if result:
            log.debug(f"Background embed complete: entry {entry_id} -> {result}")
        else:
            log.debug(f"Background embed returned None for entry {entry_id} (ChromaDB may be unavailable)")
    except Exception as e:
        log.warning(f"Background embed failed for entry {entry_id}: {e}")


@router.post("/embed")
async def embed_entry_endpoint(body: EmbedRequest):
    if not body.transcript or not body.transcript.strip():
        return {"status": "skipped", "reason": "empty transcript"}

    thread = threading.Thread(
        target=_embed_background,
        args=(body.entry_id, body.transcript, body.entry_date),
        daemon=True
    )
    thread.start()

    return {"status": "embedding_started", "entry_id": body.entry_id}


# ─── REST: Tag a journal entry as a good/bad day ─────────────────────────────

_TAG_DAY_PROMPT = """You are analyzing a private journal entry to categorize what made this a good or bad day.

Extract short, specific topic tags (2-4 words each) that describe:
- Things that went well or felt positive (good_tags)
- Things that went poorly or caused stress (bad_tags)

Rules:
- Maximum 5 tags per category
- Tags must be specific to what was said (e.g. "gym session", "work deadline", "argument with friend")
- Skip vague tags like "bad day" or "feeling good"
- Return ONLY a JSON object, nothing else. No explanation. No markdown fences.
- Empty arrays are fine if the entry doesn't clearly have good or bad elements

Journal entry:
{transcript}

Return format:
{{"good_tags": ["tag1", "tag2"], "bad_tags": ["tag1", "tag2"]}}"""


class TagDayRequest(BaseModel):
    transcript: str
    entry_id:   int


@router.post("/tag-day")
async def tag_day(body: TagDayRequest):
    from ollama_manager import generate

    if not body.transcript or len(body.transcript.strip()) < 50:
        return {"status": "skipped", "reason": "transcript too short"}

    try:
        prompt = _TAG_DAY_PROMPT.format(transcript=body.transcript[:2000])
        # temperature=0.1: deterministic JSON extraction per task table
        raw    = await generate(prompt=prompt, temperature=0.1, max_tokens=200, fmt="json")
        clean  = clean_llm_json(raw)

        match = re.search(r'\{.*?\}', clean, re.DOTALL)
        if not match:
            log.warning(f"tag-day: no JSON found for entry {body.entry_id}")
            return {"status": "parse_failed"}

        tags      = json.loads(match.group())
        good_tags = tags.get("good_tags", [])
        bad_tags  = tags.get("bad_tags",  [])

        if not isinstance(good_tags, list): good_tags = []
        if not isinstance(bad_tags,  list): bad_tags  = []
        good_tags = [str(t).strip() for t in good_tags if str(t).strip()][:5]
        bad_tags  = [str(t).strip() for t in bad_tags  if str(t).strip()][:5]

        from database import get_conn
        conn = get_conn()
        try:
            conn.execute(
                "UPDATE entries SET good_tags = ?, bad_tags = ? WHERE id = ?",
                (json.dumps(good_tags), json.dumps(bad_tags), body.entry_id)
            )
            conn.commit()
        finally:
            conn.close()

        log.info(f"tag-day: entry {body.entry_id} tagged — good={good_tags}, bad={bad_tags}")
        return {"status": "ok", "good_tags": good_tags, "bad_tags": bad_tags}

    except Exception as e:
        log.warning(f"tag-day failed for entry {body.entry_id} (non-fatal): {e}")
        return {"status": "error", "reason": str(e)}


# ─── BACKGROUND: Update personal context from a transcript ───────────────────

_CONTEXT_EXTRACT_PROMPT = """You are updating a personal context document for an AI journal.

Current document:
{profile}

New {entry_type} recorded:
{transcript}

Extract NEW factual information not already in the document.
Focus on: relationships, work, health patterns, recurring stressors, goals, major life events.
Be specific. Ignore one-off complaints or passing moods.
Return ONLY this JSON -- nothing else. No explanation. No markdown fences.
{{ "new_facts": ["fact 1", "fact 2"] }}
Empty array if nothing genuinely new."""

_CONTEXT_COMPRESS_PROMPT = """You are compressing a personal context document for an AI journal.
The document has grown too long and must be condensed.

Current document:
{profile}

Rewrite it as a compact, factual summary under 3000 characters.
Preserve all important facts about relationships, work, health, goals, and recurring patterns.
Drop redundancy and minor details. Keep specific names and events.
Return ONLY the compressed document text -- no JSON, no explanation."""


def _update_context_background(transcript: str, entry_type: str = 'daily'):
    """
    Background thread: extract new personal facts from a transcript and
    append them to the user_profile setting.
    """
    from datetime import date

    log.debug(f"Context update starting for {entry_type} entry...")

    try:
        from database import get_setting, set_setting
        from ollama_manager import generate

        profile = get_setting('user_profile', '')

        extract_prompt = _CONTEXT_EXTRACT_PROMPT.format(
            profile=profile[:4000] if profile else '(none yet)',
            entry_type=entry_type,
            transcript=transcript[:3000]
        )

        loop = asyncio.new_event_loop()
        try:
            # temperature=0.15: memory fact extraction — precise and factual per task table
            raw = loop.run_until_complete(generate(
                prompt=extract_prompt,
                temperature=0.15,
                max_tokens=400,
                fmt="json",     # enable JSON mode for reliable fact extraction
            ))
        finally:
            loop.close()

        clean = clean_llm_json(raw)

        match = re.search(r'\{.*?\}', clean, re.DOTALL)
        if not match:
            log.debug("Context update: no JSON found in AI response.")
            return

        parsed    = json.loads(match.group())
        new_facts = parsed.get('new_facts', [])
        new_facts = [str(f).strip() for f in new_facts if str(f).strip()]

        if not new_facts:
            log.debug("Context update: no new facts extracted.")
            return

        if len(profile) + 500 > 8000:
            log.info("Context update: profile near limit, compressing...")
            compress_prompt = _CONTEXT_COMPRESS_PROMPT.format(profile=profile)

            loop2 = asyncio.new_event_loop()
            try:
                compressed_raw = loop2.run_until_complete(
                    generate(prompt=compress_prompt, temperature=0.2, max_tokens=800)
                )
            finally:
                loop2.close()

            compressed = re.sub(r'<think>.*?</think>', '', compressed_raw, flags=re.DOTALL).strip()
            compressed = re.sub(r'```.*?```', '', compressed, flags=re.DOTALL).strip()
            profile = compressed
            log.info(f"Context update: compressed to {len(profile)} chars.")

        today      = date.today().strftime('%Y-%m-%d')
        fact_lines = "\n".join(f"- {f}" for f in new_facts)
        block      = f"\n\n[Auto-extracted {today}]\n{fact_lines}"
        updated    = (profile + block).strip()

        set_setting('user_profile', updated)
        log.info(f"Context update: appended {len(new_facts)} facts. Profile now {len(updated)} chars.")

    except Exception as e:
        log.warning(f"Context update failed (non-fatal): {e}")


def start_context_update(transcript: str, entry_type: str = 'daily'):
    """Launch _update_context_background in a daemon thread. Call fire-and-forget."""
    t = threading.Thread(
        target=_update_context_background,
        args=(transcript, entry_type),
        daemon=True
    )
    t.start()


# ─── REST: Generate structured summary ───────────────────────────────────────

_STRUCTURED_SUMMARY_PROMPT = """You are analyzing a personal journal entry.

Extract the following from the transcript below and return ONLY valid JSON. No explanation. No preamble. No markdown fences.
- "summary": One clear, specific sentence describing what happened or what the person discussed. Not generic. Specific.
- "highlights": 2 to 4 bullet points capturing the key topics, feelings, or events. Each under 12 words. Be direct.
- "intentions": Any goals, plans, or things the person said they want to do. Empty array [] if none stated.

Rules:
- Be specific to what was actually said — no generic observations
- Highlights should read like field notes, not wellness summaries
- If the person mentioned something significant in passing, surface it

Transcript:
{transcript}

Return exactly this format:
{{"summary": "...", "highlights": ["...", "..."], "intentions": ["..."]}}"""


class StructuredSummaryRequest(BaseModel):
    transcript: str
    entry_id:   int


def _generate_structured_summary_background(transcript: str, entry_id: int):
    """
    Background thread: generate a structured summary and save it to the DB.
    Never blocks the HTTP response. Fails silently if Ollama is unavailable.
    """
    log.info(f"Structured summary starting for entry {entry_id}...")
    try:
        from ollama_manager import generate
        from database import get_conn

        prompt = _STRUCTURED_SUMMARY_PROMPT.format(transcript=transcript[:3000])

        loop = asyncio.new_event_loop()
        try:
            # temperature=0.1: JSON extraction, deterministic per task table
            raw = loop.run_until_complete(generate(
                prompt=prompt,
                temperature=0.1,
                max_tokens=400,
                fmt="json",     # enable JSON mode
            ))
        finally:
            loop.close()

        clean  = clean_llm_json(raw)

        parsed = None
        for pat in [r'\{[\s\S]+\}', r'\{[^{}]+\}']:
            m = re.search(pat, clean)
            if m:
                try:
                    parsed = json.loads(m.group())
                    break
                except json.JSONDecodeError:
                    continue

        if not parsed:
            log.warning(f"Structured summary: could not parse JSON for entry {entry_id}. Raw: {clean[:200]}")
            return

        summary    = str(parsed.get("summary", "")).strip()
        highlights = parsed.get("highlights", [])
        intentions = parsed.get("intentions", [])

        if not isinstance(highlights, list): highlights = []
        if not isinstance(intentions, list): intentions = []

        highlights = [str(h).strip() for h in highlights if str(h).strip()][:4]
        intentions = [str(i).strip() for i in intentions if str(i).strip()][:5]

        if not summary and not highlights:
            log.debug(f"Structured summary: empty result for entry {entry_id}, skipping save.")
            return

        result = json.dumps({
            "summary":    summary,
            "highlights": highlights,
            "intentions": intentions,
        })

        conn = get_conn()
        try:
            conn.execute(
                "UPDATE entries SET structured_summary = ? WHERE id = ?",
                (result, entry_id)
            )
            conn.commit()
            log.info(f"Structured summary saved for entry {entry_id}.")
        finally:
            conn.close()

    except Exception as e:
        log.warning(f"Structured summary failed for entry {entry_id} (non-fatal): {e}")


# ─── REST: Trigger memory update for written (non-audio) entries ─────────────

class MemoryUpdateRequest(BaseModel):
    transcript: str
    entry_type: str = "write"


@router.post("/update-memory")
async def trigger_memory_update(body: MemoryUpdateRequest):
    if not body.transcript or len(body.transcript.strip()) < 30:
        return {"status": "skipped", "reason": "transcript too short"}

    start_context_update(body.transcript, entry_type=body.entry_type)

    from routes.memory import start_memory_update
    start_memory_update(body.transcript, entry_type=body.entry_type)

    return {"status": "started"}


@router.post("/summarize")
async def generate_structured_summary(body: StructuredSummaryRequest):
    if not body.transcript or len(body.transcript.strip()) < 30:
        return {"status": "skipped", "reason": "transcript too short"}

    t = threading.Thread(
        target=_generate_structured_summary_background,
        args=(body.transcript, body.entry_id),
        daemon=True
    )
    t.start()
    return {"status": "summarizing"}


# ─── WEBSOCKET: Real-time streaming transcription ────────────────────────────
#
# Two-model architecture:
#   - Base model handles live partials (loads in ~1-2 seconds on first connect)
#   - Turbo model handles POST /upload (pre-loaded at startup by preload_turbo)
#
# Partial frequency: every 6 chunks (~3 seconds at 500ms per chunk).
# On connect: sends {"type": "model_loading"} if turbo not yet ready (informational).
# Text from base model is rough — that is expected and acceptable for live preview.

@router.websocket("/stream")
async def transcribe_stream(ws: WebSocket):
    await ws.accept()
    log.info("Transcription WebSocket connected.")

    audio_buffer = bytearray()
    chunk_count  = 0
    connected    = True

    async def safe_send(payload: dict):
        """Send JSON only if the socket is still open. Sets connected=False on failure."""
        nonlocal connected
        try:
            if connected:
                await ws.send_json(payload)
        except Exception:
            connected = False

    # Inform the frontend if turbo model hasn't finished loading yet.
    # This is informational only — recording works fine regardless.
    if not _turbo_ready.is_set():
        await safe_send({"type": "model_loading"})
        log.info("WebSocket: turbo model still loading — sent model_loading signal.")

    # Load the base model now if not already loaded.
    # This runs in a thread to avoid blocking the async loop.
    try:
        await asyncio.to_thread(get_base)
        log.info("WebSocket: base model ready.")
    except Exception as e:
        log.warning(f"WebSocket: base model load failed: {e}")
        await safe_send({"type": "error", "text": "Whisper base model failed to load."})

    try:
        while True:
            data = await ws.receive_bytes()
            audio_buffer.extend(data)
            chunk_count += 1

            # Send a partial every 6 chunks (~3 seconds of audio).
            # Use the base model — fast, good enough for live preview.
            if chunk_count % 6 == 0 and len(audio_buffer) > 4000:
                try:
                    result  = await asyncio.to_thread(transcribe_audio_partial, bytes(audio_buffer))
                    partial = result.get("transcript", "")
                    if partial:
                        await safe_send({"type": "partial", "text": partial})
                        log.debug(f"WebSocket partial: {len(partial)} chars")
                except Exception as e:
                    log.warning(f"Partial transcription failed: {e}")

    except WebSocketDisconnect:
        connected = False
        log.info(f"Recording ended -- {len(audio_buffer)} bytes buffered.")

    except Exception as e:
        connected = False
        log.error(f"WebSocket error: {e}")
        await safe_send({"type": "error", "text": str(e)})
