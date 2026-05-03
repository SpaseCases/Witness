"""
WITNESS -- Monthly Recap API

Endpoints:
  GET  /recap/monthly/current      -- get this month's recap (generates + caches if needed)
  POST /recap/monthly/regenerate   -- force-regenerate
  GET  /recap/monthly/history      -- past monthly recaps
  GET  /recap/monthly/export       -- current month as plain markdown

Focuses on change over time, not just event summary.
Requires at least 5 entries in the 30-day window.
"""

import json
import logging
from datetime import date, timedelta, datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from database import get_conn
from ollama_manager import generate
from routes.transcribe import clean_llm_json

log    = logging.getLogger("witness.monthly_recap")
router = APIRouter()

MIN_ENTRIES = 5   # minimum entries needed to generate a monthly recap


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def month_window() -> tuple[str, str]:
    """Return (start, end) as ISO strings for the rolling 30-day window."""
    end   = date.today()
    start = end - timedelta(days=29)
    return start.isoformat(), end.isoformat()


def safe_round(v, d=1):
    try:
        return round(float(v), d) if v is not None else None
    except Exception:
        return None


def avg_list(lst):
    vals = [v for v in lst if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def fmt_mins(mins) -> str:
    if not mins:
        return "none"
    h = int(mins // 60)
    m = int(mins % 60)
    return f"{h}h {m}m" if h else f"{m}m"


# ─── DATA AGGREGATOR ─────────────────────────────────────────────────────────

def gather_month_data(start: str, end: str, conn) -> dict:
    """
    Pull journal + health data for the 30-day window.
    Splits entries into two halves to show trend direction (first 15 vs last 15 days).
    """
    entries = conn.execute("""
        SELECT e.id, e.date, e.transcript, e.structured_summary,
               m.stress, m.mood, m.anxiety, m.energy,
               m.mental_clarity, m.productivity, m.social_sat, m.sentiment
        FROM   entries e
        LEFT JOIN metrics m ON m.entry_id = e.id
        WHERE  e.date >= ? AND e.date <= ? AND e.type = 'daily'
        ORDER  BY e.date ASC
    """, (start, end)).fetchall()

    entries = [dict(e) for e in entries]

    # Split into first half / second half to detect trend direction
    mid   = len(entries) // 2
    first = entries[:mid]  if mid > 0 else entries
    last  = entries[mid:]  if mid > 0 else entries

    def metric_avg(subset, key):
        return avg_list([e.get(key) for e in subset])

    def half_avgs(subset):
        return {k: metric_avg(subset, k)
                for k in ("stress","mood","anxiety","energy","mental_clarity","productivity","social_sat")}

    first_avgs = half_avgs(first)
    last_avgs  = half_avgs(last)

    # Overall averages
    overall_avgs = {k: metric_avg(entries, k)
                    for k in ("stress","mood","anxiety","energy","mental_clarity","productivity","social_sat")}

    # Health data
    health_rows = conn.execute("""
        SELECT date, hrv, resting_hr, sleep_total_mins,
               sleep_deep_mins, sleep_rem_mins, steps, active_calories,
               workout_mins, workout_type
        FROM   health_data
        WHERE  date >= ? AND date <= ?
        ORDER  BY date ASC
    """, (start, end)).fetchall()

    health_rows = [dict(h) for h in health_rows]

    health_avgs = {
        "hrv":              avg_list([h.get("hrv")              for h in health_rows]),
        "resting_hr":       avg_list([h.get("resting_hr")       for h in health_rows]),
        "sleep_total_mins": avg_list([h.get("sleep_total_mins") for h in health_rows]),
        "sleep_deep_mins":  avg_list([h.get("sleep_deep_mins")  for h in health_rows]),
        "steps":            avg_list([h.get("steps")            for h in health_rows]),
        "active_calories":  avg_list([h.get("active_calories")  for h in health_rows]),
    }

    workouts = [h for h in health_rows if h.get("workout_mins") and h["workout_mins"] > 0]
    workout_summary = {
        "session_count": len(workouts),
        "total_mins":    sum(h["workout_mins"] for h in workouts),
        "types":         list({h["workout_type"] for h in workouts if h.get("workout_type")}),
    }

    # Best and worst single entry by composite score
    scored = []
    for e in entries:
        parts   = [e.get("mood"), e.get("energy"), e.get("productivity")]
        penalty = e.get("stress") or 0
        vals    = [v for v in parts if v is not None]
        if vals:
            scored.append({
                "date":  e["date"],
                "score": (sum(vals) / len(vals)) - (penalty * 0.3),
                "entry": e,
            })

    best_day  = max(scored, key=lambda x: x["score"]) if scored else None
    worst_day = min(scored, key=lambda x: x["score"]) if scored else None

    return {
        "start":           start,
        "end":             end,
        "entry_count":     len(entries),
        "entries":         entries,
        "overall_avgs":    overall_avgs,
        "first_half_avgs": first_avgs,
        "last_half_avgs":  last_avgs,
        "health_avgs":     health_avgs,
        "workout_summary": workout_summary,
        "best_day":        best_day,
        "worst_day":       worst_day,
    }


# ─── PROMPT ──────────────────────────────────────────────────────────────────

MONTHLY_PROMPT = """You are writing a monthly recap for a private journaling app called Witness.

The user records daily voice entries. Each entry is analyzed for stress, mood, anxiety, energy, productivity scores. You have 30 days of data.

Your job: analyze CHANGE OVER TIME, not just what happened. Did things improve, deteriorate, or stay flat? What shifted? The user wants honesty, not encouragement.

Rules:
- Focus on arc and trajectory, not event summaries
- Compare first-half averages to second-half averages directly
- Name the most significant shift (positive or negative) explicitly
- If the data shows no meaningful change, say so plainly
- One honest behavioral observation the user may not want to hear
- No em dashes anywhere
- Goals must be specific to the data, not generic self-improvement advice
- Under 400 words for the summary
- Return ONLY valid JSON, no markdown fences, no extra text

Period: {start} to {end}
Entries logged: {entry_count}

FIRST HALF AVERAGES (days 1-15):
{first_half}

SECOND HALF AVERAGES (days 16-30):
{second_half}

OVERALL AVERAGES:
{overall}

HEALTH AVERAGES:
{health}

WORKOUT SUMMARY: {workout}

BEST DAY: {best_day}
WORST DAY: {worst_day}

ENTRY EXCERPTS (structured summaries where available, otherwise raw excerpt):
{excerpts}

Return exactly this JSON:
{{
  "summary": "3-5 paragraphs. What changed. What stayed the same. What the arc looks like.",
  "trend_direction": "improving" | "declining" | "flat" | "mixed",
  "biggest_shift": "One sentence naming the most significant change over the month.",
  "recurring_themes": ["Theme 1", "Theme 2", "Theme 3"],
  "honest_observation": "One uncomfortable thing the data reveals.",
  "watch_next_month": "One specific thing worth watching in the coming month based on the pattern.",
  "goals_next": ["Specific goal 1", "Specific goal 2", "Specific goal 3"]
}}"""


def build_prompt(data: dict) -> str:
    def fmt_avgs(avgs: dict) -> str:
        labels = {
            "stress": "stress", "mood": "mood", "anxiety": "anxiety",
            "energy": "energy", "mental_clarity": "mental clarity",
            "productivity": "productivity", "social_sat": "social sat",
        }
        return "\n".join(
            f"  {labels[k]}: {avgs[k] if avgs[k] is not None else 'no data'}"
            for k in labels
        )

    ha = data["health_avgs"]
    health_str = "\n".join([
        f"  HRV:        {ha['hrv'] or 'no data'} ms",
        f"  Resting HR: {ha['resting_hr'] or 'no data'} bpm",
        f"  Avg sleep:  {fmt_mins(ha['sleep_total_mins'])}",
        f"  Steps:      {int(ha['steps']) if ha['steps'] else 'no data'}",
    ])

    ws = data["workout_summary"]
    workout_str = (
        f"{ws['session_count']} sessions, {fmt_mins(ws['total_mins'])} total"
        + (f", types: {', '.join(ws['types'])}" if ws["types"] else "")
        if ws["session_count"] > 0 else "no workouts logged"
    )

    best  = data["best_day"]
    worst = data["worst_day"]
    best_str  = f"{best['date']} (score: {best['score']:.1f})"  if best  else "insufficient data"
    worst_str = f"{worst['date']} (score: {worst['score']:.1f})" if worst else "insufficient data"

    # Use structured summary if available, else first 200 chars of transcript
    excerpts = ""
    for e in data["entries"]:
        ss = e.get("structured_summary")
        if ss:
            try:
                parsed  = json.loads(ss)
                summary = parsed.get("summary", "")
                if summary:
                    excerpts += f"\n{e['date']} (stress={e.get('stress')}, mood={e.get('mood')}): {summary}\n"
                    continue
            except Exception:
                pass
        # Fallback to raw transcript excerpt
        t = (e.get("transcript") or "").strip()[:200]
        if t:
            excerpts += f"\n{e['date']} (stress={e.get('stress')}, mood={e.get('mood')}): \"{t}\"\n"

    return MONTHLY_PROMPT.format(
        start        = data["start"],
        end          = data["end"],
        entry_count  = data["entry_count"],
        first_half   = fmt_avgs(data["first_half_avgs"]),
        second_half  = fmt_avgs(data["last_half_avgs"]),
        overall      = fmt_avgs(data["overall_avgs"]),
        health       = health_str,
        workout      = workout_str,
        best_day     = best_str,
        worst_day    = worst_str,
        excerpts     = excerpts[:4000],
    )


# ─── GENERATE + CACHE ────────────────────────────────────────────────────────

async def generate_and_cache(start: str, end: str, data: dict, conn) -> dict:
    prompt   = build_prompt(data)
    response = await generate(prompt, temperature=0.55, max_tokens=1400)

    try:
        clean  = clean_llm_json(response)
        parsed = json.loads(clean)
    except Exception:
        log.error(f"Monthly recap JSON parse failed. Raw: {response[:400]}")
        raise HTTPException(status_code=500, detail="AI returned an invalid format. Try regenerating.")

    conn.execute("""
        INSERT OR REPLACE INTO monthly_recaps
            (period_start, period_end, created_at,
             summary, trend_direction, biggest_shift,
             recurring_themes, honest_observation,
             watch_next_month, goals_next)
        VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
    """, (
        start, end,
        parsed.get("summary", ""),
        parsed.get("trend_direction", ""),
        parsed.get("biggest_shift", ""),
        json.dumps(parsed.get("recurring_themes", [])),
        parsed.get("honest_observation", ""),
        parsed.get("watch_next_month", ""),
        json.dumps(parsed.get("goals_next", [])),
    ))
    conn.commit()

    return _row_to_dict(start, end, data, parsed)


def _row_to_dict(start, end, data, parsed) -> dict:
    return {
        "start":              start,
        "end":                end,
        "entry_count":        data["entry_count"],
        "overall_avgs":       data["overall_avgs"],
        "first_half_avgs":    data["first_half_avgs"],
        "last_half_avgs":     data["last_half_avgs"],
        "health_avgs":        data["health_avgs"],
        "workout_summary":    data["workout_summary"],
        "best_day":           data["best_day"],
        "worst_day":          data["worst_day"],
        "summary":            parsed.get("summary", ""),
        "trend_direction":    parsed.get("trend_direction", ""),
        "biggest_shift":      parsed.get("biggest_shift", ""),
        "recurring_themes":   parsed.get("recurring_themes", []),
        "honest_observation": parsed.get("honest_observation", ""),
        "watch_next_month":   parsed.get("watch_next_month", ""),
        "goals_next":         parsed.get("goals_next", []),
    }


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@router.get("/current")
async def get_monthly_recap():
    """
    Get this month's recap (rolling 30 days).
    Serves from cache if already generated within the last 24 hours.
    Returns status: 'insufficient_data' if fewer than 5 entries exist.
    """
    start, end = month_window()
    conn = get_conn()
    try:
        data = gather_month_data(start, end, conn)

        if data["entry_count"] < MIN_ENTRIES:
            return {
                "status":       "insufficient_data",
                "entry_count":  data["entry_count"],
                "min_entries":  MIN_ENTRIES,
                "start":        start,
                "end":          end,
                "overall_avgs": data["overall_avgs"],
                "message":      f"Need at least {MIN_ENTRIES} entries for a monthly recap. You have {data['entry_count']}.",
            }

        # Check for a cached recap generated today
        cached = conn.execute(
            "SELECT * FROM monthly_recaps WHERE period_start = ? AND period_end = ?",
            (start, end)
        ).fetchone()

        if cached:
            # Check if generated today
            generated_today = str(cached["created_at"])[:10] == date.today().isoformat()
            if generated_today:
                parsed = {
                    "summary":            cached["summary"] or "",
                    "trend_direction":    cached["trend_direction"] or "",
                    "biggest_shift":      cached["biggest_shift"] or "",
                    "recurring_themes":   json.loads(cached["recurring_themes"] or "[]"),
                    "honest_observation": cached["honest_observation"] or "",
                    "watch_next_month":   cached["watch_next_month"] or "",
                    "goals_next":         json.loads(cached["goals_next"] or "[]"),
                }
                return {"status": "cached", **_row_to_dict(start, end, data, parsed)}

        result = await generate_and_cache(start, end, data, conn)
        return {"status": "generated", **result}

    finally:
        conn.close()


@router.post("/regenerate")
async def regenerate_monthly():
    """Force-regenerate even if cached."""
    start, end = month_window()
    conn = get_conn()
    try:
        data = gather_month_data(start, end, conn)

        if data["entry_count"] < MIN_ENTRIES:
            raise HTTPException(
                status_code=400,
                detail=f"Need at least {MIN_ENTRIES} entries. You have {data['entry_count']}."
            )

        result = await generate_and_cache(start, end, data, conn)
        return {"status": "generated", **result}

    finally:
        conn.close()


@router.get("/history")
def get_monthly_history(limit: int = 12):
    """Past monthly recaps, most recent first."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM monthly_recaps ORDER BY period_start DESC LIMIT ?",
            (limit,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            for key in ("recurring_themes", "goals_next"):
                try:
                    d[key] = json.loads(d.get(key) or "[]")
                except Exception:
                    d[key] = []
            result.append(d)
        return result
    finally:
        conn.close()


@router.get("/export", response_class=PlainTextResponse)
def export_monthly():
    """Export the most recent monthly recap as Markdown."""
    start, end = month_window()
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM monthly_recaps WHERE period_start = ? AND period_end = ?",
            (start, end)
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="No monthly recap generated yet. Generate one first.")

        goals = []
        try:
            goals = json.loads(row["goals_next"] or "[]")
        except Exception:
            pass

        themes = []
        try:
            themes = json.loads(row["recurring_themes"] or "[]")
        except Exception:
            pass

        lines = [
            "# WITNESS -- MONTHLY SITREP",
            f"## {start} to {end}",
            f"_Generated {row['created_at']}_",
            "",
            "---",
            "",
            "## SUMMARY",
            "",
            row["summary"] or "",
            "",
        ]

        if row.get("biggest_shift"):
            lines += ["---", "", "## BIGGEST SHIFT", "", row["biggest_shift"], ""]

        if themes:
            lines += ["---", "", "## RECURRING THEMES", ""]
            for t in themes:
                lines.append(f"- {t}")
            lines.append("")

        if row.get("honest_observation"):
            lines += ["---", "", "## HONEST OBSERVATION", "", row["honest_observation"], ""]

        if row.get("watch_next_month"):
            lines += ["---", "", "## WATCH NEXT MONTH", "", row["watch_next_month"], ""]

        if goals:
            lines += ["---", "", "## NEXT MONTH -- FOCUS AREAS", ""]
            for i, g in enumerate(goals, 1):
                lines.append(f"{i}. {g}")

        lines += ["", "---", "", f"_Exported from Witness on {date.today().isoformat()}_"]

        return "\n".join(lines)

    finally:
        conn.close()
