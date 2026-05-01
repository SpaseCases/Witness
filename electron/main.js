/**
 * WITNESS — Electron Main Process
 * Step 17 changes:
 *   - In packaged mode: launches the PyInstaller .exe from resources folder
 *   - In dev mode: uses the existing Python detection logic (unchanged)
 *   - Passes WITNESS_USER_DATA env var to the Python backend so it knows
 *     where to store witness.db (AppData\Roaming\Witness on the user's PC)
 *     Journal data survives app reinstalls this way.
 *   - Passes WITNESS_HEALTH_INBOX env var so health data files land in
 *     a consistent location regardless of where the app is installed.
 *
 * Save this file at:  witness/electron/main.js
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  shell,
  Menu,
  Tray
} = require('electron')
const path            = require('path')
const { spawn, exec } = require('child_process')
const fs              = require('fs')

let mainWindow
let pythonProcess
let notificationTimer = null

// ─── OLLAMA SHUTDOWN ─────────────────────────────────────────────────────────

function killOllama() {
  return new Promise((resolve) => {
    exec('taskkill /F /IM ollama.exe /T', (err) => {
      if (err) {
        console.log('[OLLAMA] Kill attempted (may not have been running)')
      } else {
        console.log('[OLLAMA] Process terminated.')
      }
      resolve()
    })
  })
}

// ─── PYTHON DETECTION ────────────────────────────────────────────────────────


// ─── OLLAMA PATH DETECTION ────────────────────────────────────────────────────
// Node.js (unlike PyInstaller's bundled Python) has full access to the system
// PATH. We locate ollama.exe here and pass it to Python via an env var so the
// bundled Python process doesn't have to find it blind.

function _findOllamaPath() {
  const { execSync } = require('child_process')
  const username     = process.env.USERNAME || ''
  const localAppData = process.env.LOCALAPPDATA || ''

  // Check common Windows install locations first
  const candidates = [
    localAppData ? path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe') : null,
    username     ? `C:\Users\${username}\AppData\Local\Programs\Ollama\ollama.exe` : null,
    'C:\Program Files\Ollama\ollama.exe',
    'C:\Program Files (x86)\Ollama\ollama.exe',
  ].filter(Boolean)

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[OLLAMA] Found at: ${p}`)
      return p
    }
  }

  // Fall back to PATH lookup via where (Windows equivalent of which)
  try {
    const result = execSync('where ollama', { timeout: 3000 }).toString().trim().split('\n')[0].trim()
    if (result && fs.existsSync(result)) {
      console.log(`[OLLAMA] Found in PATH: ${result}`)
      return result
    }
  } catch {
    // where failed -- Ollama not in PATH
  }

  console.warn('[OLLAMA] Could not locate ollama.exe. Auto-start may fail.')
  return 'ollama' // bare command -- last resort
}

function testPythonCommand(cmd, args) {
  return new Promise((resolve) => {
    const proc = exec(`${cmd} ${args.join(' ')}`, { timeout: 3000 }, (err, stdout, stderr) => {
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
  const candidates = [
    { cmd: 'py',      args: ['-3.13', '--version'] },
    { cmd: 'py',      args: ['-3.12', '--version'] },
    { cmd: 'py',      args: ['-3.11', '--version'] },
    { cmd: 'python3', args: ['--version'] },
    { cmd: 'python',  args: ['--version'] },
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
// app.getPath('userData') returns the correct OS-specific data folder:
//   Windows: C:\Users\<name>\AppData\Roaming\Witness
//   Mac:     ~/Library/Application Support/Witness
// We pass this to Python via env vars so witness.db lives there,
// not inside the app's install folder (which changes on reinstall).

function getUserDataPaths() {
  const userData    = app.getPath('userData')
  const healthInbox = path.join(userData, 'health-inbox')

  // Make sure the health-inbox folder exists
  if (!fs.existsSync(healthInbox)) {
    fs.mkdirSync(healthInbox, { recursive: true })
  }

  return { userData, healthInbox }
}

// ─── PYTHON BACKEND ──────────────────────────────────────────────────────────

async function startPythonBackend() {
  const { userData, healthInbox } = getUserDataPaths()

  // Environment variables passed to the Python process.
  // The Python backend reads these to know where to store data.
  //
  // OLLAMA_PATH: We detect the Ollama executable from Node (which has full
  // PATH access) and pass it to Python. This solves the PyInstaller isolation
  // problem where bundled Python cannot see the system PATH.
  const ollamaPath = _findOllamaPath()

  const pythonEnv = {
    ...process.env,
    WITNESS_USER_DATA:    userData,       // Where to store witness.db
    WITNESS_HEALTH_INBOX: healthInbox,    // Where to look for Apple Health files
    OLLAMA_PATH:          ollamaPath,     // Full path to ollama.exe for PyInstaller bundle
  }

  // ── PACKAGED MODE (distributed .exe installer) ────────────────────────────
  if (app.isPackaged) {
    const exePath = path.join(
      process.resourcesPath,
      'witness-backend',
      'witness-backend.exe'
    )

    console.log(`[PYTHON] Packaged mode — launching: ${exePath}`)
    console.log(`[PYTHON] User data dir: ${userData}`)

    // Sanity check — if the bundle is missing, tell the user clearly
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

  const launchArgs = [
    ...python.extraArgs,
    '-O',
    scriptPath
  ]

  console.log(`[PYTHON] Launching: ${python.cmd} ${launchArgs.join(' ')}`)
  console.log(`[PYTHON] User data dir: ${userData}`)

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
      sandbox:          false
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
  })

  mainWindow.on('closed', () => {
    mainWindow = null
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
  const MAX_ATTEMPTS    = 90   // 90 × 500ms = 45 seconds (PyInstaller needs longer)

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
