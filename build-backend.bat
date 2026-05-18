@echo off
:: ─────────────────────────────────────────────────────────────────────────────
:: build-backend.bat
:: Builds the Witness Python backend into a self-contained folder
:: that ships inside the Electron installer.
::
:: Save this file at:  witness/build-backend.bat
:: Run it once before running  npm run dist
:: ─────────────────────────────────────────────────────────────────────────────

echo.
echo ============================================================
echo  WITNESS — Building Python backend bundle
echo ============================================================
echo.

:: Move into the python-backend folder
cd /d "%~dp0python-backend"

echo [1/3] Detecting Python (3.10 or later required)...

:: Try Python versions from newest to oldest via the py launcher.
:: This avoids hardcoding a version and works regardless of what the
:: user has installed, as long as it is 3.10 or higher.
set PY_CMD=
for %%V in (3.13 3.12 3.11 3.10) do (
    if not defined PY_CMD (
        py -%%V --version >nul 2>&1
        if not errorlevel 1 (
            set PY_CMD=py -%%V
            echo Found Python %%V via py launcher.
        )
    )
)

:: Fall back to bare 'python' / 'python3' if py launcher had nothing
if not defined PY_CMD (
    python3 --version >nul 2>&1
    if not errorlevel 1 (
        set PY_CMD=python3
        echo Found Python via python3.
    )
)
if not defined PY_CMD (
    python --version >nul 2>&1
    if not errorlevel 1 (
        set PY_CMD=python
        echo Found Python via python.
    )
)

if not defined PY_CMD (
    echo ERROR: No Python 3.10+ found. Install Python 3.10 or later from python.org
    echo        and make sure it is on your PATH or accessible via the py launcher.
    pause
    exit /b 1
)

echo Using: %PY_CMD%
echo.

echo [2/3] Installing PyInstaller...
%PY_CMD% -m pip install pyinstaller --quiet
if %errorlevel% neq 0 (
    echo ERROR: pip install failed. Make sure Python is installed and on PATH.
    pause
    exit /b 1
)

echo [3/3] Cleaning previous build and running PyInstaller...
echo       This takes 3-8 minutes. Normal output will scroll past.
echo.
%PY_CMD% -m PyInstaller witness-backend.spec --clean --noconfirm
if %errorlevel% neq 0 (
    echo.
    echo ERROR: PyInstaller failed. See the error above for details.
    echo Common fix: make sure all packages in requirements.txt are installed.
    echo Run:  pip install -r requirements.txt
    pause
    exit /b 1
)

echo.
echo Checking output...
if exist "dist\witness-backend\witness-backend.exe" (
    echo.
    echo ============================================================
    echo  SUCCESS! Bundle created at:
    echo  python-backend\dist\witness-backend\
    echo.
    echo  Next step: run  npm run dist  in the witness\ folder
    echo  to build the full Windows installer.
    echo ============================================================
) else (
    echo.
    echo WARNING: Expected file not found. Check for errors above.
)

echo.
pause
