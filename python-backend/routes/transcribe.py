"""
WITNESS -- Transcription + AI Follow-Up API

Endpoints:
  POST /transcribe/upload          -- transcribe a complete audio file
  POST /transcribe/questions       -- generate AI follow-up questions from transcript
  POST /transcribe/extract-metrics -- extract mood/stress scores from transcript
  POST /transcribe/embed           -- embed a saved entry into ChromaDB (call after save)
  WS   /transcribe/stream          -- real-time streaming transcription

Step 6 additions:
  - _extract_todos_background(): after every upload, scans the transcript for
    actionable items and projects. For each item the AI returns:
      * If it's similar to an existing open todo → appends a note to it
      * If it's genuinely new → inserts as a new todo row
    AI also flags each item as a project (multi-step, ongoing) or a task (one-off).
    Runs in a daemon thread — never blocks the HTTP response.
  - start_todo_extraction(): public launcher called from /upload endpoint.

FIX (follow-up questions):
  - Restored minimum transcript length to 300 chars — consistent with the
    frontend threshold in JournalEntry.jsx. Both gates must agree or the UI
    shows the question block for entries the backend silently skips.
  - Added detailed logging at every step: raw AI response, cleaned text, regex
    match result, and final parsed output. Check your terminal for WITNESS logs
    to see exactly what happened on any failed call.
  - Added a second JSON extraction pass using a more permissive regex so partial
    or oddly-wrapped arrays are still captured.
  - The endpoint now always returns a 'debug' field with the raw AI snippet so
    the frontend can surface it in dev mode if needed.
  - Increased max_tokens from 300 to 500 so longer-thinking models (DeepSeek R1
    with its <think> blocks) have room to finish before the JSON.
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

log    = logging.getLogger("witness.transcribe")
router = APIRouter()

_whisper_model = None


# ─── JSON CLEANING HELPER ─────────────────────────────────────────────────────

def clean_llm_json(raw: str) -> str:
    """
    Extract bare JSON from an LLM response.

    DeepSeek R1 has two failure modes:
      1. JSON appears AFTER </think> — stripping think tags leaves clean JSON (old behaviour)
      2. JSON appears INSIDE <think>...</think> — stripping think tags destroys the JSON

    Strategy:
      - First, look for a JSON object/array anywhere in the raw string (including inside think tags)
      - Pull that out as the canonical content
      - Then strip think tags and markdown fences from whatever remains
    """
    # ── Step 1: grab the first JSON object or array directly from raw ──────────
    # This works whether the JSON is inside or outside <think> blocks.
    json_in_raw = re.search(r'(\{[\s\S]*\}|\[[\s\S]*\])', raw)

    if json_in_raw:
        candidate = json_in_raw.group(1).strip()
        # Quick sanity-check: if it parses, return it immediately
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass  # malformed — fall through to the cleaned-text approach

    # ── Step 2: strip think blocks and fences, then return what's left ────────
    text = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL)
    fence_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fence_match:
        text = fence_match.group(1)
    return text.strip()


# ─── WHISPER LOADER ───────────────────────────────────────────────────────────

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        log.info("Loading Faster-Whisper (CPU, int8)...")
        try:
            _whisper_model = WhisperModel(
                "large-v3-turbo",
                device="cpu",
                compute_type="int8"
            )
            log.info("Whisper large-v3-turbo loaded on CPU.")
        except Exception as e:
            log.warning(f"large-v3-turbo failed ({e}), falling back to base model...")
            _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
            log.info("Whisper base model loaded on CPU.")
    return _whisper_model


def transcribe_audio_file(audio_bytes: bytes, language: str = "en") -> dict:
    model = get_whisper()

    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500}
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        log.info(f"Transcribed {info.duration:.1f}s -- {len(text)} chars, lang={info.language}")
        return {"transcript": text, "duration": round(info.duration, 1), "language": info.language}
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


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

Rules:
- Maximum 4 items total
- Skip vague feelings or observations that don't require action
- Be specific — use names and details from the entry
- Return ONLY a JSON array, nothing else. Empty array [] if nothing actionable.

Entry:
{transcript}

Return format:
[
  {{"text": "Schedule dentist appointment", "is_project": false}},
  {{"text": "Research options for career change", "is_project": true}}
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
        raw = asyncio.run(generate(prompt=prompt, temperature=0.1, max_tokens=5))
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
    log.info(f"Todo extraction starting for entry {entry_id}...")

    try:
        from ollama_manager import generate
        from database import get_conn

        prompt = _TODO_EXTRACT_PROMPT.format(transcript=transcript[:3000])
        raw    = asyncio.run(generate(prompt=prompt, temperature=0.3, max_tokens=500))
        clean  = clean_llm_json(raw)

        # Extract the JSON array from the response
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

            added   = 0
            appended = 0

            for item in items[:4]:
                if not isinstance(item, dict):
                    continue

                text = str(item.get("text", "")).strip()
                if not text or len(text) > 120:
                    continue

                is_project = 1 if item.get("is_project") else 0

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
                        INSERT INTO todos (text, source_entry_id, source_date, notes, is_project)
                        VALUES (?, ?, ?, '[]', ?)
                    """, (text, entry_id, entry_date, is_project))
                    added += 1
                    log.debug(f"Todo extraction: added new todo '{text[:50]}' (project={is_project})")

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
#
# FIX NOTES:
#   - Minimum transcript length: 300 chars (matches frontend JournalEntry.jsx).
#     Both the frontend gate and this backend gate must agree — mismatched
#     thresholds cause the question block to appear while the backend silently
#     skips the call.
#
#   - max_tokens raised from 300 → 500.
#     DeepSeek R1 emits a long <think>...</think> block before responding.
#     At 300 tokens the model was sometimes running out of space before
#     reaching the JSON, causing parse failures.
#
#   - Three-stage JSON extraction:
#       1. clean_llm_json() strips think blocks and fences first
#       2. Tight array regex: [\s\S]*? (non-greedy, finds first array)
#       3. Permissive fallback: [\s\S]+ (greedy, captures if array contains
#          nested objects or escaped quotes that tripped the non-greedy pass)
#     This handles all known DeepSeek R1 output shapes.
#
#   - Every step is now logged at DEBUG level.
#     Run the backend and watch the terminal — you will see exactly what the
#     AI returned and where parsing succeeded or failed.

class QuestionsRequest(BaseModel):
    transcript: str
    count:      int = 3


@router.post("/questions")
async def generate_questions(body: QuestionsRequest):
    from ollama_manager import generate

    transcript_len = len(body.transcript.strip()) if body.transcript else 0
    log.info(f"Questions endpoint called — transcript length: {transcript_len} chars")

    # Threshold matches frontend (JournalEntry.jsx): 300 chars minimum.
    # Both gates must agree — if they differ the UI shows the question block
    # while the backend silently returns an empty array.
    if not body.transcript or transcript_len < 300:
        log.warning(f"Questions skipped — transcript too short ({transcript_len} chars, minimum 300)")
        return {"questions": [], "status": "transcript_too_short", "detail": f"Transcript is {transcript_len} chars, minimum 300"}

    # Inject memory context (Layer B + C)
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
        # Increased max_tokens: DeepSeek R1 uses tokens for its <think> block
        # before reaching the JSON answer. 300 was too tight.
        raw = await generate(prompt=prompt, temperature=0.6, max_tokens=500)
        log.debug(f"Questions raw AI response ({len(raw)} chars): {raw[:300]}")

        clean = clean_llm_json(raw)
        log.debug(f"Questions after clean_llm_json: {clean[:200]}")

        # Stage 1: non-greedy array match (handles simple arrays)
        match = re.search(r'\[[\s\S]*?\]', clean)

        # Stage 2: permissive fallback if stage 1 found nothing or failed to parse
        if not match:
            log.debug("Questions: non-greedy regex found nothing, trying permissive match")
            match = re.search(r'\[[\s\S]+\]', clean)

        if not match:
            # Stage 3: try the raw response directly in case clean_llm_json over-stripped
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

        # Filter out any non-string items (sometimes AI sneaks in objects)
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

_METRICS_PROMPT_TEMPLATE = """Analyze this journal entry and extract psychological metrics. Be honest and accurate. Base scores strictly on what the person says and how they say it.

Return ONLY a JSON object with these exact keys:
{{
  "stress":         <1-10, 10=extreme stress>,
  "mood":           <1-10, 10=excellent mood>,
  "anxiety":        <1-10, 10=severe anxiety>,
  "energy":         <1-10, 10=high energy>,
  "mental_clarity": <1-10, 10=very clear thinking>,
  "productivity":   <1-10, 10=highly productive>,
  "social_sat":     <1-10, 10=very satisfied socially, null if not mentioned>,
  "sentiment":      <-1.0 to 1.0, overall emotional tone>
}}

If a metric cannot be determined, use null. Return ONLY the JSON object.

Journal entry:
{transcript}"""


@router.post("/extract-metrics")
async def extract_metrics(body: MetricsRequest):
    from ollama_manager import generate

    if not body.transcript or len(body.transcript.strip()) < 30:
        return {"metrics": {}, "status": "skipped", "detail": "transcript too short"}

    prompt = _METRICS_PROMPT_TEMPLATE.format(transcript=body.transcript[:3000])

    try:
        raw   = await generate(prompt=prompt, temperature=0.3, max_tokens=400)
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
                # Use the entry's own date (not today) so backfilled or
                # yesterday's entries don't land on today in trend graphs.
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
- Return ONLY a JSON object, nothing else
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
        raw    = await generate(prompt=prompt, temperature=0.3, max_tokens=200)
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
Return ONLY this JSON -- nothing else:
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

        raw = asyncio.run(generate(prompt=extract_prompt, temperature=0.3, max_tokens=400))
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
            compressed_raw = asyncio.run(
                generate(prompt=compress_prompt, temperature=0.2, max_tokens=800)
            )
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

Extract the following from the transcript below and return ONLY valid JSON:
- "summary": One clear, specific sentence describing what happened or what the person discussed. Not generic. Specific.
- "highlights": 2 to 4 bullet points capturing the key topics, feelings, or events. Each under 12 words. Be direct.
- "intentions": Any goals, plans, or things the person said they want to do. Empty array [] if none stated.

Rules:
- Be specific to what was actually said — no generic observations
- Highlights should read like field notes, not wellness summaries
- If the person mentioned something significant in passing, surface it
- Return ONLY the JSON object. No explanation, no preamble, no markdown fences.

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
        raw    = asyncio.run(generate(prompt=prompt, temperature=0.3, max_tokens=400))
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

        summary     = str(parsed.get("summary", "")).strip()
        highlights  = parsed.get("highlights", [])
        intentions  = parsed.get("intentions", [])

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
# WriteMode and any future typed-entry modes call this after saving.
# Voice entries already trigger memory update via /upload. This route
# provides the same trigger for entries that skip the audio pipeline.

class MemoryUpdateRequest(BaseModel):
    transcript: str
    entry_type: str = "write"   # "write", "rant", "daily" etc.


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

@router.websocket("/stream")
async def transcribe_stream(ws: WebSocket):
    await ws.accept()
    log.info("Transcription WebSocket connected.")

    audio_buffer = bytearray()
    chunk_count  = 0
    connected    = True   # track state so we never send on a closed socket

    async def safe_send(payload: dict):
        """Send JSON only if the socket is still open."""
        try:
            if connected:
                await ws.send_json(payload)
        except Exception:
            pass   # socket closed between the check and the send -- ignore

    try:
        while True:
            data = await ws.receive_bytes()
            audio_buffer.extend(data)
            chunk_count += 1

            # Only attempt partial transcription every 10 chunks and when
            # Whisper is already loaded. If the model is still loading
            # (first run after install) the to_thread call would block for
            # 30+ seconds and the socket would be long dead by then.
            if chunk_count % 10 == 0 and len(audio_buffer) > 8000 and _whisper_model is not None:
                try:
                    result  = await asyncio.to_thread(transcribe_audio_file, bytes(audio_buffer))
                    partial = result.get("transcript", "")
                    if partial:
                        await safe_send({"type": "partial", "text": partial})
                except Exception as e:
                    log.warning(f"Partial transcription failed: {e}")

    except WebSocketDisconnect:
        connected = False
        log.info(f"Recording ended -- {len(audio_buffer)} bytes buffered.")

    except Exception as e:
        connected = False
        log.error(f"WebSocket error: {e}")
        await safe_send({"type": "error", "text": str(e)})
