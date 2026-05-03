"""
WITNESS -- Ollama Manager
Starts Ollama on app launch, stops it on close.
Checks model is loaded and ready before the UI appears.

Cross-platform (Windows + Linux):
  _find_ollama() checks both Windows AppData locations and Linux
  standard install paths (/usr/local/bin, /usr/bin, ~/.local/bin).
  All other logic is identical across platforms.

PyInstaller fix (Step 17):
  - PyInstaller bundles Python in an isolated env with no PATH access.
  - _find_ollama() searches known install locations directly,
    then falls back to PATH (which works in dev mode / system Python).
  - Electron's main.js also detects the Ollama path and passes it via
    the OLLAMA_PATH environment variable as a belt-and-suspenders approach.
"""

import asyncio
import subprocess
import httpx
import logging
import os
import sys
import time
import shutil

log = logging.getLogger("witness.ollama")

OLLAMA_URL     = "http://localhost:11434"
FALLBACK_MODEL = "gemma4:3b"   # lightweight default -- user can upgrade in CONFIG

_ollama_proc = None

# ── Model cache ───────────────────────────────────────────────────────────────

_cached_model: str   = ""
_cache_time:   float = 0.0
_CACHE_TTL:    float = 60.0


def _get_active_model() -> str:
    global _cached_model, _cache_time

    now = time.monotonic()
    if _cached_model and (now - _cache_time) < _CACHE_TTL:
        return _cached_model

    try:
        from database import get_setting
        model = get_setting("model", FALLBACK_MODEL).strip() or FALLBACK_MODEL
    except Exception as e:
        log.warning(f"Could not read model from settings DB: {e}. Using {FALLBACK_MODEL}.")
        model = FALLBACK_MODEL

    _cached_model = model
    _cache_time   = now
    return model


def invalidate_model_cache():
    global _cached_model, _cache_time
    _cached_model = ""
    _cache_time   = 0.0
    log.info("Model cache invalidated.")


# ── Ollama path detection ─────────────────────────────────────────────────────

def _find_ollama() -> str:
    """
    Return the full path to the Ollama executable.

    Search order:
    1. OLLAMA_PATH env var — set by Electron's main.js, which has full PATH
       access even when the app is packaged. Most reliable in production.
    2. Platform-specific known install locations — checked with os.path.isfile.
       Windows: AppData\\Local\\Programs\\Ollama\\ollama.exe
       Linux:   /usr/local/bin/ollama, /usr/bin/ollama, ~/.local/bin/ollama
    3. shutil.which() — works in dev mode where PATH is available.
    4. Bare "ollama" as last resort (relies on PATH at subprocess time).
    """

    # 1. Env var set by Electron (most reliable when running as packaged app)
    env_path = os.environ.get("OLLAMA_PATH", "").strip()
    if env_path and os.path.isfile(env_path):
        log.info(f"Found Ollama via OLLAMA_PATH: {env_path}")
        return env_path

    is_windows = sys.platform == "win32"

    if is_windows:
        # 2a. Common Windows install locations
        username     = os.environ.get("USERNAME", "")
        localappdata = os.environ.get("LOCALAPPDATA", "")

        candidates = []
        if localappdata:
            candidates.append(os.path.join(localappdata, "Programs", "Ollama", "ollama.exe"))
        if username:
            candidates.append(rf"C:\Users\{username}\AppData\Local\Programs\Ollama\ollama.exe")
        candidates += [
            r"C:\Program Files\Ollama\ollama.exe",
            r"C:\Program Files (x86)\Ollama\ollama.exe",
        ]

    else:
        # 2b. Common Linux (and Mac) install locations
        home = os.environ.get("HOME", "")
        candidates = [
            "/usr/local/bin/ollama",
            "/usr/bin/ollama",
            os.path.join(home, ".local", "bin", "ollama") if home else "",
            "/opt/ollama/ollama",
        ]

    for p in candidates:
        if p and os.path.isfile(p):
            log.info(f"Found Ollama at: {p}")
            return p

    # 3. PATH search (works in dev mode on all platforms)
    found = shutil.which("ollama")
    if found:
        log.info(f"Found Ollama in PATH: {found}")
        return found

    # 4. Last resort
    log.error(
        "Ollama executable not found. "
        "Install from https://ollama.ai and ensure it is in your PATH."
    )
    return "ollama"


# ── Ollama lifecycle ──────────────────────────────────────────────────────────

async def check_ollama() -> bool:
    """Returns True if Ollama is running and reachable."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            return r.status_code == 200
    except Exception:
        return False


async def start_ollama():
    """
    Start Ollama if it isn't already running.
    Then pre-load the model so the first query is fast.
    """
    global _ollama_proc

    if await check_ollama():
        log.info("Ollama already running -- skipping launch.")
        await _warm_model()
        return

    log.info("Launching Ollama server...")

    try:
        ollama_exe = _find_ollama()
        log.info(f"Using Ollama executable: {ollama_exe}")

        # CREATE_NO_WINDOW suppresses the console popup on Windows.
        # On Linux this flag does not exist and must not be passed.
        spawn_kwargs = dict(
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if sys.platform == "win32":
            spawn_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        _ollama_proc = subprocess.Popen(
            [ollama_exe, "serve"],
            **spawn_kwargs
        )

        for attempt in range(20):
            await asyncio.sleep(1)
            if await check_ollama():
                log.info(f"Ollama is up (attempt {attempt + 1}).")
                break
        else:
            log.error("Ollama did not start in time. Check that Ollama is installed.")
            return

        await _warm_model()

    except FileNotFoundError:
        log.error(
            "Ollama executable not found. "
            "Please install Ollama from https://ollama.ai"
        )


async def _warm_model():
    """Pre-load model weights so the first real query is fast."""
    try:
        from database import get_setting
        if get_setting("warmup_on_start", "1") == "0":
            log.info("Model warmup disabled in settings -- skipping.")
            return
    except Exception:
        pass

    model = _get_active_model()
    log.info(f"Warming up model: {model} ...")
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{OLLAMA_URL}/api/generate",
                json={
                    "model":  model,
                    "prompt": "Ready.",
                    "stream": False,
                    "options": {"num_predict": 1}
                }
            )
            if r.status_code == 200:
                log.info(f"Model {model} loaded and ready.")
            else:
                log.warning(
                    f"Model warm-up returned status {r.status_code}. "
                    f"Check that {model} is pulled in Ollama."
                )
    except Exception as e:
        log.error(f"Model warm-up failed: {e}")
        log.error(f"Make sure you've run: ollama pull {model}")


async def stop_ollama():
    """Shut down Ollama only if Witness launched it."""
    global _ollama_proc
    if _ollama_proc is not None:
        log.info("Stopping Ollama...")
        _ollama_proc.terminate()
        try:
            _ollama_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _ollama_proc.kill()
        _ollama_proc = None
        log.info("Ollama stopped.")
    else:
        log.info("Ollama was pre-existing -- leaving it running.")


# ── Inference ─────────────────────────────────────────────────────────────────

async def generate(
    prompt:      str,
    system:      str   = "",
    model:       str   = None,
    temperature: float = 0.7,
    max_tokens:  int   = 1024
) -> str:
    model = model or _get_active_model()

    payload = {
        "model":  model,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": temperature,
            "num_predict": max_tokens,
        }
    }

    if system and "deepseek-r1" not in model.lower():
        payload["system"] = system
    elif system:
        payload["prompt"] = f"{system}\n\n{prompt}"

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(f"{OLLAMA_URL}/api/generate", json=payload)
            r.raise_for_status()
            data = r.json()
            return data.get("response", "").strip()
    except httpx.TimeoutException:
        log.error("Ollama generate timed out.")
        raise
    except Exception as e:
        log.error(f"Ollama generate error: {e}")
        raise


async def generate_stream(
    prompt: str,
    system: str = "",
    model:  str = None,
):
    model = model or _get_active_model()

    payload = {
        "model":  model,
        "prompt": f"{system}\n\n{prompt}" if system else prompt,
        "stream": True,
        "options": {"temperature": 0.7}
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", f"{OLLAMA_URL}/api/generate", json=payload) as r:
            async for line in r.aiter_lines():
                if line:
                    import json
                    try:
                        chunk = json.loads(line)
                        if token := chunk.get("response"):
                            yield token
                        if chunk.get("done"):
                            break
                    except json.JSONDecodeError:
                        continue
