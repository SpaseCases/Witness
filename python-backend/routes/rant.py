"""
witness/python-backend/routes/rant.py

Bug 2 fix:
  - save_rant() now INSERTs into the entries table (type='rant', tags=JSON)
    instead of the old separate rants table.
  - This means GET /entries/{id} works correctly for rants -- no more 404.
  - call_ollama() removed. Now uses generate() from ollama_manager, which
    reads the active model from settings (Bug 1 fix).
  - ChromaDB embedding updated to use entry_id (from entries table) and
    calls embed_entry() instead of embed_rant(), since rants are now
    first-class entries.
"""

import json
import re
import threading
from datetime import datetime, date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_conn
from ollama_manager import generate
from routes.transcribe import start_context_update

router = APIRouter()


# ─── SCHEMAS ──────────────────────────────────────────────────────────────────

class TagsRequest(BaseModel):
    transcript: str

class SaveRequest(BaseModel):
    transcript: str
    tags: list[str] = []


# ─── HELPERS ──────────────────────────────────────────────────────────────────

def extract_json_array(text: str) -> list:
    match = re.search(r'\[.*?\]', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass
    return []


def _embed_entry_background(entry_id: int, transcript: str, entry_date: str):
    """
    Embed the rant into ChromaDB in a background thread after save.
    Uses embed_entry() since rants are now stored in the entries table.
    Non-blocking -- if it fails, the entry is still saved.
    """
    try:
        from chroma_manager import embed_entry
        embed_entry(entry_id=entry_id, text=transcript, entry_date=entry_date)
    except Exception as e:
        import logging
        logging.getLogger("witness.rant").warning(
            f"ChromaDB embed failed for rant entry {entry_id}: {e}"
        )


# ─── ROUTES ───────────────────────────────────────────────────────────────────

@router.post('/tags')
async def get_tags(req: TagsRequest):
    """Extract topic tags from a rant transcript using the active model."""
    if not req.transcript.strip():
        return {'tags': []}

    prompt = f"""You are a topic extraction system for a personal AI journal.

Extract 3-7 concise topic tags from this personal monologue. Tags should be:
- 2-4 words max, lowercase
- Specific to what the person actually talked about
- Useful for future pattern detection (e.g. "work stress", "family conflict", "financial anxiety")

Return ONLY a JSON array of strings. No explanation, no markdown.

Transcript:
{req.transcript[:2000]}

Tags:"""

    try:
        raw  = await generate(prompt=prompt, temperature=0.3, max_tokens=256)
        # Strip DeepSeek <think> tags
        raw  = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL).strip()
        tags = extract_json_array(raw)

        if not tags and raw:
            tags = [t.strip().strip('"').lower()
                    for t in raw.replace('[','').replace(']','').split(',')
                    if t.strip()]

        tags = [str(t)[:40] for t in tags[:8] if t]
    except Exception:
        tags = []

    return {'tags': tags}


@router.post('/save')
async def save_rant(req: SaveRequest):
    """
    Persist a rant to the entries table (type='rant').
    Tags are stored as JSON in the 'tags' column.
    Kicks off ChromaDB embedding in a background thread.
    """
    if not req.transcript.strip():
        raise HTTPException(status_code=400, detail='No transcript provided')

    today     = date.today().isoformat()
    tags_json = json.dumps(req.tags)

    conn = get_conn()
    try:
        cur = conn.execute("""
            INSERT INTO entries (date, type, transcript, tags)
            VALUES (?, 'rant', ?, ?)
        """, (today, req.transcript, tags_json))
        new_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()

    # Embed into ChromaDB in the background
    thread = threading.Thread(
        target=_embed_entry_background,
        args=(new_id, req.transcript, today),
        daemon=True
    )
    thread.start()

    # Fire-and-forget: update personal context profile from the rant
    if req.transcript.strip():
        start_context_update(req.transcript, entry_type='rant')

    return {'id': new_id, 'saved': True}
