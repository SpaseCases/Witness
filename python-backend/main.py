"""
WITNESS — Python Backend
FastAPI server handling: Ollama, Faster-Whisper, SQLite, ChromaDB
Starts automatically when the Electron app opens.
Kills automatically when the Electron app closes.

Step 5 addition:
  - export_router registered at /export
    Provides GET /export/txt and GET /export/pdf
    Requires: pip install fpdf2
"""

import os
import sys
import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# ── Local modules ─────────────────────────────────────────────────────────────
from database import init_db
from ollama_manager import start_ollama, stop_ollama, check_ollama
from routes.entries    import router as entries_router
from routes.insights   import router as insights_router
from routes.health     import router as health_router
from routes.settings   import router as settings_router
from routes.transcribe import router as transcribe_router
from routes.rant       import router as rant_router
from routes.recap      import router as recap_router
from routes.todos      import router as todos_router
from routes.chat       import router as chat_router
from routes.monthly_recap import router as monthly_recap_router
from routes.profile    import router as profile_router
from routes.export     import router as export_router      # Step 5: export
from routes.memory     import router as memory_router      # Step 5: memory

# ── Health inbox check ────────────────────────────────────────────────────────
from routes.health import check_health_inbox

# ─────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger("witness")

# ─── LIFESPAN ────────────────────────────────────────────────────────────────

async def _hourly_health_watcher():
    """
    Background task: calls check_health_inbox() every hour indefinitely.
    Started during app lifespan — runs until the process exits.
    """
    while True:
        await asyncio.sleep(3600)   # wait one hour before first repeat
        try:
            log.info("Hourly health watcher: checking inbox...")
            result = await check_health_inbox()
            log.info(f"Hourly health watcher: found={result['found']}, imported={result['imported']}")
        except Exception as e:
            log.error(f"Hourly health watcher error: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Witness backend starting...")

    # ── Phase 1: DB init FIRST, then health inbox check ─────────────────────
    log.info("Phase 1a: initializing database...")
    await asyncio.to_thread(init_db)
    log.info("Phase 1a complete: database ready.")

    log.info("Phase 1b: checking health inbox...")
    await check_health_inbox()
    log.info("Phase 1b complete: health inbox checked.")

    # ── Phase 2: Start Ollama (needs DB ready to read the active model) ──────
    log.info("Phase 2: starting Ollama...")
    await start_ollama()
    log.info("Ollama ready.")

    log.info("Starting hourly health watcher...")
    asyncio.create_task(_hourly_health_watcher())
    log.info("Hourly health watcher running.")

    yield

    log.info("Witness backend shutting down...")
    await stop_ollama()
    log.info("Shutdown complete.")

# ─── APP ─────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Witness API",
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "app://.",
        "file://",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── ROUTES ──────────────────────────────────────────────────────────────────

app.include_router(entries_router,       prefix="/entries",       tags=["entries"])
app.include_router(insights_router,      prefix="/insights",      tags=["insights"])
app.include_router(health_router,        prefix="/health",        tags=["health"])
app.include_router(settings_router,      prefix="/settings",      tags=["settings"])
app.include_router(transcribe_router,    prefix="/transcribe",    tags=["transcribe"])
app.include_router(rant_router,          prefix="/rant",          tags=["rant"])
app.include_router(recap_router,         prefix="/recap",         tags=["recap"])
app.include_router(todos_router,         prefix="/todos",         tags=["todos"])
app.include_router(chat_router,          prefix="/chat",          tags=["chat"])
app.include_router(monthly_recap_router, prefix="/recap/monthly", tags=["monthly_recap"])
app.include_router(profile_router,       prefix="/profile",       tags=["profile"])
app.include_router(export_router,        prefix="/export",        tags=["export"])  # Step 5
app.include_router(memory_router,        prefix="/memory",        tags=["memory"])   # Step 5

# ─── STATUS ───────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "app": "witness", "version": "2.0.0"}

@app.get("/status")
async def status():
    from database import get_setting
    ollama_ok    = await check_ollama()
    active_model = get_setting("model", os.environ.get("WITNESS_MODEL", "gemma4:3b"))
    return {
        "backend": "online",
        "ollama":  "online" if ollama_ok else "offline",
        "model":   active_model
    }

# ─── ENTRY POINT ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # IMPORTANT: pass the app object directly, NOT the string "main:app".
    # When bundled with PyInstaller there is no main.py on disk for uvicorn
    # to import by name -- it must receive the already-constructed app object.
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000,
        log_level="info",
        reload=False
    )
