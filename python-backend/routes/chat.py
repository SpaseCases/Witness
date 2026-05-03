"""
WITNESS — Journal Chat API

Lets the user ask natural-language questions about their own journal.
Uses ChromaDB semantic search to find the most relevant past entries,
then feeds them to Ollama as grounded context for the answer.

Endpoints:
  POST /chat/message   — send a question, get a streaming AI response
  GET  /chat/history   — get past chat messages for this session (in-memory)

How it works:
  1. User sends a question ("What have I been stressed about lately?")
  2. Backend does a semantic search in ChromaDB for the most relevant entries
  3. Those entries + the question are assembled into a prompt
  4. Ollama streams the answer back token by token
  5. Each token is sent to the frontend via Server-Sent Events (SSE)

The AI is instructed to:
  - Be honest and direct (no wellness-coach voice)
  - Only cite things that are actually in the entries
  - Admit when the journal doesn't contain enough info to answer
  - Reference specific dates when citing evidence
"""

import json
import logging
import re
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from database import get_conn
from ollama_manager import generate_stream, generate

log = logging.getLogger("witness.chat")
router = APIRouter()

# In-memory chat history for the current session (clears on restart — intentional)
# Keyed by a simple session ID ("default" for single-user desktop app)
_chat_history: list[dict] = []
MAX_HISTORY = 40  # keep the last 40 messages


# ─── PROMPT ──────────────────────────────────────────────────────────────────

CHAT_SYSTEM_PROMPT = """You are a personal journal assistant for an app called Witness.
You have access to the user's private journal entries below.

Your job:
- Answer their question honestly and specifically, using what they actually wrote
- Reference specific dates and direct details from the entries
- If the entries don't contain enough information to answer, say so plainly
- Do not make things up or extrapolate beyond what the entries show
- Do not soften observations or use wellness-coach language
- If a pattern is uncomfortable but evidenced, name it directly
- Keep answers concise — under 300 words unless the question genuinely requires more

Tone: Like a sharp, trusted friend who has read everything you've written — not a therapist, not a chatbot.
No em dashes. No hollow affirmations. No "Great question!"

{entry_block}"""

NO_ENTRIES_RESPONSE = """No journal entries are stored yet, so there is nothing to search through.

Start recording daily entries and this chat will be able to reference your actual history."""


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def _build_entry_block(entries: list[dict]) -> str:
    """Format a list of entry dicts into a readable context block for the prompt."""
    if not entries:
        return "No relevant entries found."

    lines = ["RELEVANT JOURNAL ENTRIES (ordered by relevance):\n"]
    for i, e in enumerate(entries, 1):
        date_str = e.get("date") or e.get("entry_date") or "unknown date"
        transcript = (e.get("transcript") or "").strip()
        if not transcript:
            continue

        # Truncate very long entries so we don't blow the context window
        if len(transcript) > 600:
            transcript = transcript[:600] + "... [truncated]"

        # Include available metrics if present
        metrics_parts = []
        for key, label in [("stress", "stress"), ("mood", "mood"), ("energy", "energy"), ("anxiety", "anxiety")]:
            val = e.get(key)
            if val is not None:
                metrics_parts.append(f"{label}={val}/10")
        metrics_str = f"  [{', '.join(metrics_parts)}]" if metrics_parts else ""

        lines.append(f"[{i}] {date_str}{metrics_str}")
        lines.append(transcript)
        lines.append("")

    return "\n".join(lines)


def _get_relevant_entries(query: str, n: int = 8) -> list[dict]:
    """
    Fetch the most relevant journal entries for this question.
    Uses ChromaDB semantic search if available, falls back to recent entries.
    """
    # Try semantic search first
    try:
        from chroma_manager import semantic_search
        matches = semantic_search(query, n_results=n)

        if matches:
            conn = get_conn()
            try:
                results = []
                for match in matches:
                    entry_id = match.get("entry_id")
                    if not entry_id:
                        continue
                    row = conn.execute("""
                        SELECT e.id, e.date, e.transcript, m.stress, m.mood, m.energy, m.anxiety
                        FROM   entries e
                        LEFT JOIN metrics m ON m.entry_id = e.id
                        WHERE  e.id = ?
                    """, (entry_id,)).fetchone()
                    if row:
                        results.append(dict(row))
                return results
            finally:
                conn.close()
    except Exception as e:
        log.warning(f"Semantic search unavailable: {e}")

    # Fallback: return the most recent N daily entries
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT e.id, e.date, e.transcript, m.stress, m.mood, m.energy, m.anxiety
            FROM   entries e
            LEFT JOIN metrics m ON m.entry_id = e.id
            WHERE  e.type = 'daily' AND e.transcript != ''
            ORDER  BY e.created_at DESC
            LIMIT  ?
        """, (n,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _has_any_entries() -> bool:
    """Return True if the database has at least one entry with a transcript."""
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT COUNT(*) as n FROM entries WHERE transcript != ''"
        ).fetchone()
        return (row["n"] or 0) > 0
    finally:
        conn.close()


# ─── ROUTES ──────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    message: str
    stream:  bool = True   # frontend always uses streaming


@router.post("/message")
async def chat_message(body: ChatMessage):
    """
    Main chat endpoint. Accepts a question and streams the AI response.

    Uses Server-Sent Events (SSE) format so the frontend can display
    tokens as they arrive — text appears word by word like a typewriter.

    SSE format:
      data: {"type": "token", "text": "word "}
      data: {"type": "done"}
      data: {"type": "error", "text": "..."}
    """
    question = body.message.strip()
    if not question:
        return {"error": "Empty message"}

    # Save the user message to in-memory history
    _chat_history.append({"role": "user", "text": question})
    if len(_chat_history) > MAX_HISTORY:
        _chat_history.pop(0)

    # Check if there's anything to search through
    if not _has_any_entries():
        async def no_entries_stream():
            yield f"data: {json.dumps({'type': 'token', 'text': NO_ENTRIES_RESPONSE})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            _chat_history.append({"role": "assistant", "text": NO_ENTRIES_RESPONSE})
        return StreamingResponse(no_entries_stream(), media_type="text/event-stream")

    # Get relevant entries
    entries = _get_relevant_entries(question, n=8)
    entry_block = _build_entry_block(entries)

    # Build the final prompt
    system = CHAT_SYSTEM_PROMPT.format(entry_block=entry_block)
    full_prompt = f"{system}\n\nUser question: {question}"

    async def stream_response():
        """Generator that yields SSE-formatted tokens from Ollama."""
        full_text = []
        try:
            async for token in generate_stream(prompt=full_prompt):
                # Strip DeepSeek <think> blocks if they bleed into the stream
                # (they usually don't, but occasionally the model is chatty)
                full_text.append(token)
                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"

            # Save complete assistant response to history
            complete = "".join(full_text)
            _chat_history.append({"role": "assistant", "text": complete})
            if len(_chat_history) > MAX_HISTORY:
                _chat_history.pop(0)

            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as e:
            log.error(f"Chat stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"

    return StreamingResponse(
        stream_response(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disables nginx buffering if running behind a proxy
        }
    )


@router.get("/history")
def get_chat_history():
    """
    Return in-memory chat history for the current session.
    This resets when the backend restarts — intentional for privacy.
    """
    return {"messages": _chat_history}


@router.delete("/history")
def clear_chat_history():
    """Clear the in-memory chat history."""
    _chat_history.clear()
    return {"status": "cleared"}
