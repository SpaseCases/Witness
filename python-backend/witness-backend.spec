# witness-backend.spec
# ─────────────────────────────────────────────────────────────────────────────
# PyInstaller spec file for the Witness Python backend.
# This tells PyInstaller exactly how to bundle everything into a
# self-contained folder that ships inside the Electron installer.
#
# Save this file at:  witness/python-backend/witness-backend.spec
# ─────────────────────────────────────────────────────────────────────────────

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# ── Collect data files that live alongside the Python code ───────────────────
# These are non-.py files that packages need at runtime.

datas = []

# faster-whisper ships its own tokenizer assets and model config helpers
datas += collect_data_files('faster_whisper')

# chromadb ships migration SQL files, ONNX runtime assets, etc.
datas += collect_data_files('chromadb')

# huggingface tokenizers (used by chromadb's embedding function)
datas += collect_data_files('tokenizers')

# ONNX runtime (chromadb's default embedding model runs on it)
datas += collect_data_files('onnxruntime')

# Include the routes/ folder as source so imports resolve correctly
datas += [('routes', 'routes')]

# ── Hidden imports ────────────────────────────────────────────────────────────
# Packages that are imported dynamically (not visible to PyInstaller's scanner)

hiddenimports = [
    # FastAPI / Uvicorn internals
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'uvicorn.middleware',
    'uvicorn.middleware.proxy_headers',

    # FastAPI encoders / responses
    'fastapi.responses',
    'fastapi.staticfiles',
    'fastapi.templating',
    'starlette.routing',
    'starlette.middleware',
    'starlette.middleware.cors',

    # Pydantic v2 internals
    'pydantic',
    'pydantic.deprecated.config',
    'pydantic_core',

    # Faster-Whisper / CTranslate2
    'faster_whisper',
    'ctranslate2',
    'tokenizers',

    # ChromaDB + its dependencies
    'chromadb',
    'chromadb.api',
    'chromadb.api.client',
    'chromadb.config',
    'chromadb.db',
    'chromadb.segment',
    'chromadb.segment.impl',
    'chromadb.segment.impl.manager',
    'chromadb.segment.impl.manager.local',
    'chromadb.telemetry',
    'chromadb.telemetry.product',
    'chromadb.telemetry.product.posthog',
    'chromadb.utils',
    'chromadb.utils.embedding_functions',
    'onnxruntime',

    # NumPy / SciPy (Whisper and ChromaDB both need them)
    'numpy',
    'numpy.core._multiarray_umath',

    # SQLite (built into Python, but explicit is safer)
    'sqlite3',
    '_sqlite3',

    # httpx (used by ollama_manager)
    'httpx',
    'httpx._transports',
    'httpx._transports.default',

    # soundfile (audio I/O for Whisper)
    'soundfile',
    'soundfile._soundfile',

    # python-multipart (FastAPI file uploads)
    'multipart',

    # Standard library modules that sometimes get missed
    'asyncio',
    'email.mime.multipart',
    'email.mime.text',
    'logging.handlers',

    # Our own route modules
    'routes.entries',
    'routes.transcribe',
    'routes.rant',
    'routes.insights',
    'routes.health',
    'routes.settings',
    'routes.recap',
    'routes.todos',
]

# ── Analysis ──────────────────────────────────────────────────────────────────

a = Analysis(
    ['main.py'],                        # Entry point
    pathex=[str(Path('.').resolve())],  # Add the python-backend dir to sys.path
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Things we definitely don't need — keeping the bundle lean
        'tkinter',
        'matplotlib',
        'PIL',
        'PyQt5',
        'wx',
        'IPython',
        'jupyter',
        'notebook',
        'pytest',
        'test',
        'tests',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ── EXE ───────────────────────────────────────────────────────────────────────
# console=True keeps the terminal output visible when launched by Electron.
# This is intentional — Electron reads stdout/stderr for logging.

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,              # Folder mode (not single .exe)
    name='witness-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                          # UPX can break ctypes-heavy packages
    console=True,                       # Keep stdout visible for Electron
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# ── COLLECT ───────────────────────────────────────────────────────────────────
# Folder mode: all DLLs, .pyd files, and data land in one folder.
# This is more reliable than single-file mode for Whisper + ChromaDB.

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='witness-backend',             # Output: dist/witness-backend/
)
