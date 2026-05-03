#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-backend.sh
# Builds the Witness Python backend into a self-contained folder
# that ships inside the Linux AppImage or .deb installer.
#
# Save this file at:  witness/build-backend.sh
# Make it executable: chmod +x build-backend.sh
# Run it once before running:  npm run dist:linux
#
# Requirements before running:
#   sudo apt install portaudio19-dev python3.12 python3.12-venv
#   pip install -r python-backend/requirements.txt fpdf2
# ─────────────────────────────────────────────────────────────────────────────

set -e  # Exit immediately if any command fails

# Move to the directory this script lives in (the witness/ root)
cd "$(dirname "$0")"

echo ""
echo "============================================================"
echo " WITNESS — Building Python backend bundle (Linux)"
echo "============================================================"
echo ""

# Move into the python-backend folder
cd python-backend

echo "[1/3] Installing PyInstaller..."
python3 -m pip install pyinstaller --quiet
if [ $? -ne 0 ]; then
    echo "ERROR: pip install failed. Make sure Python 3.11+ is installed."
    exit 1
fi

echo ""
echo "[2/3] Cleaning previous build and running PyInstaller..."
echo "      This takes 3-8 minutes. Normal output will scroll past."
echo ""

python3 -m PyInstaller witness-backend.spec --clean --noconfirm
if [ $? -ne 0 ]; then
    echo ""
    echo "ERROR: PyInstaller failed. See the error above for details."
    echo "Common fix: make sure all packages in requirements.txt are installed."
    echo "Run:  pip install -r requirements.txt"
    exit 1
fi

echo ""
echo "[3/3] Checking output..."

BACKEND_PATH="dist/witness-backend/witness-backend"

if [ -f "$BACKEND_PATH" ]; then
    # Make sure the binary is executable
    chmod +x "$BACKEND_PATH"
    echo ""
    echo "============================================================"
    echo " SUCCESS! Bundle created at:"
    echo " python-backend/dist/witness-backend/"
    echo ""
    echo " Next step: run  npm run dist:linux  in the witness/ folder"
    echo " to build the AppImage and .deb installer."
    echo "============================================================"
else
    echo ""
    echo "WARNING: Expected file not found at $BACKEND_PATH"
    echo "Check for errors above."
    exit 1
fi

echo ""
