# Bug fix: migration ordering (settings table before _migrate_rants), added structured_summary
#          to CREATE TABLE, added missing indexes (qa_pairs, flags, todos, chat_threads),
#          added error handling to get_setting/set_setting.
"""
WITNESS -- Database Layer
SQLite via Python's built-in sqlite3.
All tables created here on first run.
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

        # ── SETTINGS must come FIRST so _migrate_rants can write to it ────────
        c.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL,
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)

        # ── JOURNAL ENTRIES ──────────────────────────────────────────────────
        # structured_summary: JSON blob from AI extraction, stored alongside metrics
        c.execute("""
            CREATE TABLE IF NOT EXISTS entries (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
                date               TEXT    NOT NULL,
                type               TEXT    NOT NULL DEFAULT 'daily',
                transcript         TEXT    NOT NULL DEFAULT '',
                edited             INTEGER NOT NULL DEFAULT 0,
                starred            INTEGER NOT NULL DEFAULT 0,
                audio_path         TEXT,
                chroma_id          TEXT,
                tags               TEXT    NOT NULL DEFAULT '[]',
                good_tags          TEXT    NOT NULL DEFAULT '[]',
                bad_tags           TEXT    NOT NULL DEFAULT '[]',
                structured_summary TEXT
            )
        """)

        # Safe column migrations for existing databases
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

        # ── AI-EXTRACTED METRICS — safe migration for existing databases ────
        # If the metrics table already exists without the UNIQUE constraint,
        # we rebuild it. Duplicate entry_id rows (from the old INSERT bug)
        # are collapsed to the most recently extracted row per entry.
        if _table_exists(conn, "metrics"):
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
                screen_time_mins    REAL,
                raw_import          TEXT
            )
        """)

        if not _column_exists(conn, "health_data", "screen_time_mins"):
            log.info("Migration: adding 'screen_time_mins' column to health_data table.")
            c.execute("ALTER TABLE health_data ADD COLUMN screen_time_mins REAL")

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

        for col in ("patterns", "goals_review", "best_day_note", "worst_day_note"):
            if not _column_exists(conn, "weekly_recaps", col):
                log.info(f"Migration: adding '{col}' column to weekly_recaps table.")
                c.execute(f"ALTER TABLE weekly_recaps ADD COLUMN {col} TEXT")

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

        # ── AI MEMORY FACTS ──────────────────────────────────────────────────
        # dismissed=1 means the user deleted it; excluded from all reads.
        c.execute("""
            CREATE TABLE IF NOT EXISTS memory_facts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
                fact        TEXT    NOT NULL,
                dismissed   INTEGER NOT NULL DEFAULT 0
            )
        """)

        # ── CHAT THREADS ─────────────────────────────────────────────────────
        # Persistent named conversation threads. entry_context stores injected
        # journal entries (JSON) so the initial context is stable for the life
        # of the thread.
        c.execute("""
            CREATE TABLE IF NOT EXISTS chat_threads (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
                updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
                title         TEXT    NOT NULL DEFAULT 'New Thread',
                entry_context TEXT                                        -- JSON: injected entry snippets
            )
        """)

        # ── CHAT MESSAGES ────────────────────────────────────────────────────
        # role = 'user' | 'assistant'. Cascade-delete when parent thread is deleted.
        c.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id  INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
                created_at TEXT    NOT NULL DEFAULT (datetime('now')),
                role       TEXT    NOT NULL,
                content    TEXT    NOT NULL
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

        # ── LONGITUDINAL SELF-MODEL ──────────────────────────────────────────
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
        # entries
        c.execute("CREATE INDEX IF NOT EXISTS idx_entries_date       ON entries(date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_entries_type       ON entries(type)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_entries_starred    ON entries(starred)")
        # metrics
        c.execute("CREATE INDEX IF NOT EXISTS idx_metrics_date       ON metrics(date)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_metrics_entry_id   ON metrics(entry_id)")
        # qa_pairs — entry_id is the primary lookup key; missing in original
        c.execute("CREATE INDEX IF NOT EXISTS idx_qa_pairs_entry_id  ON qa_pairs(entry_id)")
        # health
        c.execute("CREATE INDEX IF NOT EXISTS idx_health_date        ON health_data(date)")
        # flags — Debrief filters by resolved+dismissed frequently
        c.execute("CREATE INDEX IF NOT EXISTS idx_flags_severity     ON flags(severity)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_flags_resolved     ON flags(resolved)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_flags_dismissed    ON flags(dismissed)")
        # todos — active query always filters done=0
        c.execute("CREATE INDEX IF NOT EXISTS idx_todos_done         ON todos(done)")
        # health imports
        c.execute("CREATE INDEX IF NOT EXISTS idx_health_imports_fn  ON health_imports(filename)")
        # memory
        c.execute("CREATE INDEX IF NOT EXISTS idx_memory_facts_dismissed ON memory_facts(dismissed)")
        # chat — thread list sorted by updated_at; messages fetched by thread_id
        c.execute("CREATE INDEX IF NOT EXISTS idx_chat_threads_updated   ON chat_threads(updated_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_chat_messages_thread   ON chat_messages(thread_id)")

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

        # _migrate_rants must run AFTER commit so the settings row is visible
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
    except Exception as e:
        log.warning(f"get_setting({key!r}) failed: {e}")
        return default
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
    except Exception as e:
        log.error(f"set_setting({key!r}) failed: {e}")
        raise
    finally:
        conn.close()
