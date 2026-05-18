# Bug fix: removed dead _save_messages() and fixed no-entries path to use
#          _save_user_message()/_update_assistant_message() so blank assistant
#          rows are never orphaned; get_messages() now filters empty assistant
#          placeholder rows; thread auto-title strips to last word boundary;
#          generate_stream() call now passes explicit temperature/num_ctx;
#          _get_recall_block() log level lowered to debug (non-fatal noise).
"""
WITNESS — Journal Chat API
# Updated: Full overhaul — persistent multi-thread chat with SQLite storage,
#           entry injection on thread creation, smart recall (ChromaDB only for
#           recall keywords), memory learning after every AI response.

Thread architecture:
  - Multiple named threads stored permanently in chat_threads + chat_messages
  - Threads persist across navigation, restarts, and sessions — never auto-deleted
  - User can create, rename, and delete threads manually
  - On new thread creation, last 5 journal entries are silently injected as context
  - After each AI response, a background thread extracts new user facts for memory

Endpoints:
  GET    /chat/threads                    — list all threads (newest first)
  POST   /chat/threads                    — create a new thread
  PATCH  /chat/threads/{id}               — rename a thread
  DELETE /chat/threads/{id}               — delete a thread + all its messages
  GET    /chat/threads/{id}/messages      — get all messages in a thread
  DELETE /chat/threads/{id}/messages      — clear messages (keep thread)
  POST   /chat/threads/{id}/message       — send a message, stream AI response (SSE)

Retrieval strategy:
  - RECALL KEYWORDS ("when did", "find", "show me", "what have i said",
    "last time", "how often"): runs ChromaDB semantic search, appends 3
    most relevant entries to the user message as RELEVANT PAST ENTRIES.
  - ALL OTHER QUERIES: trusts conversation history + the entries already
    injected at thread creation. No fresh ChromaDB lookup.
"""

import json
import logging
import re
import threading
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from database import get_conn
from ollama_manager import generate_stream

log    = logging.getLogger("witness.chat")
router = APIRouter()

MAX_HISTORY_MESSAGES = 40

RECALL_KEYWORDS = [
    "when did", "find", "show me", "what have i said", "last time",
    "how often", "search", "look up", "go back", "remind me when",
]

CHAT_SYSTEM_PROMPT = """\
You are a personal journal assistant for an app called Witness.
You have access to this person's private journal entries.

Rules:
- Answer honestly and specifically, using what they actually wrote
- Reference specific dates and direct details from the entries
- If the entries don't contain enough to answer, say so plainly
- Do not soften observations or use wellness-coach language
- If a pattern is uncomfortable but evidenced, name it directly
- Keep answers concise unless the question genuinely requires more

Behavior rules:
- In the opening messages of a new conversation, actively reference the journal entries provided. This is what makes Witness unique.
- As the conversation continues, prioritize the chat history above all. Do not restart from scratch on every turn.
- Never preface a reply with "According to your journal entries" unless the user explicitly asked you to search entries.
- For direct questions, answer directly. Cite entries as supporting evidence, not as the entire answer.
- You are a sharp, honest analyst — not a wellness chatbot.

Tone: Like a sharp, trusted friend who has read everything you have written. Not a therapist, not a chatbot.
No em dashes. No hollow affirmations. No "Great question!"

{context_block}"""

NO_ENTRIES_RESPONSE = (
    "No journal entries are stored yet, so there is nothing to reference.\n\n"
    "Record some daily entries and this chat will be able to reference your actual history."
)


class ThreadCreate(BaseModel):
    title: Optional[str] = None

class ThreadRename(BaseModel):
    title: str

class SendMessage(BaseModel):
    message: str


def _has_any_entries() -> bool:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT COUNT(*) as n FROM entries WHERE transcript != ''"
        ).fetchone()
        return (row["n"] or 0) > 0
    finally:
        conn.close()


def _get_last_entries(n: int = 5) -> list:
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT e.date, e.transcript, m.stress, m.mood
            FROM   entries e
            LEFT JOIN metrics m ON m.entry_id = e.id
            WHERE  e.transcript IS NOT NULL AND LENGTH(TRIM(e.transcript)) > 20
            ORDER  BY e.date DESC, e.id DESC
            LIMIT  ?
        """, (n,)).fetchall()
        return [dict(r) for r in reversed(rows)]
    finally:
        conn.close()


def _format_entry_context(entries: list) -> str:
    if not entries:
        return ""
    lines = ["RECENT JOURNAL ENTRIES (your context for this conversation):\n"]
    for e in entries:
        date_str = e.get("date") or "unknown"
        text     = (e.get("transcript") or "").strip()[:500]
        metrics  = []
        if e.get("stress") is not None: metrics.append(f"stress={e['stress']}/10")
        if e.get("mood")   is not None: metrics.append(f"mood={e['mood']}/10")
        metric_str = f"  [{', '.join(metrics)}]" if metrics else ""
        lines.append(f"[{date_str}{metric_str}]\n{text}\n")
    return "\n".join(lines)


def _format_conversation_history(messages: list) -> str:
    if not messages:
        return ""
    parts = []
    for m in messages:
        role    = "USER" if m["role"] == "user" else "WITNESS"
        content = (m["content"] or "").strip()
        parts.append(f"{role}: {content}")
    return "\n\n".join(parts)


def _is_recall_query(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in RECALL_KEYWORDS)


def _get_recall_block(query: str) -> str:
    try:
        from chroma_manager import semantic_search
        matches = semantic_search(query, n_results=3)
        if not matches:
            return ""
        conn = get_conn()
        try:
            lines = ["RELEVANT PAST ENTRIES (semantic search results):\n"]
            for match in matches:
                entry_id = match.get("entry_id")
                if not entry_id:
                    continue
                row = conn.execute(
                    "SELECT date, transcript FROM entries WHERE id = ?", (entry_id,)
                ).fetchone()
                if not row:
                    continue
                text = (row["transcript"] or "").strip()[:400]
                lines.append(f"[{row['date']}]\n{text}\n")
            return "\n".join(lines) if len(lines) > 1 else ""
        finally:
            conn.close()
    except Exception as e:
        log.debug(f"Recall search failed (non-fatal): {e}")
        return ""


def _extract_chat_facts_background(user_msg: str, ai_response: str):
    try:
        from routes.memory import start_memory_update
        combined = f"User: {user_msg}\n\nAssistant observed: {ai_response}"
        start_memory_update(combined, entry_type="chat")
    except Exception as e:
        log.debug(f"Chat memory update failed (non-fatal): {e}")


def _save_user_message(thread_id: int, user_content: str) -> int:
    """
    Insert the user message and a blank assistant placeholder before streaming starts.
    Returns the assistant row id so we can update it after streaming completes.
    Saving upfront means a client disconnect never loses the user message.
    """
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO chat_messages (thread_id, role, content) VALUES (?, 'user', ?)",
            (thread_id, user_content)
        )
        cur = conn.execute(
            "INSERT INTO chat_messages (thread_id, role, content) VALUES (?, 'assistant', '')",
            (thread_id,)
        )
        assistant_id = cur.lastrowid
        conn.execute(
            "UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?",
            (thread_id,)
        )
        conn.commit()
        return assistant_id
    finally:
        conn.close()


def _update_assistant_message(assistant_id: int, thread_id: int, content: str):
    """Fill in the assistant placeholder row once streaming completes."""
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE chat_messages SET content = ? WHERE id = ?",
            (content, assistant_id)
        )
        conn.execute(
            "UPDATE chat_threads SET updated_at = datetime('now') WHERE id = ?",
            (thread_id,)
        )
        conn.commit()
    finally:
        conn.close()


# ─── THREAD CRUD ──────────────────────────────────────────────────────────────

@router.get("/threads")
def list_threads():
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT t.id, t.title, t.created_at, t.updated_at,
                   COUNT(m.id) as message_count
            FROM   chat_threads t
            LEFT JOIN chat_messages m ON m.thread_id = t.id
            GROUP BY t.id
            ORDER  BY t.updated_at DESC
        """).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/threads")
def create_thread(body: ThreadCreate = ThreadCreate()):
    entries = _get_last_entries(5)
    entry_context_json = json.dumps(entries)
    title = (body.title or "New Thread").strip()[:80]
    conn = get_conn()
    try:
        cur = conn.execute(
            "INSERT INTO chat_threads (title, entry_context) VALUES (?, ?)",
            (title, entry_context_json)
        )
        conn.commit()
        thread_id = cur.lastrowid
        row = conn.execute("SELECT * FROM chat_threads WHERE id = ?", (thread_id,)).fetchone()
        return {**dict(row), "message_count": 0}
    finally:
        conn.close()


@router.patch("/threads/{thread_id}")
def rename_thread(thread_id: int, body: ThreadRename):
    title = body.title.strip()[:80]
    if not title:
        raise HTTPException(status_code=400, detail="Title cannot be empty")
    conn = get_conn()
    try:
        if not conn.execute("SELECT id FROM chat_threads WHERE id = ?", (thread_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Thread not found")
        conn.execute(
            "UPDATE chat_threads SET title = ?, updated_at = datetime('now') WHERE id = ?",
            (title, thread_id)
        )
        conn.commit()
        return dict(conn.execute("SELECT * FROM chat_threads WHERE id = ?", (thread_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/threads/{thread_id}")
def delete_thread(thread_id: int):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM chat_threads WHERE id = ?", (thread_id,))
        conn.commit()
        return {"status": "deleted", "id": thread_id}
    finally:
        conn.close()


# ─── MESSAGES ────────────────────────────────────────────────────────────────

@router.get("/threads/{thread_id}/messages")
def get_messages(thread_id: int):
    conn = get_conn()
    try:
        if not conn.execute("SELECT id FROM chat_threads WHERE id = ?", (thread_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Thread not found")
        rows = conn.execute("""
            SELECT id, role, content, created_at
            FROM   chat_messages
            WHERE  thread_id = ?
              AND  NOT (role = 'assistant' AND (content IS NULL OR content = ''))
            ORDER  BY id ASC
        """, (thread_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.delete("/threads/{thread_id}/messages")
def clear_messages(thread_id: int):
    conn = get_conn()
    try:
        conn.execute("DELETE FROM chat_messages WHERE thread_id = ?", (thread_id,))
        conn.commit()
        return {"status": "cleared", "thread_id": thread_id}
    finally:
        conn.close()


# ─── STREAMING MESSAGE ────────────────────────────────────────────────────────

@router.post("/threads/{thread_id}/message")
async def send_message(thread_id: int, body: SendMessage):
    question = body.message.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    conn = get_conn()
    try:
        thread = conn.execute(
            "SELECT * FROM chat_threads WHERE id = ?", (thread_id,)
        ).fetchone()
        if not thread:
            raise HTTPException(status_code=404, detail="Thread not found")

        try:
            injected_entries = json.loads(thread["entry_context"] or "[]")
        except Exception:
            injected_entries = []

        history_rows = conn.execute("""
            SELECT role, content FROM chat_messages
            WHERE  thread_id = ?
              AND  NOT (role = 'assistant' AND (content IS NULL OR content = ''))
            ORDER  BY id DESC
            LIMIT  ?
        """, (thread_id, MAX_HISTORY_MESSAGES)).fetchall()
        history = list(reversed([dict(r) for r in history_rows]))
        is_first_message = len(history) == 0
    finally:
        conn.close()

    # No-entries fast path — use same save pattern to avoid orphaned rows
    if not _has_any_entries() and not injected_entries:
        assistant_msg_id = _save_user_message(thread_id, question)

        async def no_entries_stream():
            yield f"data: {json.dumps({'type': 'token', 'text': NO_ENTRIES_RESPONSE})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            _update_assistant_message(assistant_msg_id, thread_id, NO_ENTRIES_RESPONSE)

        return StreamingResponse(no_entries_stream(), media_type="text/event-stream")

    # Build context block
    context_parts = []
    entry_block = _format_entry_context(injected_entries)
    if entry_block:
        context_parts.append(entry_block)

    try:
        from routes.memory import _get_memory_document
        doc = _get_memory_document()
        if doc and doc.strip():
            context_parts.append(f"ABOUT THIS PERSON (from memory):\n{doc.strip()}")
    except Exception:
        pass

    context_block = "\n\n".join(context_parts)
    system = CHAT_SYSTEM_PROMPT.format(context_block=context_block)

    # Recall query: live ChromaDB lookup
    recall_block = ""
    if _is_recall_query(question):
        recall_block = _get_recall_block(question)

    history_text = _format_conversation_history(history)
    user_turn    = f"{question}\n\n{recall_block}" if recall_block else question

    if history_text:
        prompt = f"{history_text}\n\nUSER: {user_turn}\nWITNESS:"
    else:
        prompt = f"USER: {user_turn}\nWITNESS:"

    # Auto-title thread from first message — strip to last word boundary
    if is_first_message:
        raw_title = question[:60].strip()
        if len(question) > 60:
            # Don't cut mid-word
            last_space = raw_title.rfind(" ")
            if last_space > 20:
                raw_title = raw_title[:last_space]
        if raw_title:
            conn = get_conn()
            try:
                conn.execute(
                    "UPDATE chat_threads SET title = ?, updated_at = datetime('now') "
                    "WHERE id = ? AND title = 'New Thread'",
                    (raw_title, thread_id)
                )
                conn.commit()
            finally:
                conn.close()

    # Save user message + blank assistant placeholder before streaming begins.
    # This ensures the user message is persisted even if the client disconnects.
    assistant_msg_id = _save_user_message(thread_id, question)

    async def stream_response():
        full_text = []
        try:
            # generate_stream already strips <think> blocks via its internal
            # state machine — no need to filter tokens here.
            async for token in generate_stream(
                prompt=prompt,
                system=system,
                temperature=0.75,
                num_ctx=8192,
            ):
                full_text.append(token)
                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"

            complete = "".join(full_text).strip()
            _update_assistant_message(assistant_msg_id, thread_id, complete)

            threading.Thread(
                target=_extract_chat_facts_background,
                args=(question, complete),
                daemon=True
            ).start()

            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as e:
            log.error(f"Chat stream error (thread {thread_id}): {e}")
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"

    return StreamingResponse(
        stream_response(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
