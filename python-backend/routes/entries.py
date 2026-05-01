"""
WITNESS -- Entries API
CRUD operations for journal entries (daily + rant).

ROUTE ORDER NOTE: In FastAPI, routes match top-to-bottom.
All named routes (/streak/current, /dashboard-stats, /search/semantic, /bulk) MUST appear
before the wildcard /{entry_id} route, or FastAPI swallows them.

Bug 2 fix:
  - get_entry() now includes the 'tags' column in its response, so rant
    entries show their topic tags in the Log Browser detail panel.
  - list_entries() includes 'tags' in all rows.
  - semantic_search_entries(): rant branch now queries the entries table
    (not the old rants table) since rants are first-class entries now.
  - delete_entry_route(): ChromaDB cleanup uses the same chroma_id format
    for both entry types ('entry_{id}') since rants use embed_entry().

Step 7 addition:
  - DELETE /bulk: delete multiple entries by ID list in one request.
    Cascades to metrics and qa_pairs via foreign keys. Cleans ChromaDB
    best-effort (silent failure per entry). Returns { deleted: N }.
"""

import json
import logging
from datetime import date, datetime
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_conn

log = logging.getLogger("witness.entries")
router = APIRouter()


# ─── MODELS ──────────────────────────────────────────────────────────────────

class EntryCreate(BaseModel):
    date:       str
    type:       str = "daily"
    transcript: str
    audio_path: Optional[str] = None


class EntryUpdate(BaseModel):
    transcript: Optional[str] = None
    starred:    Optional[bool] = None


class QAPairCreate(BaseModel):
    question: str
    answer:   str = ""


class BulkDeleteBody(BaseModel):
    ids: List[int]


# ─── NAMED ROUTES FIRST (before wildcard /{entry_id}) ────────────────────────

@router.get("/streak/current")
def get_streak():
    """Current journaling streak in days."""
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT DISTINCT date FROM entries
            WHERE type = 'daily'
            ORDER BY date DESC
        """).fetchall()

        if not rows:
            return {"streak": 0}

        dates     = [r["date"] for r in rows]
        today     = date.today().isoformat()
        yesterday = date.fromordinal(date.today().toordinal() - 1).isoformat()

        if dates[0] not in (today, yesterday):
            return {"streak": 0}

        streak = 1
        for i in range(1, len(dates)):
            d1 = date.fromisoformat(dates[i - 1])
            d2 = date.fromisoformat(dates[i])
            if (d1 - d2).days == 1:
                streak += 1
            else:
                break

        return {"streak": streak}

    finally:
        conn.close()


@router.get("/dashboard-stats")
def get_dashboard_stats():
    """Single endpoint for everything the Dashboard needs."""
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT DISTINCT date FROM entries
            WHERE type = 'daily'
            ORDER BY date DESC
        """).fetchall()

        streak = 0
        if rows:
            dates     = [r["date"] for r in rows]
            today     = date.today().isoformat()
            yesterday = date.fromordinal(date.today().toordinal() - 1).isoformat()

            if dates[0] in (today, yesterday):
                streak = 1
                for i in range(1, len(dates)):
                    d1 = date.fromisoformat(dates[i - 1])
                    d2 = date.fromisoformat(dates[i])
                    if (d1 - d2).days == 1:
                        streak += 1
                    else:
                        break

        last = conn.execute("""
            SELECT id, date, created_at, transcript, type
            FROM entries
            WHERE type = 'daily'
            ORDER BY created_at DESC
            LIMIT 1
        """).fetchone()

        last_entry = None
        if last:
            preview = (last["transcript"] or "").strip()[:80]
            last_entry = {
                "id":         last["id"],
                "date":       last["date"],
                "created_at": last["created_at"],
                "preview":    preview,
                "type":       last["type"],
            }

        avg_row = conn.execute("""
            SELECT ROUND(AVG(m.stress), 1) as avg_stress
            FROM metrics m
            JOIN entries e ON e.id = m.entry_id
            WHERE e.date >= date('now', '-7 days')
              AND m.stress IS NOT NULL
        """).fetchone()

        avg_stress = avg_row["avg_stress"] if avg_row else None

        today_count = conn.execute("""
            SELECT COUNT(*) as n FROM entries
            WHERE date = date('now') AND type = 'daily'
        """).fetchone()["n"]

        return {
            "streak":      streak,
            "last_entry":  last_entry,
            "avg_stress":  avg_stress,
            "today_count": today_count,
        }

    finally:
        conn.close()


@router.get("/search/semantic")
def semantic_search_entries(q: str = "", n: int = 10):
    """
    Semantic search across all entries (daily + rant).
    Both types now live in the entries table, so we use a single query.
    Returns [] if ChromaDB is unavailable.
    """
    if not q.strip():
        return []

    n = min(n, 50)

    try:
        from chroma_manager import semantic_search
    except ImportError:
        log.warning("chroma_manager not importable -- returning empty semantic results")
        return []

    matches = semantic_search(q, n_results=n)
    if not matches:
        return []

    conn = get_conn()
    try:
        results = []
        for match in matches:
            entry_id = match.get("entry_id")
            if not entry_id:
                continue

            row = conn.execute("""
                SELECT e.*, m.stress, m.mood, m.anxiety, m.energy, m.sentiment
                FROM   entries e
                LEFT JOIN metrics m ON m.entry_id = e.id
                WHERE  e.id = ?
            """, (entry_id,)).fetchone()

            if row:
                entry = dict(row)
                entry["_semantic_distance"] = match["distance"]
                entry["_search_type"]       = "semantic"
                results.append(entry)

        return results

    finally:
        conn.close()


# ─── BULK DELETE ──────────────────────────────────────────────────────────────

@router.delete("/bulk")
def bulk_delete_entries(body: BulkDeleteBody):
    """
    Delete multiple entries by ID in one request.
    Foreign key CASCADE handles metrics + qa_pairs automatically.
    ChromaDB cleanup is best-effort: failure on one ID never aborts the rest.
    Returns { deleted: N, status: 'ok' }.
    """
    if not body.ids:
        return {"deleted": 0, "status": "ok"}

    # Deduplicate and cap at 500 to prevent accidental wipes
    ids = list(set(body.ids))[:500]

    conn = get_conn()
    try:
        # SQLite doesn't support parameterised lists directly, so we build
        # the placeholder string manually from validated integers.
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"DELETE FROM entries WHERE id IN ({placeholders})",
            ids
        )
        deleted = conn.total_changes
        conn.commit()
    finally:
        conn.close()

    # ChromaDB cleanup — best-effort, silent failure per entry
    for entry_id in ids:
        try:
            from chroma_manager import delete_entry as chroma_delete
            chroma_delete(entry_id)
        except Exception:
            pass

    log.info(f"Bulk delete: removed {deleted} entries (ids={ids[:10]}{'...' if len(ids) > 10 else ''})")
    return {"deleted": deleted, "status": "ok"}


# ─── LIST + SEARCH ────────────────────────────────────────────────────────────

@router.get("/")
def list_entries(
    type:      Optional[str]  = None,
    starred:   Optional[bool] = None,
    date_from: Optional[str]  = None,
    date_to:   Optional[str]  = None,
    keyword:   Optional[str]  = None,
    limit:  int = 50,
    offset: int = 0
):
    """List entries with optional filters. Used by Log Browser."""
    conn = get_conn()
    try:
        conditions = []
        params     = []

        if type:
            conditions.append("e.type = ?")
            params.append(type)

        if starred is not None:
            conditions.append("e.starred = ?")
            params.append(1 if starred else 0)

        if date_from:
            conditions.append("e.date >= ?")
            params.append(date_from)

        if date_to:
            conditions.append("e.date <= ?")
            params.append(date_to)

        if keyword:
            conditions.append("e.transcript LIKE ?")
            params.append(f"%{keyword}%")

        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = conn.execute(f"""
            SELECT e.*, m.stress, m.mood, m.anxiety, m.energy, m.sentiment
            FROM   entries e
            LEFT JOIN metrics m ON m.entry_id = e.id
            {where}
            ORDER BY e.created_at DESC
            LIMIT ? OFFSET ?
        """, params + [limit, offset]).fetchall()

        results = []
        for r in rows:
            row = dict(r)
            for col in ("good_tags", "bad_tags"):
                raw = row.get(col, "[]") or "[]"
                try:
                    row[col] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    row[col] = []
            results.append(row)
        return results

    finally:
        conn.close()


# ─── WILDCARD ROUTE LAST ──────────────────────────────────────────────────────

@router.get("/{entry_id}")
def get_entry(entry_id: int):
    """
    Get a single entry with its QA pairs, metrics, and tags.
    Works for both daily entries and rants -- both live in entries table.
    """
    conn = get_conn()
    try:
        entry = conn.execute(
            "SELECT * FROM entries WHERE id = ?", (entry_id,)
        ).fetchone()

        if not entry:
            raise HTTPException(status_code=404, detail="Entry not found")

        qa = conn.execute(
            "SELECT * FROM qa_pairs WHERE entry_id = ? ORDER BY id", (entry_id,)
        ).fetchall()

        metrics = conn.execute(
            "SELECT * FROM metrics WHERE entry_id = ?", (entry_id,)
        ).fetchone()

        entry_dict = dict(entry)

        raw_tags = entry_dict.get("tags", "[]") or "[]"
        try:
            entry_dict["tags"] = json.loads(raw_tags)
        except (json.JSONDecodeError, TypeError):
            entry_dict["tags"] = []

        for col in ("good_tags", "bad_tags"):
            raw = entry_dict.get(col, "[]") or "[]"
            try:
                entry_dict[col] = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                entry_dict[col] = []

        return {
            **entry_dict,
            "qa_pairs": [dict(q) for q in qa],
            "metrics":  dict(metrics) if metrics else None,
        }

    finally:
        conn.close()


@router.patch("/{entry_id}")
def update_entry(entry_id: int, body: EntryUpdate):
    """Update an entry's transcript or starred status."""
    conn = get_conn()
    try:
        fields, params = [], []

        if body.transcript is not None:
            fields.append("transcript = ?")
            fields.append("edited = 1")
            params.append(body.transcript)

        if body.starred is not None:
            fields.append("starred = ?")
            params.append(1 if body.starred else 0)

        if not fields:
            raise HTTPException(status_code=400, detail="Nothing to update")

        params.append(entry_id)
        conn.execute(
            f"UPDATE entries SET {', '.join(fields)} WHERE id = ?",
            params
        )
        conn.commit()
        return {"status": "updated"}
    finally:
        conn.close()


@router.delete("/{entry_id}")
def delete_entry_route(entry_id: int):
    """Delete an entry and its related data. Also removes from ChromaDB."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        conn.commit()

        try:
            from chroma_manager import delete_entry as chroma_delete
            chroma_delete(entry_id)
        except Exception:
            pass

        return {"status": "deleted"}
    finally:
        conn.close()


@router.post("/")
def create_entry(body: EntryCreate):
    """Save a new journal entry."""
    conn = get_conn()
    try:
        cur = conn.execute("""
            INSERT INTO entries (date, type, transcript, audio_path)
            VALUES (?, ?, ?, ?)
        """, (body.date, body.type, body.transcript, body.audio_path))
        conn.commit()
        return {"id": cur.lastrowid, "status": "created"}
    finally:
        conn.close()


@router.post("/{entry_id}/qa")
def add_qa(entry_id: int, body: QAPairCreate):
    """Add a follow-up Q&A pair to an entry."""
    conn = get_conn()
    try:
        cur = conn.execute("""
            INSERT INTO qa_pairs (entry_id, question, answer)
            VALUES (?, ?, ?)
        """, (entry_id, body.question, body.answer))
        conn.commit()
        return {"id": cur.lastrowid, "status": "created"}
    finally:
        conn.close()


@router.patch("/{entry_id}/qa/{qa_id}")
def update_qa(entry_id: int, qa_id: int, body: dict):
    """Update an answer to a follow-up question."""
    answer = body.get("answer", "")
    conn = get_conn()
    try:
        conn.execute(
            "UPDATE qa_pairs SET answer = ? WHERE id = ? AND entry_id = ?",
            (answer, qa_id, entry_id)
        )
        conn.commit()
        return {"status": "updated"}
    finally:
        conn.close()
