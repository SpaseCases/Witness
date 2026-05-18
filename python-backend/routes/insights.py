# Bug fix: generate_questions temperature 0.8->0.7 per task table; run_flag_analysis
#          temperature 0.3->0.2 per task table; fmt="json" added to all generate()
#          calls; run_flag_analysis num_ctx raised to 16384 (aggregates 30 days of
#          entries); clean_llm_json removed — now imported from ollama_manager (single
#          source of truth); redundant local `import re as _re` removed.
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

from database import get_conn
from ollama_manager import generate, clean_llm_json

log = logging.getLogger("witness.insights")
router = APIRouter()

# ─── PROMPTS ──────────────────────────────────────────────────────────────────

# IMPORTANT: any literal { or } that appear in the prompt text (not format placeholders)
# must be doubled — {{ and }} — so Python's .format() treats them as literal characters.
# Failure to do this causes a KeyError -> 500 when the prompt is rendered.

METRIC_EXTRACTION_PROMPT = """You are extracting psychological metrics from a personal journal entry. Be accurate and evidence-based. Only score what the person actually describes — do not infer what they did not mention.

Use these anchored scales. Scores must reflect the text evidence, not your assumptions.

STRESS (1-10): How burdened or pressured does the person feel?
  1-2 = calm, relaxed, no pressure mentioned
  3-4 = mild pressure, manageable demands
  5-6 = noticeable stress, struggling at times but coping
  7-8 = high stress, frequently overwhelmed, difficulty managing
  9-10 = extreme stress, crisis-level, unable to cope

MOOD (1-10): Overall emotional quality of their day
  1-2 = very low, depressed, empty, or severely distressed
  3-4 = below average, sad, irritable, or discouraged
  5-6 = neutral to slightly positive, mixed day, getting by
  7-8 = good mood, upbeat, satisfied, things going well
  9-10 = excellent, very happy, energized emotionally

ANXIETY (1-10): Worry, fear, nervousness, or dread expressed
  1-2 = no anxiety mentioned, calm
  3-4 = mild worry, some nervousness about specific things
  5-6 = moderate anxiety, intrusive thoughts, difficulty relaxing
  7-8 = high anxiety, persistent worry, physical symptoms mentioned
  9-10 = severe anxiety, panic-level, overwhelming fear
  Return null if anxiety is not mentioned at all.

ENERGY (1-10): Physical and mental energy levels
  1-2 = exhausted, fatigued, can barely function
  3-4 = low energy, sluggish, tired
  5-6 = average energy, functional
  7-8 = good energy, productive and active
  9-10 = very high energy, feel great physically

MENTAL_CLARITY (1-10): Focus, concentration, and cognitive sharpness
  1-2 = very foggy, can't concentrate, dissociated
  3-4 = scattered, distracted, hard to focus
  5-6 = average clarity, some focus issues
  7-8 = clear-headed, focused, thinking well
  9-10 = sharp, highly focused, in flow state
  Return null if not mentioned.

PRODUCTIVITY (1-10): How much was accomplished vs intended
  1-2 = nothing done, completely unproductive
  3-4 = very little done, mostly avoided tasks
  5-6 = some things done, partially productive
  7-8 = productive day, most tasks completed
  9-10 = highly productive, exceeded goals
  Return null if not mentioned.

SOCIAL_SAT (1-10): Satisfaction with social interactions
  1-2 = very isolated, negative social experiences
  3-4 = lonely or social friction
  5-6 = neutral, ordinary social contact
  7-8 = good social connections, felt supported
  9-10 = very connected, strong positive interactions
  Return null if social interactions are not mentioned.

SENTIMENT (-1.0 to 1.0): Overall emotional tone of the entry
  -1.0 = entirely negative
  -0.5 = mostly negative
   0.0 = neutral or mixed
  +0.5 = mostly positive
  +1.0 = entirely positive

IMPORTANT: If a metric cannot be determined from what was actually said, return null. Do not guess.
Return ONLY a valid JSON object. No explanation. No preamble. No markdown fences.

Example output:
{{"stress": 7, "mood": 4, "anxiety": 6, "energy": 3, "mental_clarity": null, "productivity": 5, "social_sat": null, "sentiment": -0.4}}

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

You have access to the last {days} days of journal entries and extracted metrics. Your job is to surface honest, evidence-based observations about recurring patterns. Do not flag single incidents.

SEVERITY THRESHOLDS — apply these strictly:
  low    = pattern appears in 2-3 entries. Worth watching but not alarming.
  medium = pattern appears in 4-6 entries OR metric average is consistently in concerning range (stress ≥6, mood ≤4, anxiety ≥6 across multiple entries)
  high   = pattern appears in 7+ entries OR extreme values persist (stress ≥8, mood ≤3, or crisis language used multiple times)

CATEGORY DEFINITIONS — use these precise definitions:
  sleep        = mentions of poor sleep, insomnia, oversleeping, fatigue from sleep issues, erratic schedule
  stress       = overwhelm, pressure, too much to do, can't keep up — backed by stress metric ≥6 across entries
  social       = isolation, loneliness, conflict with others, avoided people, no social contact mentioned
  productivity = consistent failure to accomplish stated goals, procrastination patterns, avoidance of specific tasks
  mood         = persistent low mood, depressive language (hopeless, empty, pointless), mood metric ≤4 across entries
  anxiety      = worry, dread, rumination, panic mentions, anxiety metric ≥6 across entries
  avoidance    = ONLY flag if the person explicitly describes avoiding something they said they wanted to do, or repeatedly not following through on the same commitment
  substance    = alcohol, drugs, or excessive caffeine mentioned as coping behavior (not casual mentions)
  physical     = illness, pain, skipping exercise, physical health concerns mentioned repeatedly
  relationship = recurring conflict, tension, or distance with a specific person or group
  screen_time  = excessive phone/screen use mentioned repeatedly, or screen_time_mins data shows ≥4hrs on multiple days

EVIDENCE RULES:
  - Each flag MUST cite at least 2 different entry dates as evidence
  - Do not flag something that only appeared in 1 entry, no matter how dramatic
  - The description must reference specific things the person said, not vague generalizations
  - If metrics show a trend but entries don't mention it, note the metric data but flag at low severity only

DO NOT FLAG:
  - One-time events or one-off bad days
  - Things the person described as resolved
  - Absence of positive things (not mentioning exercise is not a fitness flag)
  - Speculation about causes — only observe what is stated

Entries summary:
{entries_summary}

Metrics trends:
{metrics_summary}

Return a JSON array of flag objects. Return an empty array [] if no genuine patterns exist — it is better to return no flags than to flag noise.

[
  {{
    "severity": "medium",
    "category": "sleep",
    "title": "Short descriptive flag title (under 8 words)",
    "description": "2-3 sentences citing specific evidence. Quote or closely paraphrase what the person said. State the pattern directly.",
    "evidence": ["2026-04-01", "2026-04-03", "2026-04-07"]
  }}
]

Return only the JSON array. No explanation. No preamble."""

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
        response = await generate(prompt, temperature=0.1, max_tokens=300, fmt="json", num_ctx=8192)

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
        response = await generate(prompt, temperature=0.7, max_tokens=400, fmt="json")

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
                   m.energy, m.productivity, m.social_sat, m.sentiment,
                   h.screen_time_mins
            FROM   entries e
            LEFT JOIN metrics m ON m.entry_id = e.id
            LEFT JOIN health_data h ON h.date = e.date
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
            screen = f"{r['screen_time_mins']/60:.1f}h" if r["screen_time_mins"] is not None else "null"
            row = (f"{r['date']}: stress={r['stress']}, mood={r['mood']}, "
                   f"anxiety={r['anxiety']}, energy={r['energy']}, "
                   f"productivity={r['productivity']}, social={r['social_sat']}, "
                   f"screen_time={screen}")
            metrics_rows.append(row)
        metrics_summary = "\n".join(metrics_rows)

        prompt   = FLAG_ANALYSIS_PROMPT.format(
            days=days,
            entries_summary=entries_summary,
            metrics_summary=metrics_summary
        )
        response = await generate(prompt, temperature=0.2, max_tokens=2000, num_ctx=16384, fmt="json")

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
                   h.hrv, h.resting_hr, h.sleep_total_mins, h.screen_time_mins
            FROM   metrics m
            LEFT JOIN health_data h ON h.date = m.date
            WHERE  m.date >= date('now', ?)
            ORDER  BY m.date ASC
        """, (f"-{days} days",)).fetchall()

        return [dict(r) for r in rows]
    finally:
        conn.close()
