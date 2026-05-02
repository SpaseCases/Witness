"""
WITNESS — Health Data API  (Step 13 revised + Correlation feature)
Parses Apple Health XML exports with iterparse (memory-safe for 100MB+ files)
and stores metrics locally in SQLite.

New in this revision:
  DELETE /health/delete-range   — remove a date range
  DELETE /health/delete-all     — wipe all health data
  GET    /health/auto-status    — watch-folder + endpoint status for the UI
  POST   /health/auto-import    — network endpoint for iOS Shortcut / phone push
         On startup the backend also checks the health-inbox folder and
         auto-imports any export.xml found there, then moves it to processed/.

  GET    /health/correlation?days=N         — joined journal+health rows for chart
  GET    /health/correlation/summary?days=N — quick stats for empty-state check
  POST   /health/correlation/analyze        — AI pattern analysis of paired data

Endpoints:
  POST   /health/import          — manual upload + parse export.xml
  GET    /health/data?days=N     — time-series rows for graphing
  GET    /health/summary         — row count + date range
  GET    /health/latest          — most recent single day (dashboard widget)
  DELETE /health/delete-range    — ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
  DELETE /health/delete-all      — wipe everything
  GET    /health/auto-status     — folder watch + endpoint readiness info
  POST   /health/auto-import     — receive export.xml from iOS Shortcut
"""

import xml.etree.ElementTree as ET
import json
import logging
import shutil
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional
from collections import defaultdict

from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from pydantic import BaseModel
from database import get_conn

log    = logging.getLogger("witness.health")
router = APIRouter()

# ─── PATHS ───────────────────────────────────────────────────────────────────
# health-inbox/ lives next to the python-backend folder.
# On startup (called from main.py lifespan), check_health_inbox() scans it.

import os as _os
BACKEND_DIR  = Path(__file__).resolve().parent.parent   # witness/ root
# Use WITNESS_HEALTH_INBOX env var if set (packaged mode), else legacy location
_health_inbox_env = _os.environ.get("WITNESS_HEALTH_INBOX")
if _health_inbox_env:
    INBOX_DIR = Path(_health_inbox_env)
else:
    INBOX_DIR = BACKEND_DIR / "health-inbox"
PROCESSED_DIR = INBOX_DIR / "processed"

INBOX_DIR.mkdir(exist_ok=True, parents=True)
PROCESSED_DIR.mkdir(exist_ok=True, parents=True)

# Track the last auto-import times in memory (persisted to a tiny JSON sidecar)
AUTO_STATE_FILE = INBOX_DIR / ".auto-state.json"


def _load_auto_state() -> dict:
    try:
        if AUTO_STATE_FILE.exists():
            return json.loads(AUTO_STATE_FILE.read_text())
    except Exception:
        pass
    return {"folder_last_import": None, "endpoint_last_import": None}


def _save_auto_state(state: dict):
    try:
        AUTO_STATE_FILE.write_text(json.dumps(state))
    except Exception as e:
        log.warning(f"Could not save auto-state: {e}")


# ─── Apple Health type → column mapping ──────────────────────────────────────

QUANTITY_MAP = {
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "hrv",
    "HKQuantityTypeIdentifierRestingHeartRate":          "resting_hr",
    "HKQuantityTypeIdentifierRespiratoryRate":           "respiratory_rate",
    "HKQuantityTypeIdentifierOxygenSaturation":          "blood_oxygen",
    "HKQuantityTypeIdentifierStepCount":                 "steps",
    "HKQuantityTypeIdentifierActiveEnergyBurned":        "active_calories",
}

SLEEP_STAGE_MAP = {
    "HKCategoryValueSleepAnalysisAsleepDeep":  "deep",
    "HKCategoryValueSleepAnalysisAsleepREM":   "rem",
    "HKCategoryValueSleepAnalysisAsleepCore":  "light",
    "HKCategoryValueSleepAnalysisAwake":       "awake",
    "HKCategoryValueSleepAnalysisInBed":       "inbed",
}

# ─── PARSER ───────────────────────────────────────────────────────────────────

def _parse_dt(s: str) -> Optional[date]:
    if not s:
        return None
    try:
        return datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").date()
    except Exception:
        return None


def _parse_duration_mins(start_str: str, end_str: str) -> float:
    try:
        fmt   = "%Y-%m-%d %H:%M:%S"
        start = datetime.strptime(start_str[:19], fmt)
        end   = datetime.strptime(end_str[:19],   fmt)
        return max(0.0, (end - start).total_seconds() / 60.0)
    except Exception:
        return 0.0


def parse_health_xml_iterparse(xml_bytes: bytes) -> dict:
    """
    Parse Apple Health export XML using iterparse — safe for large files.
    Returns dict keyed by YYYY-MM-DD with aggregated health data.
    """
    log.info("Starting Apple Health XML parse (iterparse)...")

    def empty_bucket():
        return {
            "hrv":              [],
            "resting_hr":       [],
            "respiratory_rate": [],
            "blood_oxygen":     [],
            "steps":            0.0,
            "active_calories":  0.0,
            "sleep":            defaultdict(float),
            "workouts":         [],
        }

    by_date = defaultdict(empty_bucket)

    import io
    source = io.BytesIO(xml_bytes)

    for event, elem in ET.iterparse(source, events=("end",)):
        tag = elem.tag

        if tag == "Record":
            rtype = elem.get("type", "")
            start = elem.get("startDate", "")
            value = elem.get("value", "")
            d     = _parse_dt(start)
            if d is None:
                elem.clear()
                continue
            dstr = d.isoformat()

            if rtype in QUANTITY_MAP:
                col = QUANTITY_MAP[rtype]
                try:
                    fval = float(value)
                    if rtype == "HKQuantityTypeIdentifierOxygenSaturation":
                        fval = fval * 100
                    if col in ("steps", "active_calories"):
                        by_date[dstr][col] += fval
                    else:
                        by_date[dstr][col].append(fval)
                except (ValueError, TypeError):
                    pass

            elif rtype == "HKCategoryTypeIdentifierSleepAnalysis":
                stage = SLEEP_STAGE_MAP.get(elem.get("value", ""))
                if stage:
                    mins = _parse_duration_mins(
                        elem.get("startDate", ""),
                        elem.get("endDate", "")
                    )
                    by_date[dstr]["sleep"][stage] += mins

        elif tag == "Workout":
            start = elem.get("startDate", "")
            end   = elem.get("endDate", "")
            d     = _parse_dt(start)
            if d is None:
                elem.clear()
                continue
            dstr  = d.isoformat()
            wtype = elem.get("workoutActivityType", "").replace("HKWorkoutActivityType", "")
            mins  = _parse_duration_mins(start, end)
            by_date[dstr]["workouts"].append({"type": wtype, "mins": mins})

        elem.clear()

    def mean(lst):
        return round(sum(lst) / len(lst), 2) if lst else None

    result = {}
    for dstr, b in by_date.items():
        sleep    = b["sleep"]
        workouts = b["workouts"]
        workout_mins = sum(w["mins"] for w in workouts)
        workout_type = workouts[0]["type"] if workouts else None

        result[dstr] = {
            "hrv":              mean(b["hrv"]),
            "resting_hr":       mean(b["resting_hr"]),
            "respiratory_rate": mean(b["respiratory_rate"]),
            "blood_oxygen":     mean(b["blood_oxygen"]),
            "steps":            int(b["steps"]) if b["steps"] else 0,
            "active_calories":  round(b["active_calories"], 1),
            "sleep_total_mins": round(sum(sleep.values()), 1),
            "sleep_deep_mins":  round(sleep.get("deep",  0), 1),
            "sleep_rem_mins":   round(sleep.get("rem",   0), 1),
            "sleep_light_mins": round(sleep.get("light", 0), 1),
            "sleep_awake_mins": round(sleep.get("awake", 0), 1),
            "workout_mins":     round(workout_mins, 1),
            "workout_type":     workout_type,
        }

    log.info(f"Parsed {len(result)} days of health data.")
    return result


def save_health_data(parsed: dict) -> dict:
    """Upsert parsed health data into SQLite."""
    conn = get_conn()
    try:
        imported = updated = 0
        for dstr, data in parsed.items():
            existing = conn.execute(
                "SELECT id FROM health_data WHERE date = ?", (dstr,)
            ).fetchone()

            conn.execute("""
                INSERT OR REPLACE INTO health_data
                (date, hrv, resting_hr, respiratory_rate, blood_oxygen,
                 steps, active_calories, sleep_total_mins, sleep_deep_mins,
                 sleep_rem_mins, sleep_light_mins, sleep_awake_mins,
                 workout_mins, workout_type, raw_import)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                dstr,
                data["hrv"],
                data["resting_hr"],
                data["respiratory_rate"],
                data["blood_oxygen"],
                data["steps"],
                data["active_calories"],
                data["sleep_total_mins"],
                data["sleep_deep_mins"],
                data["sleep_rem_mins"],
                data["sleep_light_mins"],
                data["sleep_awake_mins"],
                data["workout_mins"],
                data["workout_type"],
                json.dumps(data)
            ))
            if existing:
                updated += 1
            else:
                imported += 1

        conn.commit()
        log.info(f"Health data saved: {imported} new, {updated} updated.")
        return {"imported": imported, "updated": updated}
    finally:
        conn.close()


# ─── WATCH FOLDER CHECK ───────────────────────────────────────────────────────
# Called from main.py lifespan on startup, and then every hour via background task.
# Also callable manually via POST /health/test-inbox.

async def check_health_inbox() -> dict:
    """
    Read health_watch_path from settings.
    Scan that folder for .xml files not yet recorded in health_imports.
    Import new ones, record them, move them to an 'imported/' subfolder.
    Falls back to the legacy health-inbox/ folder if no watch path is set.
    Returns { found: N, imported: N } for the caller.
    """
    from database import get_setting, get_conn

    watch_path_str = get_setting("health_watch_path", "").strip()

    # Determine which folder to scan
    if watch_path_str:
        watch_dir = Path(watch_path_str)
        if not watch_dir.exists():
            log.warning(f"Health watch folder not found: {watch_dir} — skipping.")
            return {"found": 0, "imported": 0}
    else:
        # Legacy fallback: use the built-in health-inbox/ folder
        watch_dir = INBOX_DIR

    imported_dir = watch_dir / "imported"
    try:
        imported_dir.mkdir(exist_ok=True)
    except Exception as e:
        log.warning(f"Health inbox: could not create 'imported/' subfolder: {e}")
        return {"found": 0, "imported": 0}

    xml_files = list(watch_dir.glob("*.xml"))
    if not xml_files:
        log.info(f"Health inbox: no .xml files in {watch_dir}")
        return {"found": 0, "imported": 0}

    log.info(f"Health inbox: found {len(xml_files)} .xml file(s) in {watch_dir}")
    total_imported = 0

    conn = get_conn()
    try:
        for xml_path in xml_files:
            try:
                stat     = xml_path.stat()
                filename = xml_path.name
                filesize = stat.st_size
                file_mtime = datetime.fromtimestamp(stat.st_mtime).isoformat()

                # Check if we've already imported this exact file (name + size match)
                already = conn.execute(
                    "SELECT id FROM health_imports WHERE filename = ? AND filesize = ?",
                    (filename, filesize)
                ).fetchone()

                if already:
                    log.info(f"Health inbox: {filename} already imported — skipping.")
                    continue

                log.info(f"Health inbox: importing {filename} ({filesize} bytes)...")
                xml_bytes = xml_path.read_bytes()
                parsed    = parse_health_xml_iterparse(xml_bytes)

                if not parsed:
                    log.warning(f"Health inbox: {filename} parsed but contained no data.")
                    records = 0
                else:
                    counts  = save_health_data(parsed)
                    records = counts["imported"] + counts["updated"]
                    log.info(f"Health inbox: {filename} → {counts['imported']} new, {counts['updated']} updated days.")
                    total_imported += 1

                # Record in health_imports so we never re-import this file
                conn.execute(
                    """INSERT INTO health_imports (filename, filesize, file_mtime, records)
                       VALUES (?, ?, ?, ?)""",
                    (filename, filesize, file_mtime, records)
                )
                conn.commit()

                # Move to imported/ with timestamp suffix so nothing is ever lost
                ts   = datetime.now().strftime("%Y%m%d-%H%M%S")
                dest = imported_dir / f"{xml_path.stem}-{ts}{xml_path.suffix}"
                shutil.move(str(xml_path), str(dest))
                log.info(f"Health inbox: moved {filename} → imported/{dest.name}")

                # Update legacy auto-state for backward compat with /auto-status
                state = _load_auto_state()
                state["folder_last_import"] = datetime.now().date().isoformat()
                _save_auto_state(state)

            except Exception as e:
                log.error(f"Health inbox: failed on {xml_path.name}: {e}")
                # Continue to next file — never crash the loop

    finally:
        conn.close()

    return {"found": len(xml_files), "imported": total_imported}


# ─── ROUTES ──────────────────────────────────────────────────────────────────

@router.post("/test-inbox")
async def test_inbox():
    """
    Manually trigger a watch-folder scan right now.
    Called by the Settings screen "CHECK NOW" button.
    Returns how many files were found and imported.
    """
    try:
        result = await check_health_inbox()
        return {
            "status":   "ok",
            "found":    result["found"],
            "imported": result["imported"],
        }
    except Exception as e:
        log.error(f"test-inbox error: {e}")
        return {"status": "error", "detail": str(e), "found": 0, "imported": 0}


@router.get("/import-status")
def get_import_status():
    """
    Return the most recent row from health_imports, or null if none.
    Used by the Settings screen "LAST AUTO-IMPORT" status line.
    """
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM health_imports ORDER BY imported_at DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()



@router.post("/import")
async def import_health(file: UploadFile = File(...)):
    """
    Manual upload of export.xml from the VITALS screen import panel.
    """
    if not (file.filename or "").lower().endswith(".xml"):
        raise HTTPException(status_code=400, detail="Please upload a .xml file from Apple Health.")

    try:
        xml_bytes = await file.read()
        parsed    = parse_health_xml_iterparse(xml_bytes)

        if not parsed:
            return {"status": "no_data", "imported": 0, "updated": 0}

        counts  = save_health_data(parsed)
        dates   = sorted(parsed.keys())
        return {
            **counts,
            "status":    "ok",
            "date_from": dates[0],
            "date_to":   dates[-1],
        }

    except ET.ParseError as e:
        raise HTTPException(status_code=400, detail=f"Invalid XML file: {e}")
    except Exception as e:
        log.error(f"Health import error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/auto-import")
async def auto_import_health(file: UploadFile = File(...)):
    """
    Network endpoint for iOS Shortcut / phone push.
    The phone POSTs the export.xml directly to this endpoint over local Wi-Fi.
    Works identically to /import but also updates the auto-state timestamp.

    iOS Shortcut setup (do this when ready):
      1. Create a Shortcut with "Get File" action pointing to your Health export
      2. Add "Get Contents of URL" action:
         - URL: http://[YOUR-PC-IP]:8000/health/auto-import
         - Method: POST
         - Body: Form — field name "file", value: the file from step 1
      3. Run Shortcut from your iPhone while on the same Wi-Fi as your PC
    """
    if not (file.filename or "").lower().endswith(".xml"):
        raise HTTPException(status_code=400, detail="Please upload a .xml file from Apple Health.")

    try:
        xml_bytes = await file.read()
        parsed    = parse_health_xml_iterparse(xml_bytes)

        if not parsed:
            return {"status": "no_data", "imported": 0, "updated": 0}

        counts = save_health_data(parsed)
        dates  = sorted(parsed.keys())

        # Update auto-state
        state = _load_auto_state()
        state["endpoint_last_import"] = datetime.now().date().isoformat()
        _save_auto_state(state)

        log.info(f"Auto-import (network): {counts['imported']} new, {counts['updated']} updated days.")
        return {
            **counts,
            "status":    "ok",
            "date_from": dates[0],
            "date_to":   dates[-1],
        }

    except ET.ParseError as e:
        raise HTTPException(status_code=400, detail=f"Invalid XML file: {e}")
    except Exception as e:
        log.error(f"Auto-import error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/auto-status")
def get_auto_status():
    """
    Returns the status of both auto-import channels for the VITALS UI.
    """
    state = _load_auto_state()
    return {
        "folder_watch":          True,   # always active — runs on startup
        "folder_last_import":    state.get("folder_last_import"),
        "endpoint_ready":        True,   # always live while backend is running
        "endpoint_last_import":  state.get("endpoint_last_import"),
        "inbox_path":            str(INBOX_DIR),
    }


@router.get("/data")
def get_health_data(days: int = 30):
    """Return health_data rows for graphing, ordered ASC."""
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM health_data WHERE date >= date('now', ?) ORDER BY date ASC",
            (f"-{days} days",)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/summary")
def get_health_summary():
    """Row count + date range. Used to decide empty-state."""
    conn = get_conn()
    try:
        row = conn.execute("""
            SELECT COUNT(*) as count,
                   MIN(date) as date_from,
                   MAX(date) as date_to
            FROM health_data
        """).fetchone()
        if not row or row["count"] == 0:
            return {"count": 0, "date_from": None, "date_to": None}
        return dict(row)
    finally:
        conn.close()


@router.get("/latest")
def get_latest_health():
    """Most recent day's health stats (for the dashboard widget)."""
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM health_data ORDER BY date DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


@router.delete("/delete-range")
def delete_health_range(
    date_from: str = Query(..., description="Start date YYYY-MM-DD"),
    date_to:   str = Query(..., description="End date YYYY-MM-DD"),
):
    """
    Delete health data rows between date_from and date_to (inclusive).
    Returns { deleted: N }
    """
    # Basic validation
    try:
        datetime.strptime(date_from, "%Y-%m-%d")
        datetime.strptime(date_to,   "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD format.")

    if date_from > date_to:
        raise HTTPException(status_code=400, detail="date_from must be before date_to.")

    conn = get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM health_data WHERE date >= ? AND date <= ?",
            (date_from, date_to)
        )
        conn.commit()
        deleted = cur.rowcount
        log.info(f"Deleted {deleted} health rows ({date_from} → {date_to})")
        return {"deleted": deleted, "date_from": date_from, "date_to": date_to}
    finally:
        conn.close()


@router.delete("/delete-all")
def delete_all_health():
    """
    Wipe all health data from SQLite.
    Returns { deleted: N }
    """
    conn = get_conn()
    try:
        cur = conn.execute("DELETE FROM health_data")
        conn.commit()
        deleted = cur.rowcount
        log.info(f"Wiped all health data: {deleted} rows deleted.")
        return {"deleted": deleted}
    finally:
        conn.close()


# ─── CORRELATION ENDPOINTS ────────────────────────────────────────────────────
# These join journal metrics (from the metrics table) with health data
# on the same dates. The metrics table is populated by the AI after each
# voice entry via POST /transcribe/extract-metrics.

@router.get("/correlation")
def get_correlation_data(days: int = 30):
    """
    Join journal metrics and health data on date.
    Returns rows where BOTH a metrics entry AND health data exist for the same date.

    The metrics table stores entry_id linking to journal_entries.
    journal_entries stores date as a full ISO timestamp (e.g. 2024-01-15T22:30:00).
    health_data stores date as YYYY-MM-DD only.
    We normalize with DATE() to handle the mismatch.

    Returns array of: { date, stress, mood, anxiety, energy,
                        hrv, resting_hr, sleep_total_mins,
                        sleep_deep_mins, sleep_rem_mins }
    Ordered by date ASC. Null values included — not every day has every metric.
    """
    days = min(max(days, 1), 90)  # clamp: 1-90
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT
                hd.date                         AS date,
                m.stress                        AS stress,
                m.mood                          AS mood,
                m.anxiety                       AS anxiety,
                m.energy                        AS energy,
                hd.hrv                          AS hrv,
                hd.resting_hr                   AS resting_hr,
                hd.sleep_total_mins             AS sleep_total_mins,
                hd.sleep_deep_mins              AS sleep_deep_mins,
                hd.sleep_rem_mins               AS sleep_rem_mins
            FROM health_data hd
            INNER JOIN metrics m
                ON hd.date = DATE(
                    (SELECT je.date FROM entries je WHERE je.id = m.entry_id)
                )
            WHERE hd.date >= date('now', ?)
            ORDER BY hd.date ASC
        """, (f"-{days} days",)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.get("/correlation/summary")
def get_correlation_summary(days: int = 30):
    """
    Quick summary for the frontend to decide whether to show the chart
    or the empty state. Returns row_count, date_from, date_to, and averages.
    """
    days = min(max(days, 1), 90)
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT
                hd.date             AS date,
                m.stress            AS stress,
                hd.hrv              AS hrv,
                hd.sleep_total_mins AS sleep_total_mins
            FROM health_data hd
            INNER JOIN metrics m
                ON hd.date = DATE(
                    (SELECT je.date FROM entries je WHERE je.id = m.entry_id)
                )
            WHERE hd.date >= date('now', ?)
            ORDER BY hd.date ASC
        """, (f"-{days} days",)).fetchall()

        if not rows:
            return {
                "row_count":        0,
                "date_from":        None,
                "date_to":          None,
                "avg_stress":       None,
                "avg_hrv":          None,
                "avg_sleep_hours":  None,
            }

        dates       = [r["date"]             for r in rows]
        stresses    = [r["stress"]            for r in rows if r["stress"]            is not None]
        hrvs        = [r["hrv"]               for r in rows if r["hrv"]               is not None]
        sleeps      = [r["sleep_total_mins"]  for r in rows if r["sleep_total_mins"]  is not None]

        def _avg(lst):
            return round(sum(lst) / len(lst), 2) if lst else None

        return {
            "row_count":       len(rows),
            "date_from":       dates[0],
            "date_to":         dates[-1],
            "avg_stress":      _avg(stresses),
            "avg_hrv":         _avg(hrvs),
            "avg_sleep_hours": round(_avg(sleeps) / 60, 2) if _avg(sleeps) else None,
        }
    finally:
        conn.close()


class CorrelationAnalyzeRequest(BaseModel):
    days: int = 30


@router.post("/correlation/analyze")
async def analyze_correlation(body: CorrelationAnalyzeRequest):
    """
    Fetch paired journal+health data, format it as a compact table,
    send it to the local AI model, and return a plain-English pattern summary.

    Requires at least 7 days of overlapping data.
    Returns: { analysis, days_analyzed, generated_at }
    """
    from ollama_manager import generate

    days = min(max(body.days, 1), 90)
    conn = get_conn()
    try:
        rows = conn.execute("""
            SELECT
                hd.date                         AS date,
                m.stress                        AS stress,
                hd.hrv                          AS hrv,
                hd.sleep_total_mins             AS sleep_total_mins
            FROM health_data hd
            INNER JOIN metrics m
                ON hd.date = DATE(
                    (SELECT je.date FROM entries je WHERE je.id = m.entry_id)
                )
            WHERE hd.date >= date('now', ?)
            ORDER BY hd.date ASC
        """, (f"-{days} days",)).fetchall()
    finally:
        conn.close()

    if len(rows) < 7:
        return {
            "analysis":      None,
            "error":         "not_enough_data",
            "days_analyzed": len(rows),
        }

    # Build a compact text table for the AI
    lines = ["DATE       | STRESS | HRV (ms) | SLEEP (hrs)", "-" * 46]
    for r in rows:
        stress_str = f"{r['stress']:.1f}" if r["stress"] is not None else "null"
        hrv_str    = f"{r['hrv']:.1f}"    if r["hrv"]    is not None else "null"
        if r["sleep_total_mins"] is not None:
            sleep_str = f"{r['sleep_total_mins'] / 60:.1f}"
        else:
            sleep_str = "null"
        lines.append(f"{r['date']} | {stress_str:>6} | {hrv_str:>8} | {sleep_str:>10}")

    data_table = "\n".join(lines)

    prompt = (
        "You are analyzing personal journal and health data. "
        "The data below shows daily stress score (1-10, higher = more stressed), "
        "HRV in milliseconds (higher = better recovery), "
        "and total sleep in hours. "
        "Identify 2-3 honest, specific patterns you notice. "
        "Cite the actual dates or date ranges where you see the pattern. "
        "Do not give advice. Do not soften observations. Do not use em dashes. "
        "Write in plain sentences. Maximum 150 words.\n\n"
        f"DATA:\n{data_table}"
    )

    try:
        raw = await generate(prompt=prompt, temperature=0.4, max_tokens=400)

        # Strip DeepSeek / other model think tags
        import re
        clean = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()

        return {
            "analysis":      clean,
            "days_analyzed": len(rows),
            "generated_at":  datetime.now().isoformat(),
        }
    except Exception as e:
        log.error(f"Correlation analysis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
