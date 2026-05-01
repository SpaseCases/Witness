"""
WITNESS — Weekly Recap API  (Step 14)
Mon–Sun calendar week. Generated on demand, cached until next Monday.

Endpoints:
  GET  /recap/current        — get this week's recap (generates + caches if needed)
  POST /recap/regenerate     — force-regenerate even if cached
  GET  /recap/history        — past recaps
  GET  /recap/export         — current recap as plain text / markdown
  GET  /recap/week-data      — raw aggregated data for the current week (used by UI)
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

log    = logging.getLogger("witness.recap")
router = APIRouter()

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def this_monday() -> date:
    """Return the Monday of the current calendar week."""
    today = date.today()
    return today - timedelta(days=today.weekday())


def this_sunday(monday: date) -> date:
    return monday + timedelta(days=6)


def safe_round(v, d=1):
    try:
        return round(float(v), d) if v is not None else None
    except Exception:
        return None


def fmt_mins(mins) -> str:
    if not mins:
        return "none"
    h = int(mins // 60)
    m = int(mins % 60)
    return f"{h}h {m}m" if h else f"{m}m"


def avg_list(lst):
    vals = [v for v in lst if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


# ─── DATA AGGREGATOR ─────────────────────────────────────────────────────────

def gather_week_data(week_start: str, week_end: str, conn) -> dict:
    """
    Pull and aggregate all journal + health data for the week.
    Returns a rich dict that feeds both the AI prompt and the UI.
    """
    # Journal entries
    entries = conn.execute("""
        SELECT e.id, e.date, e.transcript, e.starred,
               m.stress, m.mood, m.anxiety, m.energy,
               m.mental_clarity, m.productivity, m.social_sat, m.sentiment
        FROM   entries e
        LEFT JOIN metrics m ON m.entry_id = e.id
        WHERE  e.date >= ? AND e.date <= ? AND e.type = 'daily'
        ORDER  BY e.date ASC
    """, (week_start, week_end)).fetchall()

    entries = [dict(e) for e in entries]

    # Health data
    health_rows = conn.execute("""
        SELECT date, hrv, resting_hr, sleep_total_mins,
               sleep_deep_mins, sleep_rem_mins, sleep_light_mins,
               workout_mins, workout_type, steps, active_calories
        FROM   health_data
        WHERE  date >= ? AND date <= ?
        ORDER  BY date ASC
    """, (week_start, week_end)).fetchall()

    health_rows = [dict(h) for h in health_rows]

    # Last week's recap goals (for goal review)
    last_monday     = (datetime.strptime(week_start, "%Y-%m-%d").date() - timedelta(weeks=1)).isoformat()
    last_week_recap = conn.execute(
        "SELECT goals_next FROM weekly_recaps WHERE week_start = ?", (last_monday,)
    ).fetchone()
    prior_goals = []
    if last_week_recap and last_week_recap["goals_next"]:
        try:
            prior_goals = json.loads(last_week_recap["goals_next"])
        except Exception:
            pass

    # ── Metric averages ───────────────────────────────────────────────────────
    def metric_avg(key):
        return avg_list([e.get(key) for e in entries])

    metric_avgs = {
        "stress":        metric_avg("stress"),
        "mood":          metric_avg("mood"),
        "anxiety":       metric_avg("anxiety"),
        "energy":        metric_avg("energy"),
        "mental_clarity": metric_avg("mental_clarity"),
        "productivity":  metric_avg("productivity"),
        "social_sat":    metric_avg("social_sat"),
    }

    # ── Health averages ───────────────────────────────────────────────────────
    health_avgs = {
        "hrv":              avg_list([h.get("hrv")          for h in health_rows]),
        "resting_hr":       avg_list([h.get("resting_hr")   for h in health_rows]),
        "sleep_total_mins": avg_list([h.get("sleep_total_mins") for h in health_rows]),
        "sleep_deep_mins":  avg_list([h.get("sleep_deep_mins")  for h in health_rows]),
        "sleep_rem_mins":   avg_list([h.get("sleep_rem_mins")   for h in health_rows]),
        "steps":            avg_list([h.get("steps")        for h in health_rows]),
        "active_calories":  avg_list([h.get("active_calories") for h in health_rows]),
    }

    # Workout summary
    workouts = [h for h in health_rows if h.get("workout_mins") and h["workout_mins"] > 0]
    workout_summary = {
        "session_count": len(workouts),
        "total_mins":    sum(h["workout_mins"] for h in workouts),
        "types":         list({h["workout_type"] for h in workouts if h.get("workout_type")}),
    }

    # ── Best and worst day ────────────────────────────────────────────────────
    scored_days = []
    for e in entries:
        score_parts = [e.get("mood"), e.get("energy"), e.get("productivity")]
        penalty     = e.get("stress") or 0
        vals        = [v for v in score_parts if v is not None]
        if vals:
            composite = (sum(vals) / len(vals)) - (penalty * 0.3)
            scored_days.append({"date": e["date"], "score": composite, "entry": e})

    best_day  = max(scored_days, key=lambda x: x["score"]) if scored_days else None
    worst_day = min(scored_days, key=lambda x: x["score"]) if scored_days else None

    # ── Entry count ───────────────────────────────────────────────────────────
    entry_count = len(entries)

    return {
        "week_start":      week_start,
        "week_end":        week_end,
        "entry_count":     entry_count,
        "entries":         entries,
        "health_rows":     health_rows,
        "metric_avgs":     metric_avgs,
        "health_avgs":     health_avgs,
        "workout_summary": workout_summary,
        "best_day":        best_day,
        "worst_day":       worst_day,
        "prior_goals":     prior_goals,
    }


# ─── AI PROMPT ───────────────────────────────────────────────────────────────

RECAP_PROMPT = """You are writing a weekly recap for a private journaling app called Witness.

The user journals daily with voice entries. The AI extracts stress, mood, anxiety, energy, productivity scores from each entry. You have been given the full data for this Mon–Sun week.

Your job: write a brutally honest, specific recap. Not a wellness coach. A sharp friend who actually read everything.

Rules:
- No em dashes anywhere
- No opener like "Great week!" or "This week was..."
- Reference specific scores and patterns directly
- If something is bad, say it plainly
- Goals must be specific to what the data shows, not generic
- The goal review: if there were no prior goals, write "No prior goals on record."
- Patterns: things you notice across the week, not just restatements of averages
- Under 350 words total for the summary
- Return ONLY valid JSON, no markdown fences

Week: {week_start} to {week_end}
Entries logged: {entry_count}

METRIC AVERAGES (1-10 scale):
{metric_avgs}

HEALTH AVERAGES:
{health_avgs}

WORKOUT SUMMARY:
{workout_summary}

BEST DAY: {best_day}
WORST DAY: {worst_day}

PRIOR GOALS (from last week):
{prior_goals}

ENTRY EXCERPTS:
{entry_excerpts}

Return exactly this JSON:
{{
  "summary": "2-4 paragraphs. Honest. Direct. Specific.",
  "patterns": ["Pattern 1", "Pattern 2", "Pattern 3"],
  "goals_review": "One paragraph reviewing prior goals. Honest about what happened.",
  "goals_next": ["Specific goal 1", "Specific goal 2", "Specific goal 3"],
  "best_day_note": "One sentence about why {best_day_date} was the best day.",
  "worst_day_note": "One sentence about why {worst_day_date} was the worst day."
}}"""


def build_prompt(data: dict) -> str:
    # Metric avgs as readable string
    ma = data["metric_avgs"]
    metric_str = "\n".join([
        f"  stress:        {ma['stress'] or 'no data'}",
        f"  mood:          {ma['mood'] or 'no data'}",
        f"  anxiety:       {ma['anxiety'] or 'no data'}",
        f"  energy:        {ma['energy'] or 'no data'}",
        f"  mental clarity:{ma['mental_clarity'] or 'no data'}",
        f"  productivity:  {ma['productivity'] or 'no data'}",
        f"  social sat:    {ma['social_sat'] or 'no data'}",
    ])

    ha = data["health_avgs"]
    health_str = "\n".join([
        f"  HRV:           {ha['hrv'] or 'no data'} ms",
        f"  Resting HR:    {ha['resting_hr'] or 'no data'} bpm",
        f"  Avg sleep:     {fmt_mins(ha['sleep_total_mins'])}",
        f"  Deep sleep:    {fmt_mins(ha['sleep_deep_mins'])}",
        f"  Steps:         {int(ha['steps']) if ha['steps'] else 'no data'}",
        f"  Active cal:    {int(ha['active_calories']) if ha['active_calories'] else 'no data'}",
    ])

    ws = data["workout_summary"]
    workout_str = (
        f"{ws['session_count']} sessions, {fmt_mins(ws['total_mins'])} total"
        + (f", types: {', '.join(ws['types'])}" if ws["types"] else "")
        if ws["session_count"] > 0 else "no workouts logged"
    )

    best  = data["best_day"]
    worst = data["worst_day"]
    best_str  = f"{best['date']} (composite score: {best['score']:.1f})"  if best  else "insufficient data"
    worst_str = f"{worst['date']} (composite score: {worst['score']:.1f})" if worst else "insufficient data"
    best_date  = best["date"]  if best  else "N/A"
    worst_date = worst["date"] if worst else "N/A"

    prior = data["prior_goals"]
    prior_str = "\n".join(f"  - {g}" for g in prior) if prior else "  None on record."

    # Entry excerpts — first 250 chars of each transcript
    excerpts = ""
    for e in data["entries"]:
        t = (e.get("transcript") or "").strip()[:250]
        excerpts += f"\n{e['date']} (stress={e.get('stress')}, mood={e.get('mood')}, energy={e.get('energy')}):\n  \"{t}\"\n"

    return RECAP_PROMPT.format(
        week_start=data["week_start"],
        week_end=data["week_end"],
        entry_count=data["entry_count"],
        metric_avgs=metric_str,
        health_avgs=health_str,
        workout_summary=workout_str,
        best_day=best_str,
        worst_day=worst_str,
        best_day_date=best_date,
        worst_day_date=worst_date,
        prior_goals=prior_str,
        entry_excerpts=excerpts,
    )


# ─── GENERATE + CACHE ────────────────────────────────────────────────────────

async def generate_and_cache(week_start: str, data: dict, conn) -> dict:
    """Call the AI, parse the JSON, save to weekly_recaps, return the result."""
    prompt   = build_prompt(data)
    response = await generate(prompt, temperature=0.55, max_tokens=1200)

    try:
        clean = clean_llm_json(response)
        recap = json.loads(clean)
    except Exception:
        log.error(f"Recap JSON parse failed. Raw response: {response[:400]}")
        raise HTTPException(status_code=500, detail="AI returned an invalid format. Try regenerating.")

    prior_goals_json = json.dumps(data["prior_goals"])

    conn.execute("""
        INSERT OR REPLACE INTO weekly_recaps
            (week_start, created_at, summary, goals_prev, goals_next,
             patterns, goals_review, best_day_note, worst_day_note)
        VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?)
    """, (
        week_start,
        recap.get("summary", ""),
        prior_goals_json,
        json.dumps(recap.get("goals_next", [])),
        json.dumps(recap.get("patterns", [])),
        recap.get("goals_review", ""),
        recap.get("best_day_note", ""),
        recap.get("worst_day_note", ""),
    ))
    conn.commit()

    return {
        "week_start":     week_start,
        "week_end":       data["week_end"],
        "entry_count":    data["entry_count"],
        "metric_avgs":    data["metric_avgs"],
        "health_avgs":    data["health_avgs"],
        "workout_summary":data["workout_summary"],
        "best_day":       data["best_day"],
        "worst_day":      data["worst_day"],
        "prior_goals":    data["prior_goals"],
        **recap,
    }


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@router.get("/week-data")
def get_week_data():
    """
    Return raw aggregated data for the current Mon-Sun week.
    Used by the UI to show metrics before/without generating the AI recap.
    """
    monday   = this_monday()
    sunday   = this_sunday(monday)
    conn     = get_conn()
    try:
        data = gather_week_data(monday.isoformat(), sunday.isoformat(), conn)
        # Strip raw entry transcripts from the response (keep it lean)
        data.pop("entries", None)
        data.pop("health_rows", None)
        return data
    finally:
        conn.close()


@router.get("/current")
async def get_current_recap():
    """
    Get this week's recap. Serves from cache if already generated this week.
    Returns { status: 'insufficient_data' } if fewer than 3 entries exist.
    Returns { status: 'cached', ... } or { status: 'generated', ... }.
    """
    monday     = this_monday()
    sunday     = this_sunday(monday)
    week_start = monday.isoformat()
    week_end   = sunday.isoformat()

    conn = get_conn()
    try:
        # Check cache
        cached = conn.execute(
            "SELECT * FROM weekly_recaps WHERE week_start = ?", (week_start,)
        ).fetchone()

        data = gather_week_data(week_start, week_end, conn)

        if data["entry_count"] < 3:
            return {
                "status":          "insufficient_data",
                "entry_count":     data["entry_count"],
                "week_start":      week_start,
                "week_end":        week_end,
                "metric_avgs":     data["metric_avgs"],
                "health_avgs":     data["health_avgs"],
                "workout_summary": data["workout_summary"],
                "message":         f"Need at least 3 entries for a recap. You have {data['entry_count']}.",
            }

        if cached:
            goals_next = []
            try:
                goals_next = json.loads(cached["goals_next"] or "[]")
            except Exception:
                pass

            prior_goals = []
            try:
                prior_goals = json.loads(cached["goals_prev"] or "[]")
            except Exception:
                pass

            patterns = []
            try:
                patterns = json.loads(cached["patterns"] or "[]")
            except Exception:
                pass

            return {
                "status":         "cached",
                "week_start":     week_start,
                "week_end":       week_end,
                "entry_count":    data["entry_count"],
                "metric_avgs":    data["metric_avgs"],
                "health_avgs":    data["health_avgs"],
                "workout_summary":data["workout_summary"],
                "best_day":       data["best_day"],
                "worst_day":      data["worst_day"],
                "prior_goals":    prior_goals,
                "summary":        cached["summary"],
                "goals_next":     goals_next,
                "patterns":       patterns,
                "goals_review":   cached["goals_review"]   or "",
                "best_day_note":  cached["best_day_note"]  or "",
                "worst_day_note": cached["worst_day_note"] or "",
            }

        # Not cached — generate now
        result = await generate_and_cache(week_start, data, conn)
        return {"status": "generated", **result}

    finally:
        conn.close()


@router.post("/regenerate")
async def regenerate_recap():
    """
    Force-regenerate the recap even if a cached version exists.
    Useful if you've added more entries and want a fresh take.
    """
    monday     = this_monday()
    sunday     = this_sunday(monday)
    week_start = monday.isoformat()
    week_end   = sunday.isoformat()

    conn = get_conn()
    try:
        data = gather_week_data(week_start, week_end, conn)

        if data["entry_count"] < 3:
            raise HTTPException(
                status_code=400,
                detail=f"Need at least 3 entries to generate a recap. You have {data['entry_count']}."
            )

        result = await generate_and_cache(week_start, data, conn)
        return {"status": "generated", **result}

    finally:
        conn.close()


@router.get("/history")
def get_recap_history(limit: int = 12):
    """Past weekly recaps, most recent first."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM weekly_recaps ORDER BY week_start DESC LIMIT ?",
            (limit,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["goals_next"] = json.loads(d.get("goals_next") or "[]")
            except Exception:
                d["goals_next"] = []
            result.append(d)
        return result
    finally:
        conn.close()


@router.get("/export", response_class=PlainTextResponse)
def export_recap():
    """
    Export the current week's cached recap as plain Markdown text.
    The Electron frontend can trigger a save-file dialog with this content.
    Returns 404 if not yet generated.
    """
    monday     = this_monday()
    week_start = monday.isoformat()
    week_end   = this_sunday(monday).isoformat()

    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM weekly_recaps WHERE week_start = ?", (week_start,)
        ).fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="No recap generated for this week yet.")

        goals_next = []
        try:
            goals_next = json.loads(row["goals_next"] or "[]")
        except Exception:
            pass

        lines = [
            f"# WITNESS — WEEKLY SITREP",
            f"## {week_start} to {week_end}",
            f"_Generated {row['created_at']}_",
            "",
            "---",
            "",
            "## SUMMARY",
            "",
            row["summary"] or "",
            "",
        ]

        # Patterns (stored in summary JSON — re-parse if available)
        # They may not be in the DB row since older schema only stored summary + goals.
        # We include them if the summary text contains them as separate paragraphs.

        # Best / worst day notes (may be empty on older cached recaps)
        if row.get("best_day_note"):
            lines += ["---", "", "## BEST DAY", "", row["best_day_note"], ""]
        if row.get("worst_day_note"):
            lines += ["---", "", "## WORST DAY", "", row["worst_day_note"], ""]

        # Goal review
        if row.get("goals_review"):
            lines += ["---", "", "## LAST WEEK — GOAL REVIEW", "", row["goals_review"], ""]

        # Prior goals
        prior_goals_list = []
        try:
            prior_goals_list = json.loads(row.get("goals_prev") or "[]")
        except Exception:
            pass
        if prior_goals_list:
            lines += ["### Prior goals:", ""]
            for i, g in enumerate(prior_goals_list, 1):
                lines.append(f"{i}. {g}")
            lines.append("")

        # Next week goals
        lines += ["---", "", "## NEXT WEEK — FOCUS AREAS", ""]
        for i, g in enumerate(goals_next, 1):
            lines.append(f"{i}. {g}")

        lines += ["", "---", "", f"_Exported from Witness on {date.today().isoformat()}_"]

        # Mark as exported
        conn.execute(
            "UPDATE weekly_recaps SET exported = 1 WHERE week_start = ?",
            (week_start,)
        )
        conn.commit()

        return "\n".join(lines)

    finally:
        conn.close()
