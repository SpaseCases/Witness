"""
WITNESS -- Database Layer
SQLite via Python's built-in sqlite3.
All tables created here on first run.

Step 4 additions:
  - user_profile table: stores longitudinal self-model snapshots generated
    by /profile/generate. Multiple rows can exist; the API returns the newest.
  - Safe: IF NOT EXISTS guarantees no crash on existing databases.

Bug 2 fix:
  - Added 'tags' TEXT column (DEFAULT '[]') to the entries table.
    This is where rant topic tags are stored going forward.
  - Safe migration: on every startup, checks if the column already exists
    before attempting ALTER TABLE. Will never crash on an existing database.
  - Marks rants as migrated via the 'rants_migrated' settings key so the
    one-time migration only runs once.

Step 6 additions:
  - todos table gains 'notes' TEXT column (JSON array of appended notes)
  - todos table gains 'is_project' INTEGER column (0=task, 1=project)
  - Safe migrations for both new columns on existing databases.
"""

import sqlite3
import os
import logging
from pathlib import Path

log = logging.getLogger("witness.db")

# Use WITNESS_USER_DATA env var if set (packaged mode), else fall back to dev location
_user_data = os.environ.get("WITNESS_USER_DATA")
if _user_data:
    DB_PATH = Path(_user_data) / "witness.db"
else:
    DB_PATH = Path(__file__).parent / "witness.db"


def get_conn() -> sqlite3.Connection:
    """Open a database connection. Call this whenever you need to query."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _column_exists(conn, table: str, column: str) -> bool:
    """Check if a column exists in a table. Used for safe migrations."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == column for r in rows)


def _table_exists(conn, table: str) -> bool:
    """Check if a table exists in the database."""
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table,)
    ).fetchone()
    return row is not None


def init_db():
    """
    Create all tables if they don't exist yet.
    Safe to call every startup -- won't overwrite existing data.
    Also runs safe column migrations for existing databases.
    """
    conn = get_conn()
    try:
        c = conn.cursor()

        # ── JOURNAL ENTRIES ──────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS entries (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
                date          TEXT    NOT NULL,
                type          TEXT    NOT NULL DEFAULT 'daily',
                transcript    TEXT    NOT NULL DEFAULT '',
                edited        INTEGER NOT NULL DEFAULT 0,
                starred       INTEGER NOT NULL DEFAULT 0,
                audio_path    TEXT,
                chroma_id     TEXT,
                tags          TEXT    NOT NULL DEFAULT '[]',
                good_tags     TEXT    NOT NULL DEFAULT '[]',
                bad_tags      TEXT    NOT NULL DEFAULT '[]'
            )
        """)

        if not _column_exists(conn, "entries", "tags"):
            log.info("Migration: adding 'tags' column to entries table.")
            c.execute("ALTER TABLE entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")

        if not _column_exists(conn, "entries", "good_tags"):
            log.info("Migration: adding 'good_tags' column to entries table.")
            c.execute("ALTER TABLE entries ADD COLUMN good_tags TEXT NOT NULL DEFAULT '[]'")

        if not _column_exists(conn, "entries", "bad_tags"):
            log.info("Migration: adding 'bad_tags' column to entries table.")
            c.execute("ALTER TABLE entries ADD COLUMN bad_tags TEXT NOT NULL DEFAULT '[]'")

        if not _column_exists(conn, "entries", "structured_summary"):
            log.info("Migration: adding 'structured_summary' column to entries table.")
            c.execute("ALTER TABLE entries ADD COLUMN structured_summary TEXT")

        # ── AI-EXTRACTED METRICS ─────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS metrics (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id         INTEGER NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
                date             TEXT    NOT NULL,
                stress           REAL,
                mood             REAL,
                anxiety          REAL,
                energy           REAL,
                mental_clarity   REAL,
                productivity     REAL,
                social_sat       REAL,
                sentiment        REAL,
                raw_extraction   TEXT
            )
        """)

        # ── FOLLOW-UP QUESTIONS + ANSWERS ────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS qa_pairs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                question    TEXT    NOT NULL,
                answer      TEXT    NOT NULL DEFAULT ''
            )
        """)

        # ── BEHAVIORAL FLAGS ─────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS flags (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
                severity      TEXT    NOT NULL DEFAULT 'low',
                category      TEXT    NOT NULL,
                title         TEXT    NOT NULL,
                description   TEXT    NOT NULL,
                evidence      TEXT,
                resolved      INTEGER NOT NULL DEFAULT 0,
                dismissed     INTEGER NOT NULL DEFAULT 0
            )
        """)

        # ── APPLE HEALTH DATA ────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS health_data (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                date                TEXT    NOT NULL UNIQUE,
                hrv                 REAL,
                resting_hr          REAL,
                respiratory_rate    REAL,
                sleep_total_mins    REAL,
                sleep_deep_mins     REAL,
                sleep_rem_mins      REAL,
                sleep_light_mins    REAL,
                sleep_awake_mins    REAL,
                steps               INTEGER,
                active_calories     REAL,
                workout_mins        REAL,
                workout_type        TEXT,
                blood_oxygen        REAL,
                raw_import          TEXT
            )
        """)

        # ── WEEKLY RECAPS ────────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS weekly_recaps (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                week_start     TEXT    NOT NULL UNIQUE,
                created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
                summary        TEXT,
                goals_prev     TEXT,
                goals_next     TEXT,
                patterns       TEXT,
                goals_review   TEXT,
                best_day_note  TEXT,
                worst_day_note TEXT,
                exported       INTEGER NOT NULL DEFAULT 0
            )
        """)

        # ── MONTHLY RECAPS ───────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS monthly_recaps (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                period_start        TEXT    NOT NULL,
                period_end          TEXT    NOT NULL,
                created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
                summary             TEXT,
                trend_direction     TEXT,
                biggest_shift       TEXT,
                recurring_themes    TEXT,
                honest_observation  TEXT,
                watch_next_month    TEXT,
                goals_next          TEXT,
                UNIQUE(period_start, period_end)
            )
        """)

        # ── AI-EXTRACTED METRICS — safe migration for existing databases ────
        # If the metrics table already exists without the UNIQUE constraint,
        # we rebuild it. This is safe: we copy all rows, drop, recreate, reinsert.
        # Duplicate entry_id rows (from the old INSERT bug) are collapsed to the
        # most recently extracted row per entry.
        if _table_exists(conn, "metrics"):
            # Check if UNIQUE constraint already exists by looking for the index
            has_unique = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' "
                "AND tbl_name='metrics' AND sql LIKE '%entry_id%'"
            ).fetchone()
            if not has_unique:
                log.info("Migration: rebuilding metrics table to add UNIQUE(entry_id)...")
                c.execute("""
                    CREATE TABLE IF NOT EXISTS metrics_new (
                        id               INTEGER PRIMARY KEY AUTOINCREMENT,
                        entry_id         INTEGER NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
                        date             TEXT    NOT NULL,
                        stress           REAL,
                        mood             REAL,
                        anxiety          REAL,
                        energy           REAL,
                        mental_clarity   REAL,
                        productivity     REAL,
                        social_sat       REAL,
                        sentiment        REAL,
                        raw_extraction   TEXT
                    )
                """)
                # Copy most-recent row per entry_id (collapses duplicates)
                c.execute("""
                    INSERT OR IGNORE INTO metrics_new
                    SELECT id, entry_id, date, stress, mood, anxiety, energy,
                           mental_clarity, productivity, social_sat, sentiment, raw_extraction
                    FROM metrics
                    WHERE id IN (
                        SELECT MAX(id) FROM metrics GROUP BY entry_id
                    )
                """)
                c.execute("DROP TABLE metrics")
                c.execute("ALTER TABLE metrics_new RENAME TO metrics")
                log.info("Migration: metrics table rebuilt with UNIQUE(entry_id).")
        for col in ("patterns", "goals_review", "best_day_note", "worst_day_note"):
            if not _column_exists(conn, "weekly_recaps", col):
                log.info(f"Migration: adding '{col}' column to weekly_recaps table.")
                c.execute(f"ALTER TABLE weekly_recaps ADD COLUMN {col} TEXT")

        # ── SETTINGS ────────────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)

        # ── RANT TOPICS ─────────────────────────────────────────────────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS rant_topics (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                topic       TEXT    NOT NULL,
                confidence  REAL    NOT NULL DEFAULT 1.0
            )
        """)

        # ── TO-DO LIST ───────────────────────────────────────────────────────
        # notes:      JSON array of appended note strings (AI or manual)
        # is_project: 1 if the AI determined this is a multi-step project
        c.execute("""
            CREATE TABLE IF NOT EXISTS todos (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
                text             TEXT    NOT NULL,
                done             INTEGER NOT NULL DEFAULT 0,
                done_at          TEXT,
                source_entry_id  INTEGER,
                source_date      TEXT,
                notes            TEXT    NOT NULL DEFAULT '[]',
                is_project       INTEGER NOT NULL DEFAULT 0
            )
        """)

        # Safe migrations for new todos columns on existing databases
        if not _column_exists(conn, "todos", "notes"):
            log.info("Migration: adding 'notes' column to todos table.")
            c.execute("ALTER TABLE todos ADD COLUMN notes TEXT NOT NULL DEFAULT '[]'")

        if not _column_exists(conn, "todos", "is_project"):
            log.info("Migration: adding 'is_project' column to todos table.")
            c.execute("ALTER TABLE todos ADD COLUMN is_project INTEGER NOT NULL DEFAULT 0")

        # ── AI MEMORY FACTS (Step 5) ─────────────────────────────────────────
        # Stores atomic personal facts extracted from journal entries.
        # dismissed=1 means the user deleted it; excluded from all reads.
        c.execute("""
            CREATE TABLE IF NOT EXISTS memory_facts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                fact        TEXT    NOT NULL,
                dismissed   INTEGER NOT NULL DEFAULT 0
            )
        """)

        # ── HEALTH AUTO-IMPORT LOG ───────────────────────────────────────────
        # Tracks every file that has been auto-imported from the watch folder
        # so we never import the same file twice.
        c.execute("""
            CREATE TABLE IF NOT EXISTS health_imports (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                imported_at TEXT    NOT NULL DEFAULT (datetime('now')),
                filename    TEXT    NOT NULL,
                filesize    INTEGER,
                file_mtime  TEXT,
                records     INTEGER
            )
        """)

        # ── LONGITUDINAL SELF-MODEL (Step 4) ────────────────────────────────
        # Stores generated profile snapshots. Each call to /profile/generate
        # inserts a new row; /profile/ returns the most recent one.
        c.execute("""
            CREATE TABLE IF NOT EXISTS user_profile (
                id                          INTEGER PRIMARY KEY AUTOINCREMENT,
                generated_at                TEXT    NOT NULL DEFAULT (datetime('now')),
                recurring_themes            TEXT,   -- JSON array of strings
                emotional_patterns          TEXT,   -- JSON array of strings
                apparent_values             TEXT,   -- JSON array of strings
                recurring_challenges        TEXT,   -- JSON array of strings
                plain_summary               TEXT,
                entry_count_at_generation   INTEGER
            )
        """)

        # ── INDEXES ──────────────────────────────────────────────────────────
        c.execute("CREATE INDEX IF NOT EXISTS idx_entries_date    ON entries(date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_entries_type    ON entries(type)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_entries_starred ON entries(starred)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_metrics_date    ON metrics(date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_health_date     ON health_data(date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_flags_severity  ON flags(severity)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_health_imports_fn ON health_imports(filename)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_memory_facts_dismissed ON memory_facts(dismissed)")

        # ── DEFAULT SETTINGS ─────────────────────────────────────────────────
        defaults = {
            "model":             "deepseek-r1:14b",
            "context_window":    "16384",
            "notify_time":       "20:00",
            "notify_enabled":    "1",
            "theme_accent":      "amber",
            "health_watch_path": "",
            "user_profile":      "",
            "question_pool":     "[]",
            "onboarded":         "0",
            "rants_migrated":    "0",
            "warmup_on_start":   "1",
            "memory_document":         "",
            "memory_document_updated": "",
        }
        for key, val in defaults.items():
            c.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
                (key, val)
            )

        conn.commit()

        _migrate_rants(conn)

        log.info(f"Database initialized at {DB_PATH}")

    except Exception as e:
        log.error(f"Database init failed: {e}")
        raise
    finally:
        conn.close()


def _migrate_rants(conn):
    """
    One-time migration: retire the old 'rants' table.
    """
    already_done = conn.execute(
        "SELECT value FROM settings WHERE key = 'rants_migrated'"
    ).fetchone()

    if already_done and already_done["value"] == "1":
        return

    if _table_exists(conn, "rants"):
        log.info("Migration: retiring old rants table.")

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) "
        "VALUES ('rants_migrated', '1', datetime('now'))"
    )
    conn.commit()
    log.info("Rant migration complete.")


def get_setting(key: str, default: str = "") -> str:
    """Read a single setting value."""
    conn = get_conn()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default
    finally:
        conn.close()


def set_setting(key: str, value: str):
    """Write a single setting value."""
    conn = get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            (key, value)
        )
        conn.commit()
    finally:
        conn.close()
