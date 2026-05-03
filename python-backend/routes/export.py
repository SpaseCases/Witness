"""
WITNESS — Export API  (Step 5)

Endpoints:
  GET /export/txt?start=YYYY-MM-DD&end=YYYY-MM-DD   — plain text export
  GET /export/pdf?start=YYYY-MM-DD&end=YYYY-MM-DD   — PDF export

Both return the file as a downloadable response.
If no date range is given, exports everything.
Includes: entry date/time, type label, transcript, structured summary (if any),
          mood/stress/energy/anxiety scores, and any QA pairs saved to the entry.
Weekly and monthly recaps are appended at the end if they exist.

Step 5 notes:
  - fpdf2 is a pure-Python PDF library, no external services needed.
  - Both endpoints stream the file bytes directly — Electron saves via dialog.
  - Missing data fields are skipped cleanly rather than showing None/null.
  - Font is Courier for text export, Helvetica for PDF (both monospace-adjacent,
    available on every system without embedding a custom font file).
"""

import io
import json
import logging
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import Response, PlainTextResponse

from database import get_conn

log    = logging.getLogger("witness.export")
router = APIRouter()


# ─── HELPERS ─────────────────────────────────────────────────────────────────

def _parse_date(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _fmt_score(val) -> str:
    """Format a float metric as '7.2/10', or return empty string if None."""
    if val is None:
        return ""
    try:
        return f"{round(float(val), 1)}/10"
    except (TypeError, ValueError):
        return ""


def _safe_json(raw, fallback=None):
    """Parse a JSON string from the DB. Return fallback on failure."""
    if not raw:
        return fallback if fallback is not None else []
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return fallback if fallback is not None else []


def _fetch_entries(start: Optional[date], end: Optional[date]) -> list:
    """Fetch all entries (+ metrics + QA pairs) in date range, oldest first."""
    conn = get_conn()
    try:
        conditions = []
        params = []
        if start:
            conditions.append("e.date >= ?")
            params.append(start.isoformat())
        if end:
            conditions.append("e.date <= ?")
            params.append(end.isoformat())
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = conn.execute(f"""
            SELECT e.*,
                   m.mood, m.stress, m.energy, m.anxiety, m.clarity,
                   m.productivity, m.social, m.sentiment
            FROM   entries e
            LEFT JOIN metrics m ON m.entry_id = e.id
            {where}
            ORDER BY e.date ASC, e.created_at ASC
        """, params).fetchall()

        entries = []
        for r in rows:
            entry = dict(r)
            # Fetch QA pairs
            qa_rows = conn.execute(
                "SELECT question, answer FROM qa_pairs WHERE entry_id = ? ORDER BY id",
                (entry["id"],)
            ).fetchall()
            entry["qa_pairs"] = [dict(q) for q in qa_rows]
            entries.append(entry)

        return entries

    finally:
        conn.close()


def _fetch_recaps(start: Optional[date], end: Optional[date]) -> list:
    """Fetch weekly and monthly recaps that fall within the date range."""
    conn = get_conn()
    try:
        conditions = ["type IN ('weekly','monthly')"]
        params = []
        if start:
            conditions.append("period_end >= ?")
            params.append(start.isoformat())
        if end:
            conditions.append("period_start <= ?")
            params.append(end.isoformat())
        where = "WHERE " + " AND ".join(conditions)

        rows = conn.execute(f"""
            SELECT type, generated_at, period_start, period_end, content
            FROM recaps
            {where}
            ORDER BY period_start ASC
        """, params).fetchall()

        return [dict(r) for r in rows]
    except Exception:
        # recaps table might not exist yet on older databases
        return []
    finally:
        conn.close()


def _type_label(entry_type: str) -> str:
    return {"daily": "JOURNAL ENTRY", "rant": "RANT / DUMP"}.get(entry_type, entry_type.upper())


# ─── PLAIN TEXT BUILDER ───────────────────────────────────────────────────────

def _build_txt(entries: list, recaps: list) -> str:
    lines = []

    lines.append("=" * 70)
    lines.append("WITNESS — EXPORTED JOURNAL")
    lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"Entries:   {len(entries)}")
    lines.append("=" * 70)
    lines.append("")

    for entry in entries:
        dt = entry.get("created_at", entry.get("date", ""))
        try:
            dt_fmt = datetime.fromisoformat(dt).strftime("%A, %B %-d %Y  %H:%M")
        except Exception:
            dt_fmt = dt

        lines.append("-" * 70)
        lines.append(f"{_type_label(entry.get('type','daily'))}")
        lines.append(f"DATE:  {dt_fmt}")
        if entry.get("starred"):
            lines.append("       * STARRED")
        lines.append("")

        # Structured summary if it exists
        ss = _safe_json(entry.get("structured_summary"), {})
        if ss and ss.get("summary"):
            lines.append(f"SUMMARY:  {ss['summary']}")
            if ss.get("highlights"):
                lines.append("HIGHLIGHTS:")
                for h in ss["highlights"]:
                    lines.append(f"  - {h}")
            if ss.get("intentions"):
                lines.append("INTENTIONS:")
                for i in ss["intentions"]:
                    lines.append(f"  - {i}")
            lines.append("")

        # Transcript
        transcript = (entry.get("transcript") or "").strip()
        if transcript:
            lines.append("TRANSCRIPT:")
            # Wrap at ~68 chars for readability
            words = transcript.split()
            current_line = ""
            for word in words:
                if len(current_line) + len(word) + 1 > 68:
                    lines.append(f"  {current_line}")
                    current_line = word
                else:
                    current_line = f"{current_line} {word}".strip()
            if current_line:
                lines.append(f"  {current_line}")
            lines.append("")

        # Metrics
        metric_parts = []
        for key, label in [
            ("mood", "MOOD"), ("stress", "STRESS"), ("energy", "ENERGY"),
            ("anxiety", "ANXIETY"), ("clarity", "CLARITY")
        ]:
            score = _fmt_score(entry.get(key))
            if score:
                metric_parts.append(f"{label} {score}")
        if metric_parts:
            lines.append("SCORES:  " + "   ".join(metric_parts))
            lines.append("")

        # QA pairs
        qa = entry.get("qa_pairs", [])
        if qa:
            lines.append("FOLLOW-UP:")
            for pair in qa:
                q = (pair.get("question") or "").strip()
                a = (pair.get("answer") or "").strip()
                if q:
                    lines.append(f"  Q: {q}")
                if a:
                    lines.append(f"  A: {a}")
            lines.append("")

        lines.append("")

    # Recaps section
    if recaps:
        lines.append("=" * 70)
        lines.append("RECAPS")
        lines.append("=" * 70)
        lines.append("")
        for recap in recaps:
            rtype = recap.get("type", "").upper()
            pstart = recap.get("period_start", "")
            pend = recap.get("period_end", "")
            lines.append(f"--- {rtype} RECAP: {pstart} to {pend} ---")
            lines.append("")
            content = (recap.get("content") or "").strip()
            if content:
                for line in content.split("\n"):
                    lines.append(line)
            lines.append("")

    lines.append("=" * 70)
    lines.append("END OF EXPORT")
    lines.append("=" * 70)

    return "\n".join(lines)


# ─── PDF BUILDER ─────────────────────────────────────────────────────────────

def _build_pdf(entries: list, recaps: list) -> bytes:
    from fpdf import FPDF

    class WitnessPDF(FPDF):
        def header(self):
            # thin amber rule at top of each page
            self.set_draw_color(224, 149, 32)  # --accent
            self.set_line_width(0.5)
            self.line(10, 8, 200, 8)
            self.set_y(10)

        def footer(self):
            self.set_y(-12)
            self.set_font("Helvetica", "I", 7)
            self.set_text_color(100, 100, 100)
            self.cell(0, 5, f"WITNESS  |  Page {self.page_no()}  |  Private — Not for distribution", 0, 0, "C")

    pdf = WitnessPDF()
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.set_margins(14, 14, 14)
    pdf.set_fill_color(26, 26, 26)   # --bg-surface

    # ── Cover page ──────────────────────────────────────────────────────────
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 32)
    pdf.set_text_color(240, 232, 220)   # --text-primary
    pdf.ln(24)
    pdf.cell(0, 14, "WITNESS", ln=True, align="C")
    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(160, 144, 128)   # --text-secondary
    pdf.cell(0, 8, "PRIVATE JOURNAL EXPORT", ln=True, align="C")
    pdf.ln(8)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(96, 96, 96)      # --text-muted
    pdf.cell(0, 6, f"Generated: {datetime.now().strftime('%B %-d, %Y  %H:%M')}", ln=True, align="C")
    pdf.cell(0, 6, f"Entries: {len(entries)}", ln=True, align="C")

    # Amber rule under cover title
    pdf.ln(6)
    pdf.set_draw_color(224, 149, 32)
    pdf.set_line_width(0.8)
    pdf.line(40, pdf.get_y(), 170, pdf.get_y())

    # ── Entries ─────────────────────────────────────────────────────────────
    for entry in entries:
        pdf.add_page()

        # Entry type + date bar
        dt = entry.get("created_at", entry.get("date", ""))
        try:
            dt_fmt = datetime.fromisoformat(dt).strftime("%A, %B %-d %Y  %H:%M")
        except Exception:
            dt_fmt = dt

        pdf.set_fill_color(32, 32, 32)
        pdf.set_text_color(224, 149, 32)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_draw_color(56, 56, 56)
        pdf.set_line_width(0.3)
        type_label = _type_label(entry.get("type", "daily"))
        if entry.get("starred"):
            type_label += "  *"
        pdf.cell(0, 6, type_label, border="B", ln=True, fill=True)

        pdf.set_text_color(240, 232, 220)
        pdf.set_font("Helvetica", "B", 13)
        pdf.ln(2)
        pdf.cell(0, 8, dt_fmt, ln=True)
        pdf.ln(2)

        # Structured summary
        ss = _safe_json(entry.get("structured_summary"), {})
        if ss and ss.get("summary"):
            pdf.set_font("Helvetica", "I", 9)
            pdf.set_text_color(160, 144, 128)
            pdf.multi_cell(0, 5, ss["summary"])
            pdf.ln(2)

            if ss.get("highlights"):
                pdf.set_font("Helvetica", "B", 8)
                pdf.set_text_color(224, 149, 32)
                pdf.cell(0, 5, "HIGHLIGHTS", ln=True)
                pdf.set_font("Helvetica", "", 9)
                pdf.set_text_color(160, 144, 128)
                for h in ss["highlights"]:
                    pdf.multi_cell(0, 5, f"  - {h}")

            if ss.get("intentions"):
                pdf.set_font("Helvetica", "B", 8)
                pdf.set_text_color(224, 149, 32)
                pdf.cell(0, 5, "INTENTIONS", ln=True)
                pdf.set_font("Helvetica", "", 9)
                pdf.set_text_color(160, 144, 128)
                for i in ss["intentions"]:
                    pdf.multi_cell(0, 5, f"  - {i}")
            pdf.ln(3)

        # Transcript
        transcript = (entry.get("transcript") or "").strip()
        if transcript:
            pdf.set_font("Helvetica", "B", 8)
            pdf.set_text_color(224, 149, 32)
            pdf.cell(0, 5, "TRANSCRIPT", ln=True)
            pdf.set_font("Helvetica", "", 10)
            pdf.set_text_color(240, 232, 220)
            pdf.multi_cell(0, 5.5, transcript)
            pdf.ln(3)

        # Scores
        metric_parts = []
        for key, label in [
            ("mood", "MOOD"), ("stress", "STRESS"), ("energy", "ENERGY"),
            ("anxiety", "ANXIETY"), ("clarity", "CLARITY")
        ]:
            score = _fmt_score(entry.get(key))
            if score:
                metric_parts.append(f"{label} {score}")

        if metric_parts:
            pdf.set_font("Helvetica", "B", 8)
            pdf.set_text_color(224, 149, 32)
            pdf.cell(0, 5, "SCORES", ln=True)
            pdf.set_font("Courier", "", 9)
            pdf.set_text_color(160, 144, 128)
            pdf.cell(0, 5, "   ".join(metric_parts), ln=True)
            pdf.ln(2)

        # QA pairs
        qa = entry.get("qa_pairs", [])
        if qa:
            pdf.set_font("Helvetica", "B", 8)
            pdf.set_text_color(224, 149, 32)
            pdf.cell(0, 5, "FOLLOW-UP", ln=True)
            for pair in qa:
                q = (pair.get("question") or "").strip()
                a = (pair.get("answer") or "").strip()
                if q:
                    pdf.set_font("Helvetica", "B", 9)
                    pdf.set_text_color(200, 190, 180)
                    pdf.multi_cell(0, 5, f"Q: {q}")
                if a:
                    pdf.set_font("Helvetica", "", 9)
                    pdf.set_text_color(160, 144, 128)
                    pdf.multi_cell(0, 5, f"A: {a}")
            pdf.ln(2)

    # ── Recaps appendix ─────────────────────────────────────────────────────
    if recaps:
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 16)
        pdf.set_text_color(240, 232, 220)
        pdf.cell(0, 10, "RECAPS", ln=True)
        pdf.set_draw_color(224, 149, 32)
        pdf.set_line_width(0.5)
        pdf.line(14, pdf.get_y(), 196, pdf.get_y())
        pdf.ln(4)

        for recap in recaps:
            rtype = recap.get("type", "").upper()
            pstart = recap.get("period_start", "")
            pend = recap.get("period_end", "")

            pdf.set_font("Helvetica", "B", 9)
            pdf.set_text_color(224, 149, 32)
            pdf.cell(0, 6, f"{rtype} RECAP  |  {pstart} to {pend}", ln=True)

            pdf.set_font("Helvetica", "", 9)
            pdf.set_text_color(160, 144, 128)
            content = (recap.get("content") or "").strip()
            if content:
                pdf.multi_cell(0, 5.5, content)
            pdf.ln(5)

    return bytes(pdf.output())


# ─── ENDPOINTS ────────────────────────────────────────────────────────────────

@router.get("/txt")
def export_txt(start: Optional[str] = None, end: Optional[str] = None):
    """
    Export journal entries as a plain text file.
    Query params: start=YYYY-MM-DD, end=YYYY-MM-DD (both optional)
    """
    start_date = _parse_date(start)
    end_date   = _parse_date(end)

    entries = _fetch_entries(start_date, end_date)
    recaps  = _fetch_recaps(start_date, end_date)

    content = _build_txt(entries, recaps)

    filename = "witness-export"
    if start_date:
        filename += f"-{start_date.isoformat()}"
    if end_date:
        filename += f"-to-{end_date.isoformat()}"
    filename += ".txt"

    return Response(
        content=content.encode("utf-8"),
        media_type="text/plain",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Entry-Count": str(len(entries)),
        }
    )


@router.get("/pdf")
def export_pdf(start: Optional[str] = None, end: Optional[str] = None):
    """
    Export journal entries as a PDF file.
    Query params: start=YYYY-MM-DD, end=YYYY-MM-DD (both optional)
    Requires: pip install fpdf2
    """
    try:
        import fpdf  # noqa — check it's installed before we build the data
    except ImportError:
        from fastapi import HTTPException as _E
        raise _E(
            status_code=500,
            detail="fpdf2 is not installed. Run: pip install fpdf2"
        )

    start_date = _parse_date(start)
    end_date   = _parse_date(end)

    entries = _fetch_entries(start_date, end_date)
    recaps  = _fetch_recaps(start_date, end_date)

    pdf_bytes = _build_pdf(entries, recaps)

    filename = "witness-export"
    if start_date:
        filename += f"-{start_date.isoformat()}"
    if end_date:
        filename += f"-to-{end_date.isoformat()}"
    filename += ".pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Entry-Count": str(len(entries)),
        }
    )
