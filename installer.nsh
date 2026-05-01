; installer.nsh
; ─────────────────────────────────────────────────────────────────────────────
; Custom NSIS script injected into the Witness installer by electron-builder.
; Runs AFTER Witness files are copied but BEFORE the installer finishes.
;
; What this does:
;   1. Checks if Ollama is already installed (looks for ollama.exe in AppData)
;   2. If not found, downloads the official Ollama installer from ollama.com
;   3. Runs the Ollama installer silently (no extra windows, no extra clicks)
;   4. Cleans up the downloaded file
;
; The user sees a single progress page: "Installing Ollama (AI engine)..."
; ─────────────────────────────────────────────────────────────────────────────

!macro customInstall

  ; ── Check if Ollama is already installed ───────────────────────────────────
  ; Ollama installs to: %LOCALAPPDATA%\Programs\Ollama\ollama.exe
  ; If that file exists, skip the download entirely.

  DetailPrint "Checking for Ollama..."

  ReadEnvStr $0 LOCALAPPDATA
  StrCpy $1 "$0\Programs\Ollama\ollama.exe"

  IfFileExists $1 OllamaAlreadyInstalled OllamaNotFound

  OllamaAlreadyInstalled:
    DetailPrint "Ollama is already installed. Skipping."
    Goto OllamaDone

  OllamaNotFound:
    DetailPrint "Ollama not found. Downloading..."

    ; ── Download Ollama installer ─────────────────────────────────────────────
    ; This is the official Ollama Windows installer from ollama.com.
    ; It is a ~70MB self-contained installer that installs silently with /S flag.

    NSISdl::download \
      "https://ollama.com/download/OllamaSetup.exe" \
      "$TEMP\OllamaSetup.exe"

    Pop $R0  ; NSISdl sets a result string: "success" or an error message

    StrCmp $R0 "success" OllamaDownloadOK OllamaDownloadFailed

    OllamaDownloadFailed:
      ; Don't block the install — Witness still installs fine without Ollama.
      ; The user will see the in-app prompt to install it.
      DetailPrint "Ollama download failed: $R0"
      DetailPrint "You can install Ollama later from https://ollama.com/download"
      MessageBox MB_OK|MB_ICONINFORMATION \
        "Could not download Ollama automatically.$\n$\nThis is usually caused by a firewall or no internet connection.$\n$\nWitness will still install. You can download Ollama manually from:$\nhttps://ollama.com/download$\n$\nWitness will guide you when it launches." \
        /SD IDOK
      Goto OllamaDone

    OllamaDownloadOK:
      DetailPrint "Ollama downloaded. Installing silently..."

      ; /S = silent install, no UI windows
      ExecWait '"$TEMP\OllamaSetup.exe" /S' $2

      ; Check the exit code — 0 means success
      IntCmp $2 0 OllamaInstallOK OllamaInstallFailed OllamaInstallFailed

      OllamaInstallFailed:
        DetailPrint "Ollama installer exited with code $2"
        DetailPrint "You may need to install Ollama manually from https://ollama.com/download"
        Goto OllamaCleanup

      OllamaInstallOK:
        DetailPrint "Ollama installed successfully."

      OllamaCleanup:
        ; Remove the downloaded installer file
        Delete "$TEMP\OllamaSetup.exe"

  OllamaDone:

    ; ── Remind user to pull the model ──────────────────────────────────────────
    ; Even if Ollama is installed, the model still needs to be pulled.
    ; Check if the model folder exists as a proxy for whether it was pulled.

    ReadEnvStr $3 USERPROFILE
    StrCpy $4 "$3\.ollama\models\manifests\registry.ollama.ai\library\gemma4"

    IfFileExists "$4\*.*" ModelAlreadyPulled ModelNotPulled

    ModelNotPulled:
      MessageBox MB_OK|MB_ICONINFORMATION \
        "Ollama is ready.$\n$\nOpen Witness and go to CONFIG to choose your AI model.$\n$\nRECOMMENDED MODELS:$\n$\n  gemma4:3b       -- 3GB, works on most computers (recommended)$\n  llama3.2:3b     -- 2GB, very fast, good for older hardware$\n  deepseek-r1:14b -- 9GB, best quality (needs 16GB+ RAM)$\n$\nWitness will download your chosen model from the CONFIG screen." \
        /SD IDOK
      Goto ModelDone

    ModelAlreadyPulled:
      DetailPrint "AI model already present. No download needed."

    ModelDone:

!macroend


!macro customUnInstall
  ; Nothing extra needed on uninstall.
  ; Ollama is left installed — it belongs to the user, not to Witness.
  ; witness.db is left in AppData per deleteAppDataOnUninstall: false
!macroend
