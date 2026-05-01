"""
WITNESS -- Settings API  (Step 15)
Read and write app configuration.
Adds: curated model catalog endpoint, streaming pull endpoint,
      improved AMD VRAM detection with PowerShell fallback,
      in-session hardware detection cache.

ROUTE ORDER NOTE: In FastAPI, routes are matched top-to-bottom.
Wildcard @router.get("/{key}") must come AFTER all specific named routes.
"""

import json
import httpx
import logging
import platform
import subprocess
import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from database import get_conn, get_setting, set_setting

router = APIRouter()
log    = logging.getLogger("witness.settings")

DB_PATH = Path(__file__).parent.parent / "witness.db"


# ─── SCHEMAS ─────────────────────────────────────────────────────────────────

class SettingUpdate(BaseModel):
    value: str

class PullRequest(BaseModel):
    model: str


# ─── HARDWARE DETECTION (cached per session) ─────────────────────────────────

_hw_cache: dict | None = None   # None = not yet detected


def _detect_hardware() -> dict:
    """
    Detect GPU, VRAM, RAM, CPU, OS on Windows.
    Result is cached for the entire app session (hardware doesn't change).
    Falls back from wmic -> PowerShell -> None for VRAM.
    Never raises.
    """
    global _hw_cache
    if _hw_cache is not None:
        return _hw_cache

    hw = {
        "ram_gb":   None,
        "gpu_name": None,
        "vram_gb":  None,
        "cpu":      None,
        "os":       None,
    }

    # RAM
    try:
        import psutil
        hw["ram_gb"] = round(psutil.virtual_memory().total / (1024 ** 3))
    except Exception as e:
        log.warning(f"Hardware detect: RAM failed: {e}")

    # CPU
    try:
        hw["cpu"] = platform.processor() or None
    except Exception as e:
        log.warning(f"Hardware detect: CPU failed: {e}")

    # OS
    try:
        hw["os"] = f"{platform.system()} {platform.release()}".strip() or None
    except Exception as e:
        log.warning(f"Hardware detect: OS failed: {e}")

    # ── GPU name + VRAM: try wmic first, PowerShell as fallback ──────────────
    gpu_name  = None
    vram_gb   = None

    # Method 1: wmic (fast, but misreports AMD VRAM as 0 on some systems)
    try:
        result = subprocess.run(
            ["wmic", "path", "win32_videocontroller", "get", "Name,AdapterRAM", "/format:csv"],
            capture_output=True, text=True, timeout=5
        )
        lines = [l.strip() for l in result.stdout.splitlines()
                 if l.strip() and "Node" not in l]
        best_vram = 0.0
        best_name = None
        for line in lines:
            parts = line.split(",")
            if len(parts) >= 3:
                try:
                    vram_bytes = int(parts[1])
                    name       = parts[2].strip()
                    vb         = round(vram_bytes / (1024 ** 3), 1)
                    if vb > best_vram:
                        best_vram = vb
                        best_name = name
                except (ValueError, IndexError):
                    continue
        if best_name:
            gpu_name = best_name
            vram_gb  = best_vram if best_vram > 0 else None
    except Exception as e:
        log.warning(f"Hardware detect: wmic GPU failed: {e}")

    # Method 2: PowerShell fallback
    # Windows has a well-known bug where AMD AdapterRAM is reported as a garbage
    # low value (e.g. 4GB on a 16GB card) or 0. Run PowerShell regardless and
    # take the higher of the two readings.
    try:
        ps_cmd = (
            "Get-WmiObject Win32_VideoController | "
            "Select-Object Name, AdapterRAM | "
            "ConvertTo-Json"
        )
        result = subprocess.run(
            ["powershell", "-NonInteractive", "-Command", ps_cmd],
            capture_output=True, text=True, timeout=8
        )
        if result.returncode == 0 and result.stdout.strip():
            raw = result.stdout.strip()
            data = json.loads(raw)
            if isinstance(data, dict):
                data = [data]
            ps_best_vram = 0.0
            ps_best_name = None
            for entry in data:
                try:
                    vram_bytes = int(entry.get("AdapterRAM") or 0)
                    name       = (entry.get("Name") or "").strip()
                    vb         = round(vram_bytes / (1024 ** 3), 1)
                    if vb > ps_best_vram:
                        ps_best_vram = vb
                        ps_best_name = name
                except (ValueError, TypeError):
                    continue
            if ps_best_name and not gpu_name:
                gpu_name = ps_best_name
            # Take whichever is higher — PowerShell or wmic
            if ps_best_vram > (vram_gb or 0):
                vram_gb = ps_best_vram
    except Exception as e:
        log.warning(f"Hardware detect: PowerShell GPU fallback failed: {e}")

    # ── AMD/Radeon heuristic override ─────────────────────────────────────────
    # Windows consistently mis-reads VRAM on AMD RDNA cards (RX 5000/6000/7000).
    # It reports 4GB on a 16GB card, 2GB on an 8GB card, etc.
    # Strategy: for any known AMD card, look up the real spec and use
    # whichever value is HIGHER (spec vs what Windows reported).
    # This means if Windows somehow gets it right we still use that value.
    AMD_VRAM_SPECS = {
        # RX 7000 series
        "7900 xtx": 24, "7900xtx": 24,
        "7900 xt":  20, "7900xt":  20,
        "7800 xt":  16, "7800xt":  16,
        "7700 xt":  12, "7700xt":  12,
        "7600 xt":  16, "7600xt":  16,
        "7600":      8,
        # RX 6000 series
        "6950 xt":  16, "6950xt":  16,
        "6900 xt":  16, "6900xt":  16,
        "6800 xt":  16, "6800xt":  16,
        "6800":     16,
        "6750 xt":  12, "6750xt":  12,
        "6700 xt":  12, "6700xt":  12,
        "6700":     10,
        "6650 xt":   8, "6650xt":   8,
        "6600 xt":   8, "6600xt":   8,
        "6600":      8,
        "6500 xt":   4, "6500xt":   4,
        # RX 5000 series
        "5700 xt":   8, "5700xt":   8,
        "5700":      8,
        "5600 xt":   6, "5600xt":   6,
        "5500 xt":   8, "5500xt":   8,
        # Pro / Vega
        "vega 64":  16,
        "vega 56":   8,
    }

    if gpu_name:
        name_lc = gpu_name.lower()
        # Only apply to AMD/Radeon cards
        if any(k in name_lc for k in ("radeon", "amd", "rx ")):
            for hint, spec_gb in AMD_VRAM_SPECS.items():
                if hint in name_lc:
                    reported = vram_gb or 0
                    if spec_gb > reported:
                        log.info(
                            f"AMD VRAM override: '{gpu_name}' Windows reported "
                            f"{reported}GB, spec says {spec_gb}GB — using spec."
                        )
                        vram_gb = float(spec_gb)
                    else:
                        log.info(
                            f"AMD VRAM: '{gpu_name}' Windows reported {reported}GB, "
                            f"spec says {spec_gb}GB — Windows value looks correct."
                        )
                    break

    hw["gpu_name"] = gpu_name
    hw["vram_gb"]  = vram_gb

    _hw_cache = hw
    log.info(f"Hardware detected: {hw}")
    return hw


# ─── VRAM / MODEL CLASSIFICATION ─────────────────────────────────────────────

# Minimum VRAM required (GB) for 4-bit quantized models at comfortable operating headroom.
# For MoE models, use the download size (not active params) — Ollama loads all weights.
# Keys sorted longest-first inside _model_vram_estimate() to prevent "8b" matching "32b".
_VRAM_ESTIMATES = {
    "3.8b":  3.0,
    "e2b":   6.0,   # gemma4:e2b  — 7.2GB download
    "e4b":   8.0,   # gemma4:e4b  — 9.6GB download
    "3b":    2.0,
    "4b":    3.0,
    "7b":    5.0,
    "8b":    6.0,
    "13b":   9.0,
    "14b":   9.0,
    "26b":  16.0,   # gemma4:26b MoE — 18GB download
    "27b":  14.0,
    "30b":  16.0,   # qwen3:30b MoE — 19GB download
    "31b":  18.0,   # gemma4:31b dense — 20GB download
    "32b":  20.0,
    "34b":  20.0,
    "65b":  45.0,
    "70b":  45.0,
}

def _model_vram_estimate(model_name: str) -> float | None:
    m = model_name.lower()
    # Sort by DESCENDING KEY LENGTH so longer/more-specific keys match first.
    # This prevents "4b" matching "e4b" before "e4b" gets a chance,
    # and prevents "2b" matching "32b" etc.
    for key, gb in sorted(_VRAM_ESTIMATES.items(), key=lambda x: -len(x[0])):
        if key in m:
            return gb
    return None


def _classify_model(model_name: str, vram_gb: float | None) -> tuple[str, str]:
    """Return (recommendation, rec_note) for a model given detected VRAM."""
    needed = _model_vram_estimate(model_name)
    if vram_gb is None:
        if needed is None:
            return "COMPATIBLE", "Could not detect GPU. Model size unknown."
        return "COMPATIBLE", f"Could not detect GPU. Estimated ~{needed:.0f}GB VRAM needed."
    if needed is None:
        return "COMPATIBLE", f"Unknown model size. Your GPU has {vram_gb:.0f}GB VRAM."

    headroom = vram_gb - needed
    if headroom < 0:
        over = abs(headroom)
        return (
            "HEAVY",
            f"Needs ~{needed:.0f}GB VRAM — {over:.0f}GB over your {vram_gb:.0f}GB. Will run slowly or fail."
        )
    elif headroom < 2:
        return (
            "COMPATIBLE",
            f"Fits within your {vram_gb:.0f}GB VRAM with ~{headroom:.0f}GB to spare. Should run fine."
        )
    elif headroom >= 8:
        return (
            "LIGHT",
            f"Well under your {vram_gb:.0f}GB VRAM capacity. Consider a larger model for better quality."
        )
    else:
        return (
            "BEST FIT",
            f"Excellent match — uses ~{needed:.0f}GB of your {vram_gb:.0f}GB VRAM with good headroom."
        )


# ─── CURATED MODEL CATALOG ────────────────────────────────────────────────────

_CATALOG = [
    # ── TIER 1 — ULTRA LIGHT ──────────────────────────────────────────────────
    # Verified against ollama.com/library tags, April 2026.
    {
        "name":             "gemma4:e2b",
        # ollama.com/library/gemma4/tags: e2b = 7.2GB, 128K ctx, Text+Image
        "download_size_gb": 7.2,
        "vram_min_gb":      6,
        "context_window":   131072,
        "description":      "Google Gemma 4 E2B. MoE with 2.3B effective params. Multimodal, thinking mode, 128K context. Runs on almost anything.",
        "tier":             1,
        "is_reasoning":     True,
        "is_multimodal":    True,
    },
    {
        "name":             "qwen3:4b",
        # ollama.com/library/qwen3/tags: 4b = 2.5GB, 256K ctx
        "download_size_gb": 2.5,
        "vram_min_gb":      3,
        "context_window":   262144,
        "description":      "Alibaba Qwen 3 4B. Punches well above its size. 256K context, thinking mode built in.",
        "tier":             1,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "phi4-mini:3.8b",
        # phi4-mini confirmed in Ollama library, ~2.5GB
        "download_size_gb": 2.5,
        "vram_min_gb":      3,
        "context_window":   16384,
        "description":      "Microsoft Phi-4 Mini. Compact 3.8B with strong reasoning and multilingual support.",
        "tier":             1,
        "is_reasoning":     False,
        "is_multimodal":    False,
    },
    {
        "name":             "llama3.2:3b",
        # ollama.com/library/llama3.2: 3b = 2.0GB, 128K ctx
        "download_size_gb": 2.0,
        "vram_min_gb":      2,
        "context_window":   131072,
        "description":      "Meta Llama 3.2 3B. Tiny footprint, 128K context. Useful on CPU or very limited VRAM.",
        "tier":             1,
        "is_reasoning":     False,
        "is_multimodal":    False,
    },
    # ── TIER 2 — MID RANGE ───────────────────────────────────────────────────
    {
        "name":             "gemma4:e4b",
        # ollama.com/library/gemma4/tags: e4b = 9.6GB, 128K ctx, Text+Image (default tag)
        "download_size_gb": 9.6,
        "vram_min_gb":      8,
        "context_window":   131072,
        "description":      "Google Gemma 4 E4B. 4.5B effective params. Beats Gemma 3 27B on benchmarks. Multimodal, thinking mode, 128K context.",
        "tier":             2,
        "is_reasoning":     True,
        "is_multimodal":    True,
    },
    {
        "name":             "qwen3:8b",
        # ollama.com/library/qwen3/tags: 8b = 5.2GB, 40K ctx
        "download_size_gb": 5.2,
        "vram_min_gb":      6,
        "context_window":   40960,
        "description":      "Alibaba Qwen 3 8B. Strong all-rounder. Thinking mode, tool use, solid instruction following.",
        "tier":             2,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "deepseek-r1:8b",
        # deepseek-r1:8b confirmed in Ollama library, ~5.1GB
        "download_size_gb": 5.1,
        "vram_min_gb":      6,
        "context_window":   16384,
        "description":      "DeepSeek R1 8B. Chain-of-thought reasoning. More deliberate and accurate than standard 8B models.",
        "tier":             2,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "llama3.1:8b",
        # ollama.com/library/llama3.1: 8b = 4.7GB, 128K ctx
        "download_size_gb": 4.7,
        "vram_min_gb":      5,
        "context_window":   131072,
        "description":      "Meta Llama 3.1 8B. Huge 128K context window. Great for long journal history and insights.",
        "tier":             2,
        "is_reasoning":     False,
        "is_multimodal":    False,
    },
    # ── TIER 3 — HIGH END (14-16GB VRAM sweet spot) ──────────────────────────
    {
        "name":             "deepseek-r1:14b",
        # deepseek-r1:14b confirmed in Ollama library, ~9GB
        "download_size_gb": 9.0,
        "vram_min_gb":      9,
        "context_window":   16384,
        "description":      "DeepSeek R1 14B. Default Witness model. Reasoning-first, honest, direct. The benchmark for this app.",
        "tier":             3,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "qwen3:14b",
        # ollama.com/library/qwen3/tags: 14b = 9.3GB, 40K ctx
        "download_size_gb": 9.3,
        "vram_min_gb":      9,
        "context_window":   40960,
        "description":      "Alibaba Qwen 3 14B. Thinking mode, strong instruction following, tool use.",
        "tier":             3,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "phi4:14b",
        # phi4:14b confirmed in Ollama library, ~9GB
        "download_size_gb": 9.0,
        "vram_min_gb":      9,
        "context_window":   16384,
        "description":      "Microsoft Phi-4 14B. Exceptional reasoning and math. Clean, precise output with low hallucination rate.",
        "tier":             3,
        "is_reasoning":     False,
        "is_multimodal":    False,
    },
    {
        "name":             "gemma4:26b",
        # ollama.com/library/gemma4/tags: 26b = 18GB, 256K ctx, Text+Image
        "download_size_gb": 18.0,
        "vram_min_gb":      16,
        "context_window":   262144,
        "description":      "Google Gemma 4 26B MoE. 4B active params, 128 experts, 256K context. Near-frontier quality at mid-tier speed. Multimodal.",
        "tier":             3,
        "is_reasoning":     True,
        "is_multimodal":    True,
    },
    # ── TIER 4 — WORKSTATION (24GB+ VRAM) ────────────────────────────────────
    {
        "name":             "qwen3:30b",
        # ollama.com/library/qwen3/tags: 30b = 19GB, 256K ctx (MoE, 3B active)
        "download_size_gb": 19.0,
        "vram_min_gb":      16,
        "context_window":   262144,
        "description":      "Alibaba Qwen 3 30B MoE. 3B active params, 256K context. Outperforms QwQ-32B at a fraction of the compute cost.",
        "tier":             4,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "deepseek-r1:32b",
        # deepseek-r1:32b confirmed in Ollama library, ~20GB
        "download_size_gb": 20.0,
        "vram_min_gb":      20,
        "context_window":   16384,
        "description":      "DeepSeek R1 32B. Top-tier local reasoning. Needs 24GB+ VRAM.",
        "tier":             4,
        "is_reasoning":     True,
        "is_multimodal":    False,
    },
    {
        "name":             "gemma4:31b",
        # ollama.com/library/gemma4/tags: 31b = 20GB, 256K ctx, Text+Image (dense)
        "download_size_gb": 20.0,
        "vram_min_gb":      18,
        "context_window":   262144,
        "description":      "Google Gemma 4 31B dense. Best raw quality in the Gemma 4 family. 256K context, multimodal. Needs 20GB+ VRAM.",
        "tier":             4,
        "is_reasoning":     True,
        "is_multimodal":    True,
    },
]

# Quick lookup set for pull security check
_CATALOG_NAMES = {m["name"] for m in _CATALOG}


# ─── ENDPOINTS ───────────────────────────────────────────────────────────────

@router.get("/hardware")
def get_hardware():
    """Detect and return system hardware info."""
    return _detect_hardware()


@router.get("/models")
async def get_available_models():
    """Fetch the list of models currently installed in Ollama with rec badges."""
    hw      = _detect_hardware()
    vram_gb = hw.get("vram_gb")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get("http://localhost:11434/api/tags")
            if res.status_code != 200:
                return {"models": [], "error": "Ollama returned non-200 status"}
            data   = res.json()
            models = data.get("models", [])
            result = []
            for m in models:
                name = m.get("name", "")
                if not name:
                    continue
                rec, rec_note = _classify_model(name, vram_gb)
                result.append({
                    "name":           name,
                    "size":           _format_size(m.get("size")),
                    "recommendation": rec,
                    "rec_note":       rec_note,
                })
            return {"models": result}
    except httpx.ConnectError:
        log.warning("Could not connect to Ollama to fetch model list")
        return {"models": [], "error": "Ollama not reachable"}
    except Exception as e:
        log.error(f"Model list fetch failed: {e}")
        return {"models": [], "error": str(e)}


@router.get("/model-catalog")
async def get_model_catalog():
    """
    Return the curated model catalog, filtered to exclude already-installed models.
    Each entry gets a recommendation badge based on detected hardware.
    """
    hw      = _detect_hardware()
    vram_gb = hw.get("vram_gb")

    # Fetch what's already installed
    installed_names: set[str] = set()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get("http://localhost:11434/api/tags")
            if res.status_code == 200:
                data = res.json()
                for m in data.get("models", []):
                    n = m.get("name", "")
                    if n:
                        installed_names.add(n)
                        # Also add the base name without tag for flexible matching
                        installed_names.add(n.split(":")[0])
    except Exception as e:
        log.warning(f"Could not fetch installed models for catalog filter: {e}")

    result = []
    for model in _CATALOG:
        name = model["name"]
        # Skip if already installed (check exact name and base name)
        base = name.split(":")[0]
        if name in installed_names or base in installed_names:
            continue

        rec, rec_note = _classify_model(name, vram_gb)

        # Format context window nicely
        ctx = model["context_window"]
        if ctx >= 262144:
            ctx_label = "256K"
        elif ctx >= 131072:
            ctx_label = "128K"
        elif ctx >= 40960:
            ctx_label = "40K"
        elif ctx >= 32768:
            ctx_label = "32K"
        elif ctx >= 16384:
            ctx_label = "16K"
        elif ctx >= 8192:
            ctx_label = "8K"
        else:
            ctx_label = f"{ctx // 1024}K"

        result.append({
            "name":             name,
            "download_size_gb": model["download_size_gb"],
            "vram_min_gb":      model["vram_min_gb"],
            "context_window":   ctx,
            "context_label":    ctx_label,
            "description":      model["description"],
            "tier":             model["tier"],
            "is_reasoning":     model["is_reasoning"],
            "is_multimodal":    model["is_multimodal"],
            "recommendation":   rec,
            "rec_note":         rec_note,
        })

    return {
        "catalog":  result,
        "hardware": hw,
    }


@router.post("/pull-model")
async def pull_model(body: PullRequest):
    """
    Stream an Ollama model pull with live progress.
    Returns NDJSON lines forwarded directly from Ollama's pull API.
    Only allows models in the curated catalog (security check).
    """
    model = body.model.strip()

    # Security: only allow catalog models
    if model not in _CATALOG_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"Model '{model}' is not in the Witness catalog. Only catalog models can be pulled."
        )

    # Check Ollama is reachable
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            ping = await client.get("http://localhost:11434/api/tags")
            if ping.status_code != 200:
                raise HTTPException(status_code=503, detail="Ollama is not reachable.")
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Ollama is not reachable. Make sure it is running.")

    async def stream_pull():
        """Generator that proxies Ollama's NDJSON pull stream to the client."""
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    "http://localhost:11434/api/pull",
                    json={"name": model, "stream": True},
                ) as r:
                    async for line in r.aiter_lines():
                        if line.strip():
                            yield line + "\n"
        except Exception as e:
            # Send error as a JSON line so the frontend can display it
            err = json.dumps({"error": str(e), "status": "error"})
            yield err + "\n"

    return StreamingResponse(
        stream_pull(),
        media_type="application/x-ndjson",
    )


# ─── WIPE ENDPOINTS ──────────────────────────────────────────────────────────

@router.post("/wipe-entries")
def wipe_entries():
    conn = get_conn()
    try:
        tables = ["qa_pairs", "rant_topics", "metrics", "flags", "weekly_recaps", "entries"]
        for table in tables:
            conn.execute(f"DELETE FROM {table}")
        try:
            conn.execute("DELETE FROM rants WHERE 1=1")
        except Exception:
            pass
        conn.commit()
        log.warning("Journal entries wiped by user request.")
        return {"status": "ok", "wiped": tables}
    except Exception as e:
        log.error(f"Wipe entries failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


@router.post("/wipe-all")
def wipe_all():
    conn = get_conn()
    try:
        tables = ["qa_pairs", "rant_topics", "metrics", "flags", "weekly_recaps", "entries", "health_data"]
        for table in tables:
            conn.execute(f"DELETE FROM {table}")
        try:
            conn.execute("DELETE FROM rants WHERE 1=1")
        except Exception:
            pass
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
            "warmup_on_start":   "1",
        }
        for key, val in defaults.items():
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
                (key, val)
            )
        conn.commit()
        log.warning("FULL FACTORY RESET performed by user request.")
        return {"status": "ok"}
    except Exception as e:
        log.error(f"Wipe all failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


# ─── READ / WRITE SETTINGS ───────────────────────────────────────────────────
# Wildcard routes LAST — after all named routes above.

@router.get("/")
def get_all_settings():
    conn = get_conn()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        conn.close()


@router.get("/profile-preview")
def get_profile_preview():
    profile = get_setting("user_profile", "")
    return {
        "profile": profile,
        "length":  len(profile),
        "empty":   len(profile.strip()) == 0,
    }


@router.get("/{key}")
def get_one_setting(key: str):
    return {"key": key, "value": get_setting(key)}


@router.put("/{key}")
def update_setting(key: str, body: SettingUpdate):
    set_setting(key, body.value)
    log.info(f"Setting updated: {key} = {body.value[:80]}")
    if key == "model":
        try:
            from ollama_manager import invalidate_model_cache
            invalidate_model_cache()
        except Exception as e:
            log.warning(f"Could not invalidate model cache: {e}")
    return {"status": "ok", "key": key, "value": body.value}


# ─── HELPER ──────────────────────────────────────────────────────────────────

def _format_size(size_bytes: int) -> str:
    if size_bytes is None:
        return ""
    gb = size_bytes / (1024 ** 3)
    if gb >= 1:
        return f"{gb:.1f} GB"
    mb = size_bytes / (1024 ** 2)
    return f"{mb:.0f} MB"
