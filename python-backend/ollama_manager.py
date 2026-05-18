# Bug fix: generate() now strips DeepSeek <think> blocks centrally; added num_ctx,
#          repeat_penalty, min_p, fmt (JSON mode) parameters; generate_stream() adds
#          temperature param, strips <think> tokens, adds num_ctx/repeat_penalty/min_p;
#          json import moved to top; FALLBACK_MODEL corrected; timeout raised to 300s
#          with caller-overrideable parameter.
"""
WITNESS -- Ollama Manager
Starts Ollama on app launch, stops it on close.
Checks model is loaded and ready before the UI appears.

Cross-platform (Windows + Linux):
  _find_ollama() checks both Windows AppData locations and Linux
  standard install paths (/usr/local/bin, /usr/bin, ~/.local/bin).
  All other logic is identical across platforms.
"""

import asyncio
import json
import re
import subprocess
import httpx
import logging
import os
import sys
import time
import shutil

log = logging.getLogger("witness.ollama")

OLLAMA_URL     = "http://localhost:11434"
FALLBACK_MODEL = "deepseek-r1:14b"   # matches DB default

_ollama_proc = None

# ── DeepSeek think-block stripper ────────────────────────────────────────────

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

def _strip_think(text: str) -> str:
    """Remove DeepSeek R1 <think>...</think> reasoning blocks from output."""
    return _THINK_RE.sub("", text).strip()


def clean_llm_json(raw: str) -> str:
    """
    Extract bare JSON from an LLM response.

    DeepSeek R1 has two failure modes:
      1. JSON appears AFTER </think> — stripping think tags leaves clean JSON
      2. JSON appears INSIDE <think>...</think> — stripping think tags destroys it

    Strategy: find a JSON object/array anywhere in the raw string first,
    validate it, and return it. Fall back to stripping think tags and fences.
    Centralised here so all route files import from one place.
    """
    json_in_raw = re.search(r'(\{[\s\S]*\}|\[[\s\S]*\])', raw)
    if json_in_raw:
        candidate = json_in_raw.group(1).strip()
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            pass

    text = _THINK_RE.sub("", raw)
    fence_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if fence_match:
        text = fence_match.group(1)
    return text.strip()

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
    1. OLLAMA_PATH env var — set by Electron's main.js.
    2. Platform-specific known install locations.
    3. shutil.which() — works in dev mode.
    4. Bare "ollama" as last resort.
    """

    env_path = os.environ.get("OLLAMA_PATH", "").strip()
    if env_path and os.path.isfile(env_path):
        log.info(f"Found Ollama via OLLAMA_PATH: {env_path}")
        return env_path

    is_windows = sys.platform == "win32"

    if is_windows:
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

    found = shutil.which("ollama")
    if found:
        log.info(f"Found Ollama in PATH: {found}")
        return found

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
    prompt:         str,
    system:         str   = "",
    model:          str   = None,
    temperature:    float = 0.7,
    max_tokens:     int   = 1024,
    num_ctx:        int   = 8192,
    repeat_penalty: float = 1.1,
    fmt:            str   = "",      # pass "json" to enable Ollama JSON mode
    timeout:        float = 300.0,
) -> str:
    """
    Call Ollama /api/generate (non-streaming).

    Parameters
    ----------
    prompt          : user/task prompt
    system          : system prompt (prepended to prompt for DeepSeek models)
    model           : override active model
    temperature     : sampling temperature (see task table in session doc)
    max_tokens      : max output tokens (num_predict)
    num_ctx         : context window size — default 8192, use 16384 for recap tasks
    repeat_penalty  : repetition penalty — 1.1 is good for prose tasks
    fmt             : set to "json" to enable Ollama's JSON mode
    timeout         : HTTP timeout in seconds (default 300 for long analysis tasks)

    Returns the model's response with DeepSeek <think> blocks stripped.
    """
    model = model or _get_active_model()

    options = {
        "temperature":    temperature,
        "num_predict":    max_tokens,
        "num_ctx":        num_ctx,
        "repeat_penalty": repeat_penalty,
        "min_p":          0.05,
    }

    # Build prompt — DeepSeek R1 doesn't use a separate system field
    if system and "deepseek-r1" not in model.lower():
        final_system = system
        final_prompt = prompt
    elif system:
        final_system = ""
        final_prompt = f"{system}\n\n{prompt}"
    else:
        final_system = ""
        final_prompt = prompt

    payload: dict = {
        "model":   model,
        "prompt":  final_prompt,
        "stream":  False,
        "options": options,
    }
    if final_system:
        payload["system"] = final_system
    if fmt:
        payload["format"] = fmt

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(f"{OLLAMA_URL}/api/generate", json=payload)
            r.raise_for_status()
            data = r.json()
            raw = data.get("response", "").strip()
            return _strip_think(raw)
    except httpx.TimeoutException:
        log.error(f"Ollama generate timed out after {timeout}s.")
        raise
    except httpx.HTTPStatusError as e:
        log.error(f"Ollama generate HTTP error {e.response.status_code}: {e.response.text[:200]}")
        raise
    except Exception as e:
        log.error(f"Ollama generate error: {e}")
        raise


async def generate_stream(
    prompt:         str,
    system:         str   = "",
    model:          str   = None,
    temperature:    float = 0.75,
    num_ctx:        int   = 8192,
    repeat_penalty: float = 1.1,
):
    """
    Call Ollama /api/generate with streaming=True.

    Yields response tokens one at a time with DeepSeek <think> blocks filtered.
    The think block is buffered and suppressed — the caller only sees real output.
    """
    model = model or _get_active_model()

    final_prompt = f"{system}\n\n{prompt}" if system else prompt

    payload = {
        "model":  model,
        "prompt": final_prompt,
        "stream": True,
        "options": {
            "temperature":    temperature,
            "num_ctx":        num_ctx,
            "repeat_penalty": repeat_penalty,
            "min_p":          0.05,
        }
    }

    # State machine to suppress <think>...</think> during streaming
    in_think   = False
    think_buf  = ""

    async with httpx.AsyncClient(timeout=300.0) as client:
        async with client.stream("POST", f"{OLLAMA_URL}/api/generate", json=payload) as r:
            async for line in r.aiter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue

                token = chunk.get("response", "")

                if token:
                    # Accumulate and check for think block boundaries
                    think_buf += token

                    # Drain think_buf: suppress <think>...</think>, yield the rest
                    while True:
                        if in_think:
                            end = think_buf.find("</think>")
                            if end == -1:
                                # Still inside think block — consume all buffered
                                think_buf = ""
                                break
                            else:
                                # End of think block found — discard it, continue
                                think_buf = think_buf[end + len("</think>"):]
                                in_think  = False
                        else:
                            start = think_buf.find("<think>")
                            if start == -1:
                                # No think block — yield everything
                                if think_buf:
                                    yield think_buf
                                think_buf = ""
                                break
                            else:
                                # Yield content before the think block
                                before = think_buf[:start]
                                if before:
                                    yield before
                                think_buf = think_buf[start + len("<think>"):]
                                in_think  = True

                if chunk.get("done"):
                    # Yield any remaining buffered content (outside think blocks)
                    if think_buf and not in_think:
                        yield think_buf
                    break
