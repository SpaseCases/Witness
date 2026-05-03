"""
WITNESS — AI Memory System (Step 5)
====================================
Two-layer persistent memory:

  Layer B — Living Memory Document
    A structured, AI-maintained personal context document stored in the
    settings table under key 'memory_document'. Updated automatically
    after every journal entry via start_memory_update(). Can also be
    regenerated on demand via POST /memory/regenerate.

  Layer C — Episodic RAG Recall
    Uses the existing ChromaDB collection to find the N most semantically
    similar past entries for any given text. Called by other routes
    (questions, insights, chat) to inject relevant history into prompts.

Endpoints:
  GET  /memory/                 -- current memory document + stats
  POST /memory/regenerate       -- rewrite the full memory document from all entries
  POST /memory/recall           -- find relevant past entries for a given text
  GET  /memory/facts            -- list extracted atomic facts
  DELETE /memory/facts/{id}     -- remove a single fact
  POST /memory/reset            -- wipe memory document (keeps entries)
"""

import json
import re
import asyncio
import logging
import threading
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import get_conn, get_setting, set_setting

router = APIRouter()
log    = logging.getLogger("witness.memory")


# ═══════════════════════════════════════════════════════════════════════════════
# PROMPTS
# ═══════════════════════════════════════════════════════════════════════════════

_REGENERATE_PROMPT = """You are building a personal context document for an AI journal assistant.

Read the journal entries below and write a compact, honest personal profile.
This profile is used to give the AI memory of who this person is over time.

Rules:
- Write in first person ("I am...", "I tend to...", "My recurring challenges include...")
- Be honest and specific — name actual things they mentioned, not generic traits
- Cover: who they are, their recurring themes, current stressors, goals, relationships, patterns
- 4-6 sentences maximum. Tight and dense, not verbose.
- Do NOT use bullet points or lists — write it as a paragraph
- Do NOT invent things not supported by the entries
- Return ONLY the paragraph, no preamble, no explanation

Journal entries:
{entries}

Personal context document:"""


_EXTRACT_FACTS_PROMPT = """You are reading a new journal entry to extract any NEW personal facts not already known.

Existing known facts about this person:
{existing_facts}

New journal entry ({entry_type}):
{transcript}

Extract ONLY facts that are new, specific, and durable (not moods or events, but persistent facts about who they are).
Examples of good facts: "has a sister named Rachel", "works as a nurse", "hates confrontation", "training for a marathon"
Examples of bad facts: "felt tired today", "had a good meeting" (these are events, not durable facts)

Return ONLY a JSON array of strings. If no new facts found, return [].
["fact 1", "fact 2"]"""


_COMPRESS_PROMPT = """You are compressing a personal context document. It has grown too long.

Rewrite it as a tight 4-6 sentence first-person paragraph that preserves the most important
and specific facts. Cut vague or repetitive content. Keep named people, places, goals, patterns.

Original document:
{document}

Compressed document (4-6 sentences, first person, no bullets):"""


_RECALL_CONTEXT_TEMPLATE = """
--- RELEVANT PAST ENTRIES (for context) ---
{entries}
--- END PAST ENTRIES ---
"""


# ═══════════════════════════════════════════════════════════════════════════════
# SCHEMAS
# ═══════════════════════════════════════════════════════════════════════════════

class RegenerateRequest(BaseModel):
    max_entries: int = 80

class RecallRequest(BaseModel):
    text:      str
    n_results: int = 5
    min_similarity: float = 0.3   # distance threshold (0=identical, 1=unrelated)

class FactDeleteRequest(BaseModel):
    pass


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _clean_ai_text(raw: str) -> str:
    """Strip DeepSeek think blocks and markdown fences."""
    text = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL)
    text = re.sub(r'```[a-z]*\n?', '', text)
    text = text.replace('```', '').strip().strip('"').strip()
    return text


def _get_memory_document() -> str:
    return get_setting('memory_document', '')


def _get_known_facts() -> list[str]:
    """Return list of fact strings from the memory_facts table."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT fact FROM memory_facts WHERE dismissed=0 ORDER BY created_at ASC"
        ).fetchall()
        return [r['fact'] for r in rows]
    finally:
        conn.close()


def _save_facts(facts: list[str]):
    """Insert new facts, skipping near-duplicates (simple substring check)."""
    if not facts:
        return
    conn = get_conn()
    try:
        existing = [r['fact'].lower() for r in
                    conn.execute("SELECT fact FROM memory_facts WHERE dismissed=0").fetchall()]
        added = 0
        for fact in facts:
            fact = fact.strip()
            if not fact:
                continue
            # Skip if very similar to something we already have
            if any(fact.lower() in ex or ex in fact.lower() for ex in existing):
                continue
            conn.execute(
                "INSERT INTO memory_facts (fact, created_at) VALUES (?, datetime('now'))",
                (fact,)
            )
            existing.append(fact.lower())
            added += 1
        conn.commit()
        if added:
            log.info(f"Memory: saved {added} new facts.")
    finally:
        conn.close()


def _fetch_entries_for_regeneration(max_entries: int = 80) -> list[dict]:
    """Pull entries from SQLite for memory regeneration."""
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT date, type, transcript
            FROM entries
            WHERE transcript IS NOT NULL AND LENGTH(TRIM(transcript)) > 20
            ORDER BY date ASC, id ASC
            LIMIT ?
        """, (max_entries,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def _format_entries_for_prompt(rows: list[dict], max_chars_each: int = 600) -> str:
    blocks = []
    for row in rows:
        date_str = row.get('date') or 'unknown'
        kind     = 'ENTRY' if row.get('type') == 'daily' else (row.get('type') or 'entry').upper()
        text     = (row.get('transcript') or '').strip()
        if len(text) > max_chars_each:
            text = text[:max_chars_each] + '...'
        blocks.append(f"[{date_str} — {kind}]\n{text}")
    return '\n\n'.join(blocks)


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER B — LIVING MEMORY DOCUMENT
# ═══════════════════════════════════════════════════════════════════════════════

async def _async_regenerate_document(max_entries: int = 80) -> str:
    """
    Async: rebuild the memory document from scratch using all entries.
    Returns the new document text.
    """
    from ollama_manager import generate

    rows = _fetch_entries_for_regeneration(max_entries)
    if not rows:
        raise ValueError("No entries found to build memory from.")

    entries_text = _format_entries_for_prompt(rows)
    prompt       = _REGENERATE_PROMPT.format(entries=entries_text)

    raw  = await generate(prompt=prompt, temperature=0.35, max_tokens=500)
    text = _clean_ai_text(raw)

    if not text or len(text) < 20:
        raise ValueError("AI returned empty memory document.")

    set_setting('memory_document', text)
    set_setting('memory_document_updated', datetime.utcnow().isoformat())
    log.info(f"Memory: document regenerated from {len(rows)} entries ({len(text)} chars).")
    return text


def _sync_extract_facts(transcript: str, entry_type: str = 'daily'):
    """
    Synchronous (for background thread): extract new atomic facts from a transcript
    and save them to the memory_facts table.
    """
    try:
        from ollama_manager import generate

        existing = _get_known_facts()
        existing_text = '\n'.join(f'- {f}' for f in existing) if existing else '(none yet)'

        prompt = _EXTRACT_FACTS_PROMPT.format(
            existing_facts=existing_text[:3000],
            entry_type=entry_type,
            transcript=transcript[:2500]
        )

        raw   = asyncio.run(generate(prompt=prompt, temperature=0.25, max_tokens=300))
        clean = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()

        match = re.search(r'\[[^\]]*\]', clean, re.DOTALL)
        if not match:
            # Try the raw text in case think block stripped it
            match = re.search(r'\[[^\]]*\]', raw, re.DOTALL)

        if match:
            facts = json.loads(match.group())
            if isinstance(facts, list):
                _save_facts([str(f).strip() for f in facts if f])
    except Exception as e:
        log.warning(f"Memory fact extraction failed (non-fatal): {e}")


def _sync_update_document_incremental(transcript: str, entry_type: str = 'daily'):
    """
    Synchronous (for background thread): if the memory document exists, update it
    with facts from the new transcript. If it doesn't exist yet, build it fresh.
    """
    try:
        from ollama_manager import generate

        existing_doc = _get_memory_document()

        if not existing_doc or len(existing_doc.strip()) < 30:
            # No document yet — build fresh (fire and forget, uses last 30 entries)
            rows = _fetch_entries_for_regeneration(30)
            if rows:
                entries_text = _format_entries_for_prompt(rows)
                prompt = _REGENERATE_PROMPT.format(entries=entries_text)
                raw  = asyncio.run(generate(prompt=prompt, temperature=0.35, max_tokens=500))
                text = _clean_ai_text(raw)
                if text and len(text) > 20:
                    set_setting('memory_document', text)
                    set_setting('memory_document_updated', datetime.utcnow().isoformat())
                    log.info(f"Memory: initial document created ({len(text)} chars).")
            return

        # Document exists — check if it's getting too long and needs compression
        if len(existing_doc) > 6000:
            compress_prompt = _COMPRESS_PROMPT.format(document=existing_doc[:6000])
            raw_compressed  = asyncio.run(generate(prompt=compress_prompt, temperature=0.2, max_tokens=600))
            compressed      = _clean_ai_text(raw_compressed)
            if compressed and len(compressed) > 30:
                existing_doc = compressed
                set_setting('memory_document', existing_doc)
                log.info(f"Memory: document compressed to {len(existing_doc)} chars.")

        # The document is healthy — fact extraction runs separately
        set_setting('memory_document_updated', datetime.utcnow().isoformat())

    except Exception as e:
        log.warning(f"Memory document update failed (non-fatal): {e}")


def start_memory_update(transcript: str, entry_type: str = 'daily'):
    """
    Fire-and-forget: launch both fact extraction and document update in background.
    Call this from the transcribe/write/rant routes after a successful save.
    """
    def _run():
        _sync_extract_facts(transcript, entry_type)
        _sync_update_document_incremental(transcript, entry_type)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    log.debug("Memory: background update thread started.")


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER C — EPISODIC RAG RECALL
# ═══════════════════════════════════════════════════════════════════════════════

def recall_relevant_entries(text: str, n: int = 5, min_similarity: float = 0.35) -> list[dict]:
    """
    Find the N most semantically similar past entries in ChromaDB.
    Returns a list of dicts with: date, type, transcript, distance.
    Filters out entries with distance > min_similarity threshold.
    Safe — returns [] if ChromaDB is unavailable.
    """
    try:
        from chroma_manager import semantic_search

        results = semantic_search(text, n_results=n + 2)   # fetch a few extra, filter below
        if not results:
            return []

        # Filter by similarity threshold
        close = [r for r in results if r.get('distance', 1.0) <= min_similarity]
        if not close:
            return []

        # Fetch the actual transcript text from SQLite
        conn = get_conn()
        try:
            enriched = []
            for r in close[:n]:
                entry_id = r.get('entry_id')
                if not entry_id:
                    continue
                row = conn.execute(
                    "SELECT date, type, transcript FROM entries WHERE id=?",
                    (entry_id,)
                ).fetchone()
                if not row:
                    continue
                transcript = (row['transcript'] or '').strip()
                if len(transcript) > 500:
                    transcript = transcript[:500] + '...'
                enriched.append({
                    'date':       row['date'],
                    'type':       row['type'],
                    'transcript': transcript,
                    'distance':   r['distance'],
                    'entry_id':   entry_id,
                })
            return enriched
        finally:
            conn.close()

    except Exception as e:
        log.warning(f"Memory recall failed (non-fatal): {e}")
        return []


def build_memory_context_block(transcript: str, n: int = 4) -> str:
    """
    Build a formatted context block to inject into AI prompts.
    Combines the living memory document with episodic recall.
    Returns empty string if no memory available.
    """
    parts = []

    # Layer B: living memory document
    doc = _get_memory_document()
    if doc and doc.strip():
        parts.append(f"ABOUT THIS PERSON:\n{doc.strip()}")

    # Layer C: relevant past entries
    recalled = recall_relevant_entries(transcript, n=n)
    if recalled:
        entry_lines = []
        for r in recalled:
            date_str = r.get('date', 'unknown')
            text     = r.get('transcript', '')
            entry_lines.append(f"[{date_str}] {text}")
        parts.append("RELEVANT PAST ENTRIES:\n" + '\n\n'.join(entry_lines))

    if not parts:
        return ''

    return '\n\n'.join(parts)


# ═══════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/")
async def get_memory():
    """Return the current memory document and fact count."""
    doc          = _get_memory_document()
    updated_at   = get_setting('memory_document_updated', '')
    facts        = _get_known_facts()
    entry_count  = 0
    conn = get_conn()
    try:
        row = conn.execute("SELECT COUNT(*) as c FROM entries WHERE LENGTH(TRIM(transcript)) > 20").fetchone()
        entry_count = row['c'] if row else 0
    finally:
        conn.close()

    return {
        "memory_document": doc,
        "document_length": len(doc),
        "updated_at":      updated_at,
        "fact_count":      len(facts),
        "entry_count":     entry_count,
        "has_memory":      len(doc.strip()) > 20,
    }


@router.post("/regenerate")
async def regenerate_memory(body: RegenerateRequest = RegenerateRequest()):
    """
    Rewrite the memory document from scratch using all entries.
    Also re-extracts all atomic facts from recent entries.
    This is the manual 'rebuild' button.
    """
    try:
        text = await _async_regenerate_document(max_entries=body.max_entries)
        facts = _get_known_facts()
        return {
            "status":          "ok",
            "memory_document": text,
            "document_length": len(text),
            "fact_count":      len(facts),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.error(f"Memory regeneration failed: {e}")
        raise HTTPException(status_code=500, detail=f"Regeneration failed: {str(e)}")


@router.post("/recall")
async def recall_entries(body: RecallRequest):
    """
    Find semantically similar past entries for a given piece of text.
    Used internally by questions/insights routes; also callable from the frontend.
    """
    if not body.text or len(body.text.strip()) < 10:
        return {"entries": [], "status": "text_too_short"}

    entries = recall_relevant_entries(body.text, n=body.n_results, min_similarity=body.min_similarity)
    return {
        "entries": entries,
        "count":   len(entries),
        "status":  "ok",
    }


@router.get("/facts")
async def get_facts():
    """Return all stored atomic facts."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, fact, created_at, dismissed FROM memory_facts ORDER BY created_at ASC"
        ).fetchall()
        return {
            "facts":  [dict(r) for r in rows],
            "count":  len(rows),
        }
    finally:
        conn.close()


@router.delete("/facts/{fact_id}")
async def delete_fact(fact_id: int):
    """Dismiss (soft-delete) a single fact."""
    conn = get_conn()
    try:
        conn.execute("UPDATE memory_facts SET dismissed=1 WHERE id=?", (fact_id,))
        conn.commit()
        return {"status": "ok", "deleted": fact_id}
    finally:
        conn.close()


@router.post("/reset")
async def reset_memory():
    """Wipe the memory document and all facts. Does NOT delete journal entries."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM memory_facts")
        conn.commit()
    finally:
        conn.close()
    set_setting('memory_document', '')
    set_setting('memory_document_updated', '')
    log.info("Memory: full reset performed.")
    return {"status": "ok", "message": "Memory document and all facts cleared."}
