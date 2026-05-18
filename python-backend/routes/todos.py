# Bug fix: datetime import added; due_date format validated (YYYY-MM-DD) in
#          create_todo and update_todo — previously any string was accepted,
#          silently breaking cleanup_expired_todos() date comparisons.
# Updated: Step 8 — added due_date to TodoCreate/TodoUpdate, cleanup_expired_todos(),
#          GET /todos/cleanup endpoint, PATCH saves due_date.
"""
WITNESS — To-Do API
CRUD operations for the todos table.

Endpoints:
  GET    /todos/              — list all todos (newest first)
  POST   /todos/              — create a new task
  PATCH  /todos/{id}          — update done, text, due_date, or append a note
  DELETE /todos/bulk          — bulk delete multiple tasks
  DELETE /todos/{id}          — delete a task
  DELETE /todos/{id}/note/{i} — delete one note from a todo
  GET    /todos/{id}/detail   — full detail: todo + all source entry data
  GET    /todos/cleanup       — delete expired todos (due_date < today, not done)
"""

import logging
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_conn

log    = logging.getLogger("witness.todos")
router = APIRouter()


# ─── SCHEMAS ─────────────────────────────────────────────────────────────────

class TodoCreate(BaseModel):
    text:            str
    source_entry_id: Optional[int] = None
    source_date:     Optional[str] = None
    due_date:        Optional[str] = None


class TodoUpdate(BaseModel):
    done:        Optional[bool] = None
    text:        Optional[str]  = None
    append_note: Optional[str]  = None   # adds a note string to the notes JSON array
    due_date:    Optional[str]  = None   # YYYY-MM-DD or empty string to clear


class BulkDeleteBody(BaseModel):
    ids: list[int]


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    d = dict(row)
    # Parse notes JSON array — stored as text, returned as list
    try:
        d["notes"] = json.loads(d.get("notes") or "[]")
    except Exception:
        d["notes"] = []
    return d


def cleanup_expired_todos() -> int:
    """
    Delete todos where due_date < today and done = 0.
    Returns the number of rows deleted.
    Called at startup and hourly.
    """
    conn = get_conn()
    try:
        result = conn.execute(
            "DELETE FROM todos WHERE due_date IS NOT NULL AND due_date < date('now') AND done = 0"
        )
        conn.commit()
        count = result.rowcount
        if count:
            log.info(f"cleanup_expired_todos: deleted {count} overdue task(s).")
        return count
    finally:
        conn.close()


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@router.get("/")
def list_todos():
    """
    Return all todos. Undone tasks come first (newest first),
    then completed tasks (most recently done first).
    """
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT * FROM todos
            ORDER BY
                done ASC,
                CASE WHEN done = 0 THEN created_at END DESC,
                CASE WHEN done = 1 THEN done_at    END DESC
        """).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/")
def create_todo(body: TodoCreate):
    """Create a new task."""
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Task text cannot be empty")

    due_date = None
    if body.due_date and body.due_date.strip():
        try:
            datetime.strptime(body.due_date.strip(), "%Y-%m-%d")
            due_date = body.due_date.strip()
        except ValueError:
            raise HTTPException(status_code=400, detail="due_date must be YYYY-MM-DD format")

    conn = get_conn()
    try:
        cur = conn.execute("""
            INSERT INTO todos (text, source_entry_id, source_date, notes, is_project, due_date)
            VALUES (?, ?, ?, '[]', 0, ?)
        """, (text, body.source_entry_id, body.source_date, due_date))
        conn.commit()
        row = conn.execute("SELECT * FROM todos WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _row_to_dict(row)
    finally:
        conn.close()


@router.patch("/{todo_id}")
def update_todo(todo_id: int, body: TodoUpdate):
    """
    Update a task. Supports:
      - done: true/false  → mark complete/incomplete
      - text: str         → rename the task
      - append_note: str  → add a note to the notes JSON array
    """
    conn = get_conn()
    try:
        existing = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Todo not found")

        if body.done is not None:
            if body.done:
                conn.execute(
                    "UPDATE todos SET done = 1, done_at = datetime('now') WHERE id = ?",
                    (todo_id,)
                )
            else:
                conn.execute(
                    "UPDATE todos SET done = 0, done_at = NULL WHERE id = ?",
                    (todo_id,)
                )

        if body.text is not None:
            text = body.text.strip()
            if not text:
                raise HTTPException(status_code=400, detail="Task text cannot be empty")
            conn.execute("UPDATE todos SET text = ? WHERE id = ?", (text, todo_id))

        if body.append_note is not None:
            note = body.append_note.strip()
            if note:
                try:
                    notes = json.loads(existing["notes"] or "[]")
                except Exception:
                    notes = []
                notes.append(note)
                conn.execute(
                    "UPDATE todos SET notes = ? WHERE id = ?",
                    (json.dumps(notes), todo_id)
                )

        if body.due_date is not None:
            # Empty string = clear the due date; valid YYYY-MM-DD = set it
            if body.due_date.strip():
                try:
                    datetime.strptime(body.due_date.strip(), "%Y-%m-%d")
                    new_due = body.due_date.strip()
                except ValueError:
                    raise HTTPException(status_code=400, detail="due_date must be YYYY-MM-DD format")
            else:
                new_due = None
            conn.execute("UPDATE todos SET due_date = ? WHERE id = ?", (new_due, todo_id))

        conn.commit()
        row = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        return _row_to_dict(row)
    finally:
        conn.close()


@router.get("/cleanup")
def run_cleanup():
    """Manually trigger expired todo cleanup. Returns count deleted."""
    count = cleanup_expired_todos()
    return {"deleted": count, "status": "ok"}


@router.delete("/bulk")
def bulk_delete_todos(body: BulkDeleteBody):
    """
    Delete multiple todos in a single transaction.
    Body: { "ids": [1, 2, 3, ...] }
    Returns: { "deleted": N, "status": "ok" }
    """
    if not body.ids:
        return {"deleted": 0, "status": "ok"}

    conn = get_conn()
    try:
        placeholders = ",".join("?" * len(body.ids))
        result = conn.execute(
            f"DELETE FROM todos WHERE id IN ({placeholders})",
            body.ids
        )
        conn.commit()
        return {"deleted": result.rowcount, "status": "ok"}
    finally:
        conn.close()


@router.delete("/{todo_id}")
def delete_todo(todo_id: int):
    """Delete a task permanently."""
    conn = get_conn()
    try:
        conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
        conn.commit()
        return {"status": "deleted"}
    finally:
        conn.close()


@router.delete("/{todo_id}/note/{note_index}")
def delete_note(todo_id: int, note_index: int):
    """Delete a single note from a todo's notes array by index."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Todo not found")

        try:
            notes = json.loads(row["notes"] or "[]")
        except Exception:
            notes = []

        if note_index < 0 or note_index >= len(notes):
            raise HTTPException(status_code=404, detail="Note index out of range")

        notes.pop(note_index)
        conn.execute("UPDATE todos SET notes = ? WHERE id = ?", (json.dumps(notes), todo_id))
        conn.commit()
        row = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        return _row_to_dict(row)
    finally:
        conn.close()


@router.get("/{todo_id}/detail")
def get_todo_detail(todo_id: int):
    """
    Return full detail for a todo:
      - The todo itself (text, notes, dates, is_project)
      - The source journal entry transcript + date (if AI-generated)
      - All other AI-extracted todos that came from the same entry
    """
    conn = get_conn()
    try:
        todo = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
        if not todo:
            raise HTTPException(status_code=404, detail="Todo not found")

        todo_dict = _row_to_dict(todo)

        source_entry = None
        related_todos = []

        if todo_dict.get("source_entry_id"):
            entry_id = todo_dict["source_entry_id"]

            # Get the source journal entry
            entry = conn.execute(
                "SELECT id, date, transcript, type, created_at FROM entries WHERE id = ?",
                (entry_id,)
            ).fetchone()
            if entry:
                source_entry = dict(entry)

            # Get other todos that came from the same entry
            others = conn.execute("""
                SELECT * FROM todos
                WHERE source_entry_id = ? AND id != ?
                ORDER BY created_at ASC
            """, (entry_id, todo_id)).fetchall()
            related_todos = [_row_to_dict(r) for r in others]

        return {
            "todo":          todo_dict,
            "source_entry":  source_entry,
            "related_todos": related_todos,
        }
    finally:
        conn.close()
