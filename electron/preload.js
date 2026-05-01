/**
 * WITNESS — Electron Preload
 * Secure bridge between the Electron desktop layer and the React app.
 * Only what is explicitly listed here is accessible from the React side.
 *
 * Step 12 additions:
 *   - onPythonNotFound: lets React listen for the 'python-not-found' signal
 *     from main.js so it can show the install-Python error screen.
 *   - openExternal: lets React open a URL in the system browser
 *     (used by the Python error screen's "OPEN PYTHON.ORG" button).
 *
 * Save this file at: witness/electron/preload.js
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('witness', {

  // ── Window controls ────────────────────────────────────────────────────────
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close:    () => ipcRenderer.send('close-window'),

  // ── Manual notification trigger (for testing from Settings) ───────────────
  notify: (title, body) => ipcRenderer.send('show-notification', { title, body }),

  // ── Navigation from notification click ────────────────────────────────────
  onNavigate: (callback) => {
    ipcRenderer.on('navigate-to', (event, screen) => callback(screen))
  },

  // ── Backend ready signal ───────────────────────────────────────────────────
  // main.js polls the Python backend silently using Node's http module.
  // When it responds, it sends 'backend-ready' here so React can drop
  // the splash screen without any fetch() polling.
  onBackendReady: (callback) => {
    ipcRenderer.on('backend-ready', () => callback())
  },

  // ── Python not found signal ────────────────────────────────────────────────
  // Fired by main.js when no compatible Python install is detected.
  // React listens here and shows the install-Python error screen.
  onPythonNotFound: (callback) => {
    ipcRenderer.on('python-not-found', () => callback())
  },

  // ── Open URL in system browser ─────────────────────────────────────────────
  // Used by the Python error screen to open python.org.
  // We route through main.js so we can use shell.openExternal safely.
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // ── Platform info ──────────────────────────────────────────────────────────
  platform: process.platform,

  // ── Python backend URL ─────────────────────────────────────────────────────
  apiUrl: 'http://127.0.0.1:8000'

})
