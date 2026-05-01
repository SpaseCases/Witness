"""
WITNESS — Insights & Flags API
AI analyzes journal history and surfaces honest behavioral patterns.
No sugarcoating. Cites specific entries as evidence.

Bug fixes in this version:
  - METRIC_EXTRACTION_PROMPT: literal braces in the JSON example were unescaped,
    causing Python's .format(transcript=...) to raise KeyError and return a 500.
    Fixed by doubling all literal braces: { -> {{ and } -> }}.
  - clean_llm_json(): replaces the broken .strip("```json") pattern.
  - DeepSeek R1 <think> tags stripped before JSON parsing.
"""

import json
import re
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from database import get_conn, get_setting
from ollama_manager import generate

log = logging.getLogger("witness.insights")
router = APIRouter()

# ─── JSON CLEANING HELPER ─────────────────────────────────────────────────────

def clean_llm_json(raw: str) -> str:
    """
    Strip DeepSeek <think> blocks and markdown code fences from a raw
    LLM response, leaving only the JSON content ready for json.loads().
    """
    # 1. Remove <think>...</think> blocks (DeepSeek R1 chain-of-thought)
    text = re.sub(r'<think>.*?</think>', '', raw, flags=re.DOTALL)

    # 2. Extract content from markdown code fences if present
    fence_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fence_match:
        text = fence_match.group(1)

    return text.strip()


# ─── PROMPTS ──────────────────────────────────────────────────────────────────

# IMPORTANT: any literal { or } that appear in the prompt text (not format placeholders)
# must be doubled — {{ and }} — so Python's .format() treats them as literal characters.
# Failure to do this causes a KeyError -> 500 when the prompt is rendered.

METRIC_EXTRACTION_PROMPT = """You are analyzing a personal journal entry to extract quantified metrics.

The user's journal entry transcript is below. Extract the following scores on a 1-10 scale based on what is described. If a metric cannot be determined from the text, return null.

Metrics to extract:
- stress: How stressed does the person seem? (1=totally calm, 10=overwhelmed)
- mood: Overall mood quality (1=very bad, 10=excellent)
- anxiety: Anxiety or worry level (1=none, 10=severe)
- energy: Physical/mental energy (1=exhausted, 10=highly energized)
- mental_clarity: Focus and cognitive sharpness (1=foggy, 10=crystal clear)
- productivity: How productive was their day (1=nothing done, 10=highly productive)
- social_sat: Satisfaction with social interactions today (1=very isolated/negative, 10=very connected/positive)
- sentiment: Overall emotional tone (-1.0=very negative, 0=neutral, 1.0=very positive)

Return ONLY a valid JSON object. No explanation. No extra text. Example:
{{"stress": 7, "mood": 4, "anxiety": 6, "energy": 3, "mental_clarity": 4, "productivity": 5, "social_sat": 3, "sentiment": -0.3}}

Journal entry:
{transcript}"""


FOLLOW_UP_PROMPT = """You are an honest, direct journaling assistant. You've just heard someone's daily journal entry and you have context from their past entries.

Your job: Generate exactly 3 follow-up questions that will extract the most useful information.

Rules:
- Be direct and specific — not generic wellness questions
- Reference what they actually said — show you were listening
- At least one question should probe something they seemed to gloss over or avoid
- No em dashes. No therapeutic warmth performed for its own sake.
- If patterns from their history suggest something worth probing, ask about it
- Questions should feel like a sharp friend asking, not a chatbot

Today's entry:
{transcript}

Relevant history context:
{context}

Return ONLY a JSON array of exactly 3 strings. Example:
["Question one?", "Question two?", "Question three?"]"""


FLAG_ANALYSIS_PROMPT = """You are analyzing someone's personal journal history to identify behavioral patterns worth flagging.

You have access to the last {days} days of journal entries and metrics. Your job is to surface honest observations — not comfortable ones.

Rules:
- Only flag things with clear evidence across multiple entries
- Each flag must cite specific entry dates as evidence
- Be direct. Don't soften observations.
- Categories: sleep, stress, social, productivity, mood, anxiety, avoidance, substance, physical, relationship
- Severity: low (worth watching), medium (recurring pattern), high (consistent problem)
- Don't flag one-off events — look for patterns
- Don't prescribe. Observe and cite.

Entries summary:
{entries_summary}

Metrics trends:
{metrics_summary}

Return a JSON array of flag objects:
[
  {{
    "severity": "medium",
    "category": "sleep",
    "title": "Short flag title",
    "description": "2-3 sentence honest description of what you observed.",
    "evidence": ["2026-04-01", "2026-04-03", "2026-04-07"]
  }}
]

Return only the JSON array. No explanation."""

# ─── METRIC EXTRACTION ────────────────────────────────────────────────────────

@router.post("/extract-metrics/{entry_id}")
async def extract_metrics(entry_id: int):
    """
    Run AI metric extraction on a journal entry.
    Called automatically after transcription is complete.
    entry_id comes from the path — no request body needed.
    """
    conn = get_conn()
    try:
        entry = conn.execute(
            "SELECT * FROM entries WHERE id = ?", (entry_id,)
        ).fetchone()

        if not entry:
            raise HTTPException(status_code=404, detail="Entry not found")

        if not entry["transcript"]:
            raise HTTPException(status_code=400, detail="Entry has no transcript")

        prompt   = METRIC_EXTRACTION_PROMPT.format(transcript=entry["transcript"])
        response = await generate(prompt, temperature=0.1, max_tokens=200)

        try:
            clean   = clean_llm_json(response)
            metrics = json.loads(clean)
        except json.JSONDecodeError:
            log.error(f"Failed to parse metrics JSON. Raw response: {response[:300]}")
            raise HTTPException(status_code=500, detail="AI returned invalid metrics format")

        conn.execute("""
            INSERT OR REPLACE INTO metrics
            (entry_id, date, stress, mood, anxiety, energy, mental_clarity,
             productivity, social_sat, sentiment, raw_extraction)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            entry_id,
            entry["date"],
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

        return {"status": "ok", "metrics": metrics}

    finally:
        conn.close()


# ─── FOLLOW-UP QUESTIONS ──────────────────────────────────────────────────────

@router.post("/questions/{entry_id}")
async def generate_questions(entry_id: int):
    """
    Generate 3 AI follow-up questions after a journal entry.
    Uses context from past entries for relevance.
    """
    conn = get_conn()
    try:
        entry = conn.execute(
            "SELECT * FROM entries WHERE id = ?", (entry_id,)
        ).fetchone()

        if not entry:
            raise HTTPException(status_code=404, detail="Entry not found")

        past = conn.execute("""
            SELECT date, transcript FROM entries
            WHERE id != ? AND type = 'daily'
            ORDER BY created_at DESC LIMIT 7
        """, (entry_id,)).fetchall()

        context = "\n---\n".join(
            f"{r['date']}: {r['transcript'][:300]}" for r in past
        ) if past else "No previous entries yet."

        prompt   = FOLLOW_UP_PROMPT.format(
            transcript=entry["transcript"],
            context=context
        )
        response = await generate(prompt, temperature=0.8, max_tokens=400)

        try:
            clean     = clean_llm_json(response)
            questions = json.loads(clean)
            if not isinstance(questions, list):
                raise ValueError("Not a list")
            questions = questions[:3]
        except Exception:
            log.error(f"Failed to parse questions. Raw: {response[:300]}")
            questions = [
                "What felt unresolved about today?",
                "What are you avoiding thinking about?",
                "What would a better version of today have looked like?"
            ]

        return {"questions": questions}

    finally:
        conn.close()


# ─── FLAG ANALYSIS ────────────────────────────────────────────────────────────

@router.post("/run-flags")
async def run_flag_analysis(days: int = 30):
    """
    Run a full behavioral flag analysis across recent journal history.
    Takes 30-60 seconds. Called on demand from the DEBRIEF screen.
    """
    conn = get_conn()
    try:
        entries = conn.execute("""
            SELECT e.date, e.transcript, m.stress, m.mood, m.anxiety,
                   m.energy, m.productivity, m.social_sat, m.sentiment
            FROM   entries e
            LEFT JOIN metrics m ON m.entry_id = e.id
            WHERE  e.type = 'daily'
            AND    e.date >= date('now', ?)
            ORDER  BY e.date ASC
        """, (f"-{days} days",)).fetchall()

        if len(entries) < 5:
            return {
                "status": "insufficient_data",
                "message": f"Need at least 5 entries to analyze patterns. Have {len(entries)}."
            }

        entries_summary = "\n".join(
            f"{r['date']}: {r['transcript'][:200]}" for r in entries
        )

        metrics_rows = []
        for r in entries:
            row = (f"{r['date']}: stress={r['stress']}, mood={r['mood']}, "
                   f"anxiety={r['anxiety']}, energy={r['energy']}, "
                   f"productivity={r['productivity']}, social={r['social_sat']}")
            metrics_rows.append(row)
        metrics_summary = "\n".join(metrics_rows)

        prompt   = FLAG_ANALYSIS_PROMPT.format(
            days=days,
            entries_summary=entries_summary,
            metrics_summary=metrics_summary
        )
        response = await generate(prompt, temperature=0.3, max_tokens=2000)

        try:
            clean = clean_llm_json(response)
            flags = json.loads(clean)
        except Exception:
            log.error(f"Flag parsing failed. Raw: {response[:300]}")
            return {"status": "error", "message": "AI returned invalid flag format"}

        saved = 0
        for flag in flags:
            conn.execute("""
                INSERT INTO flags (severity, category, title, description, evidence)
                VALUES (?, ?, ?, ?, ?)
            """, (
                flag.get("severity", "low"),
                flag.get("category", "general"),
                flag.get("title", ""),
                flag.get("description", ""),
                json.dumps(flag.get("evidence", []))
            ))
            saved += 1
        conn.commit()

        return {"status": "ok", "flags_generated": saved, "flags": flags}

    finally:
        conn.close()


# ─── GET FLAGS ────────────────────────────────────────────────────────────────

@router.get("/flags")
def get_flags(
    severity:  Optional[str] = None,
    resolved:  bool = False,
    dismissed: bool = False,
):
    """
    Get behavioral flags.
    dismissed=False (default): active flags only.
    dismissed=True: return the dismissed archive for the SHOW DISMISSED toggle.
    """
    conn = get_conn()
    try:
        params = []

        if dismissed:
            # Caller wants the dismissed archive
            conditions = ["dismissed = 1"]
        else:
            # Default: active flags only
            conditions = ["dismissed = 0"]
            if not resolved:
                conditions.append("resolved = 0")

        if severity:
            conditions.append("severity = ?")
            params.append(severity)

        where_clause = " AND ".join(conditions)
        rows = conn.execute(
            f"SELECT * FROM flags WHERE {where_clause} ORDER BY created_at DESC",
            params
        ).fetchall()

        return [dict(r) for r in rows]
    finally:
        conn.close()


# ─── DISMISS / RESOLVE FLAGS ──────────────────────────────────────────────────

@router.post("/flags/{flag_id}/dismiss")
def dismiss_flag(flag_id: int):
    """Mark a flag as dismissed — hidden from UI, kept in database."""
    conn = get_conn()
    try:
        result = conn.execute(
            "UPDATE flags SET dismissed = 1 WHERE id = ?", (flag_id,)
        )
        conn.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Flag not found")
        return {"status": "dismissed", "id": flag_id}
    finally:
        conn.close()


@router.post("/flags/{flag_id}/resolve")
def resolve_flag(flag_id: int):
    """Mark a flag as resolved — moves to history, off the active list."""
    conn = get_conn()
    try:
        result = conn.execute(
            "UPDATE flags SET resolved = 1 WHERE id = ?", (flag_id,)
        )
        conn.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Flag not found")
        return {"status": "resolved", "id": flag_id}
    finally:
        conn.close()


# ─── TREND DATA ───────────────────────────────────────────────────────────────

@router.get("/trends")
def get_trends(days: int = 30):
    """
    Return metric trends for graphing on the DEBRIEF and VITALS screens.
    Joins with health_data so HRV/sleep overlay is available when imported.
    """
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT m.date, m.stress, m.mood, m.anxiety, m.energy,
                   m.mental_clarity, m.productivity, m.social_sat, m.sentiment,
                   h.hrv, h.resting_hr, h.sleep_total_mins
            FROM   metrics m
            LEFT JOIN health_data h ON h.date = m.date
            WHERE  m.date >= date('now', ?)
            ORDER  BY m.date ASC
        """, (f"-{days} days",)).fetchall()

        return [dict(r) for r in rows]
    finally:
        conn.close()
