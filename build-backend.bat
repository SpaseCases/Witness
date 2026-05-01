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

echo [1/3] Installing PyInstaller...
py -3.11 -m pip install pyinstaller --quiet
if %errorlevel% neq 0 (
    echo ERROR: pip install failed. Make sure Python is installed and on PATH.
    pause
    exit /b 1
)

echo [2/3] Cleaning previous build and running PyInstaller...
echo       This takes 3-8 minutes. Normal output will scroll past.
echo.
py -3.11 -m PyInstaller witness-backend.spec --clean --noconfirm
if %errorlevel% neq 0 (
    echo.
    echo ERROR: PyInstaller failed. See the error above for details.
    echo Common fix: make sure all packages in requirements.txt are installed.
    echo Run:  pip install -r requirements.txt
    pause
    exit /b 1
)

echo.
echo [3/3] Checking output...
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
