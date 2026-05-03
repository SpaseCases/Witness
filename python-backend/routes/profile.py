"""
WITNESS -- Longitudinal Self-Model API

Endpoints:
  GET  /profile/          -- fetch the current generated profile (or empty state)
  POST /profile/generate  -- generate (or regenerate) the profile from all entries
  GET  /profile/status    -- entry count, last generated, whether regen is due
"""

import json
import logging
import re
from datetime import datetime

from fastapi import APIRouter, HTTPException
from database import get_conn
from ollama_manager import generate
from routes.transcribe import clean_llm_json

log    = logging.getLogger("witness.profile")
router = APIRouter()

# Minimum entries before a profile is worth generating
MIN_ENTRIES = 5

# Auto-regen threshold: if this many new entries have been added since last
# generation, the status endpoint flags it as stale
REGEN_THRESHOLD = 10


# ─── PROMPT ──────────────────────────────────────────────────────────────────

_PROFILE_PROMPT = """You have access to a person's journal entries over time. Your job is to identify their recurring patterns. Do NOT summarize specific events or dates. Focus on who this person is, not what happened to them.

Rules:
- Be specific, not generic. "tends to catastrophize work problems" is good. "experiences stress" is useless.
- Patterns must appear in multiple entries to be included. No single-entry observations.
- Be honest. If the data shows self-sabotage, avoidance, or contradiction, name it.
- The plain_summary should read like a sharp, honest friend describing this person -- not a therapist.
- No em dashes anywhere.
- Return ONLY valid JSON. No markdown fences, no preamble, no extra text.

All journal entries (oldest to newest):
{entries}

Return exactly this JSON format:
{{
  "recurring_themes": ["specific theme 1", "specific theme 2", "specific theme 3"],
  "emotional_patterns": ["specific pattern 1", "specific pattern 2"],
  "apparent_values": ["value or priority 1", "value or priority 2"],
  "recurring_challenges": ["challenge 1", "challenge 2"],
  "plain_summary": "2-3 honest sentences describing this person based purely on what they journal about."
}}"""


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def _fetch_all_entries(conn) -> list[dict]:
    """
    Pull all daily entries oldest-to-newest.
    Uses structured_summary if available (shorter), else first 300 chars of transcript.
    """
    rows = conn.execute("""
        SELECT e.date, e.transcript, e.structured_summary,
               m.stress, m.mood, m.energy
        FROM   entries e
        LEFT JOIN metrics m ON m.entry_id = e.id
        WHERE  e.type = 'daily' AND e.transcript != ''
        ORDER  BY e.date ASC
    """).fetchall()
    return [dict(r) for r in rows]


def _build_entry_text(entries: list[dict]) -> str:
    """Condense entries into a prompt-safe string."""
    lines = []
    for e in entries:
        ss = e.get("structured_summary")
        summary_text = ""
        if ss:
            try:
                parsed = json.loads(ss)
                s = parsed.get("summary", "")
                h = parsed.get("highlights", [])
                if s:
                    summary_text = s
                    if h:
                        summary_text += " " + " | ".join(h[:3])
            except Exception:
                pass

        if not summary_text:
            summary_text = (e.get("transcript") or "").strip()[:300]

        if not summary_text:
            continue

        scores = []
        for k in ("stress", "mood", "energy"):
            if e.get(k) is not None:
                scores.append(f"{k}={e[k]}")
        score_str = f" ({', '.join(scores)})" if scores else ""

        lines.append(f"[{e['date']}{score_str}] {summary_text}")

    return "\n".join(lines)


def _get_profile_row(conn):
    return conn.execute(
        "SELECT * FROM user_profile ORDER BY generated_at DESC LIMIT 1"
    ).fetchone()


def _entry_count(conn) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM entries WHERE type='daily' AND transcript != ''"
    ).fetchone()
    return row["n"] if row else 0


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@router.get("/")
def get_profile():
    """
    Return the most recently generated profile, or an empty-state response
    if no profile has been generated yet.
    """
    conn = get_conn()
    try:
        row   = _get_profile_row(conn)
        count = _entry_count(conn)

        if not row:
            return {
                "status":       "not_generated",
                "entry_count":  count,
                "min_entries":  MIN_ENTRIES,
                "message":      f"No profile generated yet. Need at least {MIN_ENTRIES} entries.",
            }

        return {
            "status":               "ok",
            "generated_at":         row["generated_at"],
            "entry_count_at_gen":   row["entry_count_at_generation"],
            "current_entry_count":  count,
            "stale": (count - (row["entry_count_at_generation"] or 0)) >= REGEN_THRESHOLD,
            "recurring_themes":     json.loads(row["recurring_themes"]    or "[]"),
            "emotional_patterns":   json.loads(row["emotional_patterns"]  or "[]"),
            "apparent_values":      json.loads(row["apparent_values"]     or "[]"),
            "recurring_challenges": json.loads(row["recurring_challenges"] or "[]"),
            "plain_summary":        row["plain_summary"] or "",
        }
    finally:
        conn.close()


@router.post("/generate")
async def generate_profile():
    """
    Generate (or regenerate) the longitudinal self-model from all entries.
    Takes 30-90 seconds depending on model and entry count.
    Returns the completed profile.
    """
    conn = get_conn()
    try:
        count = _entry_count(conn)

        if count < MIN_ENTRIES:
            raise HTTPException(
                status_code=400,
                detail=f"Need at least {MIN_ENTRIES} entries to generate a profile. You have {count}."
            )

        entries    = _fetch_all_entries(conn)
        entry_text = _build_entry_text(entries)

        if not entry_text.strip():
            raise HTTPException(status_code=400, detail="No readable entry content found.")

        # Cap prompt size -- use most recent 200 entries if very prolific
        if len(entries) > 200:
            entries    = entries[-200:]
            entry_text = _build_entry_text(entries)
            log.info("Profile: capped to 200 most recent entries for prompt size.")

        log.info(f"Profile: generating from {len(entries)} entries ({len(entry_text)} chars)...")

        prompt   = _PROFILE_PROMPT.format(entries=entry_text[:12000])
        response = await generate(prompt, temperature=0.4, max_tokens=800)

        try:
            clean  = clean_llm_json(response)
            parsed = json.loads(clean)
        except Exception:
            log.error(f"Profile JSON parse failed. Raw: {response[:400]}")
            raise HTTPException(
                status_code=500,
                detail="AI returned an invalid format. Try regenerating -- this sometimes happens with short or very uniform entry histories."
            )

        # Validate and sanitise fields
        themes     = [str(x).strip() for x in parsed.get("recurring_themes",    []) if str(x).strip()][:8]
        patterns   = [str(x).strip() for x in parsed.get("emotional_patterns",  []) if str(x).strip()][:6]
        values     = [str(x).strip() for x in parsed.get("apparent_values",     []) if str(x).strip()][:6]
        challenges = [str(x).strip() for x in parsed.get("recurring_challenges",[]) if str(x).strip()][:6]
        summary    = str(parsed.get("plain_summary", "")).strip()

        now = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

        conn.execute("""
            INSERT INTO user_profile
                (generated_at, recurring_themes, emotional_patterns,
                 apparent_values, recurring_challenges, plain_summary,
                 entry_count_at_generation)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            now,
            json.dumps(themes),
            json.dumps(patterns),
            json.dumps(values),
            json.dumps(challenges),
            summary,
            count,
        ))
        conn.commit()

        log.info(f"Profile: saved. {len(themes)} themes, {len(patterns)} patterns, {len(challenges)} challenges.")

        return {
            "status":               "generated",
            "generated_at":         now,
            "entry_count_at_gen":   count,
            "current_entry_count":  count,
            "stale":                False,
            "recurring_themes":     themes,
            "emotional_patterns":   patterns,
            "apparent_values":      values,
            "recurring_challenges": challenges,
            "plain_summary":        summary,
        }

    finally:
        conn.close()


@router.get("/status")
def get_profile_status():
    """
    Lightweight check: returns entry count, last generation time,
    and whether a regen is due. Used by the UI to show stale badges.
    """
    conn = get_conn()
    try:
        count = _entry_count(conn)
        row   = _get_profile_row(conn)

        if not row:
            return {
                "has_profile":  False,
                "entry_count":  count,
                "min_entries":  MIN_ENTRIES,
                "stale":        False,
                "generated_at": None,
            }

        new_since = count - (row["entry_count_at_generation"] or 0)
        return {
            "has_profile":   True,
            "entry_count":   count,
            "min_entries":   MIN_ENTRIES,
            "stale":         new_since >= REGEN_THRESHOLD,
            "new_since_gen": new_since,
            "generated_at":  row["generated_at"],
        }
    finally:
        conn.close()
