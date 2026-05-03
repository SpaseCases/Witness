/**
 * WITNESS — Electron Main Process
 *
 * Cross-platform: works on Windows and Linux (Mac feasible, untested).
 * Platform differences are handled inline with process.platform checks —
 * there is no separate file for each OS.
 *
 * Windows-specific things:
 *   - Ollama kill: taskkill /F /IM ollama.exe /T
 *   - Ollama path: AppData\Local\Programs\Ollama\ollama.exe
 *   - Packaged backend: witness-backend.exe
 *   - Spawn flag: CREATE_NO_WINDOW (suppresses console popups)
 *
 * Linux-specific things:
 *   - Ollama kill: pkill -f ollama
 *   - Ollama path: /usr/local/bin/ollama or /usr/bin/ollama
 *   - Packaged backend: witness-backend (no extension)
 *   - No CREATE_NO_WINDOW flag needed
 *
 * Save this file at: witness/electron/main.js
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  shell,
  Menu,
  Tray,
  dialog
} = require('electron')
const path            = require('path')
const { spawn, exec } = require('child_process')
const fs              = require('fs')

const IS_WINDOWS = process.platform === 'win32'
const IS_LINUX   = process.platform === 'linux'

// Force Hunspell on Windows. Without this, Electron uses the Windows system
// spellchecker which underlines misspellings but returns undefined for
// dictionaryWord in the context-menu event, so suggestions never appear.
// This switch must be set before any window is created.
if (IS_WINDOWS) {
  app.commandLine.appendSwitch('--disable-features', 'WinUseBrowserSpellChecker')
}

let mainWindow
let pythonProcess
let notificationTimer = null
let _ollamaWasPreexisting = false   // true if Ollama was already running before we launched

// ─── OLLAMA SHUTDOWN ─────────────────────────────────────────────────────────

function killOllama() {
  return new Promise((resolve) => {
    // Only kill Ollama if Witness was the one that started it.
    // If the user had Ollama running before opening Witness (for other apps),
    // we leave it running when we close.
    if (_ollamaWasPreexisting) {
      console.log('[OLLAMA] Was pre-existing — leaving it running.')
      return resolve()
    }

    // Windows: taskkill terminates ollama.exe and all child processes
    // Linux:   pkill sends SIGTERM to any process whose command matches "ollama"
    const command = IS_WINDOWS
      ? 'taskkill /F /IM ollama.exe /T'
      : 'pkill -f ollama'

    exec(command, (err) => {
      if (err) {
        console.log('[OLLAMA] Kill attempted (may not have been running)')
      } else {
        console.log('[OLLAMA] Process terminated.')
      }
      resolve()
    })
  })
}

// ─── OLLAMA PATH DETECTION ────────────────────────────────────────────────────
// Node.js has full access to the system PATH even when the app is packaged.
// We locate ollama here and pass it to Python via OLLAMA_PATH env var so
// the bundled Python process does not have to find it blind.

function _findOllamaPath() {
  const { execSync } = require('child_process')

  if (IS_WINDOWS) {
    const username     = process.env.USERNAME || ''
    const localAppData = process.env.LOCALAPPDATA || ''

    const candidates = [
      localAppData ? path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe') : null,
      username     ? `C:\\Users\\${username}\\AppData\\Local\\Programs\\Ollama\\ollama.exe` : null,
      'C:\\Program Files\\Ollama\\ollama.exe',
      'C:\\Program Files (x86)\\Ollama\\ollama.exe',
    ].filter(Boolean)

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        console.log(`[OLLAMA] Found at: ${p}`)
        return p
      }
    }

    // Fall back to where (Windows PATH lookup)
    try {
      const result = execSync('where ollama', { timeout: 3000 })
        .toString().trim().split('\n')[0].trim()
      if (result && fs.existsSync(result)) {
        console.log(`[OLLAMA] Found in PATH: ${result}`)
        return result
      }
    } catch {
      // not in PATH
    }

  } else {
    // Linux (and Mac) — Ollama installs to /usr/local/bin by default
    const candidates = [
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      `${process.env.HOME || ''}/.local/bin/ollama`,
    ]

    for (const p of candidates) {
      if (fs.existsSync(p)) {
        console.log(`[OLLAMA] Found at: ${p}`)
        return p
      }
    }

    // Fall back to which (Linux/Mac PATH lookup)
    try {
      const result = execSync('which ollama', { timeout: 3000 }).toString().trim()
      if (result && fs.existsSync(result)) {
        console.log(`[OLLAMA] Found in PATH: ${result}`)
        return result
      }
    } catch {
      // not in PATH
    }
  }

  console.warn('[OLLAMA] Could not locate ollama executable. Auto-start may fail.')
  return 'ollama' // bare command — last resort, relies on PATH at runtime
}

// ─── PYTHON DETECTION (dev mode only) ────────────────────────────────────────

function testPythonCommand(cmd, args) {
  return new Promise((resolve) => {
    exec(`${cmd} ${args.join(' ')}`, { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) { resolve(null); return }
      const out   = (stdout + stderr).trim()
      const match = out.match(/Python 3\.(\d+)/)
      if (match && parseInt(match[1]) >= 11) {
        resolve(cmd)
      } else {
        resolve(null)
      }
    })
  })
}

async function findPython() {
  // On Windows, 'py' launcher lets you pick the exact version.
  // On Linux, python3 is the standard command; 'py' rarely exists.
  const candidates = IS_WINDOWS
    ? [
        { cmd: 'py',      args: ['-3.13', '--version'] },
        { cmd: 'py',      args: ['-3.12', '--version'] },
        { cmd: 'py',      args: ['-3.11', '--version'] },
        { cmd: 'python3', args: ['--version'] },
        { cmd: 'python',  args: ['--version'] },
      ]
    : [
        { cmd: 'python3.12', args: ['--version'] },
        { cmd: 'python3.11', args: ['--version'] },
        { cmd: 'python3',    args: ['--version'] },
        { cmd: 'python',     args: ['--version'] },
      ]

  for (const { cmd, args } of candidates) {
    const result = await testPythonCommand(cmd, args)
    if (result) {
      if (cmd === 'py') {
        const versionFlag = args[0]
        console.log(`[PYTHON] Found Python via: py ${versionFlag}`)
        return { cmd: 'py', extraArgs: [versionFlag] }
      } else {
        console.log(`[PYTHON] Found Python via: ${cmd}`)
        return { cmd, extraArgs: [] }
      }
    }
  }

  return null
}

// ─── USER DATA PATHS ─────────────────────────────────────────────────────────
// app.getPath('userData') returns the correct platform path automatically:
//   Windows: C:\Users\<name>\AppData\Roaming\Witness
//   Linux:   ~/.config/Witness
//   Mac:     ~/Library/Application Support/Witness
// No hardcoded paths needed — Electron handles it.

function getUserDataPaths() {
  const userData    = app.getPath('userData')
  const healthInbox = path.join(userData, 'health-inbox')

  if (!fs.existsSync(healthInbox)) {
    fs.mkdirSync(healthInbox, { recursive: true })
  }

  return { userData, healthInbox }
}

// ─── PYTHON BACKEND ──────────────────────────────────────────────────────────

async function startPythonBackend() {
  const { userData, healthInbox } = getUserDataPaths()
  const ollamaPath = _findOllamaPath()

  const pythonEnv = {
    ...process.env,
    WITNESS_USER_DATA:    userData,
    WITNESS_HEALTH_INBOX: healthInbox,
    OLLAMA_PATH:          ollamaPath,
  }

  // ── PACKAGED MODE ─────────────────────────────────────────────────────────
  if (app.isPackaged) {
    // The backend executable name differs by OS
    const backendExe = IS_WINDOWS ? 'witness-backend.exe' : 'witness-backend'
    const exePath    = path.join(process.resourcesPath, 'witness-backend', backendExe)

    console.log(`[PYTHON] Packaged mode — launching: ${exePath}`)
    console.log(`[PYTHON] User data dir: ${userData}`)

    if (!fs.existsSync(exePath)) {
      console.error(`[PYTHON] FATAL: Backend executable not found at ${exePath}`)
      console.error('[PYTHON] The installer may be corrupt. Please reinstall Witness.')
      return
    }

    pythonProcess = spawn(exePath, [], {
      stdio: 'pipe',
      cwd:   path.join(process.resourcesPath, 'witness-backend'),
      env:   pythonEnv
    })

    attachPythonListeners()
    return
  }

  // ── DEVELOPMENT MODE ──────────────────────────────────────────────────────
  const scriptPath = path.join(__dirname, '../python-backend/main.py')
  const python     = await findPython()

  if (!python) {
    console.error('[PYTHON] No compatible Python installation found (need 3.11+)')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python-not-found')
    } else {
      app.once('browser-window-created', () => {
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('python-not-found')
          }
        }, 1000)
      })
    }
    return
  }

  const launchArgs = [...python.extraArgs, '-O', scriptPath]

  console.log(`[PYTHON] Launching: ${python.cmd} ${launchArgs.join(' ')}`)
  console.log(`[PYTHON] User data dir: ${userData}`)

  // On Linux, no special spawn flags are needed.
  // On Windows, we avoid CREATE_NO_WINDOW here because dev mode wants console output.
  pythonProcess = spawn(python.cmd, launchArgs, {
    stdio: 'pipe',
    cwd:   path.join(__dirname, '../python-backend'),
    env:   pythonEnv
  })

  attachPythonListeners()
}

function attachPythonListeners() {
  if (!pythonProcess) return

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[PYTHON] ${data.toString().trim()}`)
  })

  pythonProcess.stderr.on('data', (data) => {
    console.log(`[PYTHON] ${data.toString().trim()}`)
  })

  pythonProcess.on('close', (code) => {
    console.log(`[PYTHON] Process exited with code ${code}`)
  })

  pythonProcess.on('error', (err) => {
    console.error(`[PYTHON] Failed to start: ${err.message}`)
  })
}

function killPythonBackend() {
  if (pythonProcess) {
    pythonProcess.kill('SIGTERM')
    setTimeout(() => {
      try { pythonProcess?.kill('SIGKILL') } catch {}
    }, 2000)
    pythonProcess = null
  }
}

// ─── FULL SHUTDOWN ────────────────────────────────────────────────────────────

async function fullShutdown() {
  console.log('[WITNESS] Shutting down...')
  clearNotificationTimer()
  killPythonBackend()
  await killOllama()
  console.log('[WITNESS] Shutdown complete.')
}

// ─── MAIN WINDOW ─────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1400,
    height:          900,
    minWidth:        1100,
    minHeight:       700,
    frame:           false,
    backgroundColor: '#111111',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
      spellcheck:       true
    },
    show: false
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.focus()
    scheduleNotificationCheck()

    // Spellchecker setup.
    // On Windows 11, Electron defaults to the Windows system spellchecker which
    // detects errors (red underlines) but returns undefined for dictionaryWord,
    // so suggestions never appear. Forcing Hunspell by disabling the OS checker
    // makes Electron use its own bundled dictionary instead.
    const ses = mainWindow.webContents.session
    ses.setSpellCheckerEnabled(true)
    // This is the key line: disabling the Windows system spellchecker forces
    // Electron to fall back to its bundled Hunspell engine, which does return
    // suggestions correctly via the context-menu dictionaryWord param.
    if (process.platform === 'win32') {
      ses.setSpellCheckerLanguages(['en-US'])
    }
    console.log('[WITNESS] Spellchecker languages:', ses.getSpellCheckerLanguages())
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // ─── SPELLCHECK CONTEXT MENU ─────────────────────────────────────────────
  // Electron strips the browser native right-click menu. This restores
  // spelling corrections, clipboard actions, and selection copy for all
  // text fields across the app.
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menuItems = []

    // Spelling corrections -- shown first when a word is underlined red
    // NOTE: The correct field is params.dictionarySuggestions (not dictionaryWord).
    // Electron docs confirm this. dictionaryWord is undefined on all platforms.
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions || []
      suggestions.slice(0, 4).forEach(suggestion => {
        menuItems.push({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion)
        })
      })
      if (suggestions.length > 0) {
        menuItems.push({ type: 'separator' })
      }
      menuItems.push({
        label: 'Add to Dictionary',
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
      menuItems.push({ type: 'separator' })
    }

    // Clipboard actions -- shown in any editable text field
    if (params.isEditable) {
      menuItems.push(
        { label: 'Cut',        role: 'cut',       enabled: params.selectionText.length > 0 },
        { label: 'Copy',       role: 'copy',      enabled: params.selectionText.length > 0 },
        { label: 'Paste',      role: 'paste' },
        { label: 'Select All', role: 'selectAll' }
      )
    } else if (params.selectionText.trim()) {
      // Read-only text with a selection -- allow copy only
      menuItems.push({ label: 'Copy', role: 'copy' })
    }

    if (menuItems.length > 0) {
      Menu.buildFromTemplate(menuItems).popup({ window: mainWindow })
    }
  })
}

// ─── WINDOW CONTROLS ─────────────────────────────────────────────────────────

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  }
})

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close()
})

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url)
})

// ─── SAVE FILE (Export screen) ────────────────────────────────────────────────
// Called by Export.jsx via window.witness.saveFile()
// Opens a native Save dialog and writes the exported bytes to disk.
// Works identically on Windows and Linux — dialog.showSaveDialog is cross-platform.

ipcMain.handle('save-file', async (event, { defaultName, filters, buffer }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title:       'Save Witness Export',
    defaultPath: defaultName,
    filters:     filters,
    properties:  ['createDirectory', 'showOverwriteConfirmation'],
  })

  if (canceled || !filePath) return 'cancelled'

  fs.writeFileSync(filePath, Buffer.from(buffer))
  return 'saved'
})

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

let lastNotifiedDate = null

function clearNotificationTimer() {
  if (notificationTimer) {
    clearInterval(notificationTimer)
    notificationTimer = null
  }
}

async function fetchNotificationSettings() {
  try {
    const http = require('http')
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:8000/settings/', (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const s = JSON.parse(data)
            resolve({
              enabled: s.notify_enabled !== '0',
              time:    s.notify_time || '20:00'
            })
          } catch {
            resolve({ enabled: false, time: '20:00' })
          }
        })
      })
      req.on('error', () => resolve({ enabled: false, time: '20:00' }))
      req.setTimeout(3000, () => { req.destroy(); resolve({ enabled: false, time: '20:00' }) })
    })
  } catch {
    return { enabled: false, time: '20:00' }
  }
}

function scheduleNotificationCheck() {
  clearNotificationTimer()
  notificationTimer = setInterval(async () => {
    const { enabled, time } = await fetchNotificationSettings()
    if (!enabled) return

    const now       = new Date()
    const todayStr  = now.toISOString().split('T')[0]
    const [hh, mm]  = time.split(':').map(Number)
    const isRightTime = now.getHours() === hh && now.getMinutes() === mm
    const notYetSent  = lastNotifiedDate !== todayStr

    if (isRightTime && notYetSent) {
      lastNotifiedDate = todayStr
      showReminderNotification()
    }
  }, 60_000)
}

function showReminderNotification() {
  if (!Notification.isSupported()) return

  const n = new Notification({
    title:  'WITNESS',
    body:   "Time to record today's entry.",
    silent: false,
  })

  n.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      mainWindow.webContents.send('navigate-to', 'journal')
    }
  })

  n.show()
  console.log('[NOTIFY] Daily reminder sent.')
}

ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show()
  }
})

// ─── BACKEND READY SIGNAL ─────────────────────────────────────────────────────

function pollBackendReady() {
  const http = require('http')
  let attempts          = 0
  let backendReadyFired = false
  const MAX_ATTEMPTS    = 90   // 90 × 500ms = 45 seconds

  const fireReady = () => {
    if (backendReadyFired) return
    backendReadyFired = true
    console.log('[WITNESS] Backend ready — notifying renderer.')
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-ready')
    }
  }

  const check = () => {
    const req = http.get('http://127.0.0.1:8000/', (res) => {
      if (res.statusCode === 200) { fireReady(); return }
      res.resume()
      retry()
    })
    req.on('error', retry)
    req.setTimeout(800, () => { req.destroy(); retry() })
  }

  const retry = () => {
    if (backendReadyFired) return
    attempts++
    if (attempts < MAX_ATTEMPTS) {
      setTimeout(check, 500)
    } else {
      console.log('[WITNESS] Backend poll timed out — showing app anyway.')
      fireReady()
    }
  }

  setTimeout(check, 500)
}

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────

let _shutdownCalled = false

async function safeShutdown() {
  if (_shutdownCalled) return
  _shutdownCalled = true
  await fullShutdown()
}

app.whenReady().then(async () => {
  // Check if Ollama was already running before we touch anything.
  // If yes, we'll leave it alone on shutdown.
  await new Promise((resolve) => {
    const http = require('http')
    const req  = http.get('http://127.0.0.1:11434/api/tags', (res) => {
      if (res.statusCode === 200) {
        _ollamaWasPreexisting = true
        console.log('[OLLAMA] Pre-existing Ollama detected — will not kill on exit.')
      }
      res.resume()
      resolve()
    })
    req.on('error', resolve)
    req.setTimeout(1500, () => { req.destroy(); resolve() })
  })

  await startPythonBackend()
  createWindow()
  pollBackendReady()
})

app.on('window-all-closed', async () => {
  await safeShutdown()
  app.quit()
})

app.on('before-quit', async (e) => {
  if (!_shutdownCalled) {
    e.preventDefault()
    await safeShutdown()
    app.exit(0)
  }
})

app.on('will-quit', () => {
  clearNotificationTimer()
})
