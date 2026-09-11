import { BrowserWindow, screen, shell, ipcMain, Display } from 'electron'
import { join } from 'path'
import { is } from './util'
import type { Rect } from '@shared/types'

export let mainWindow: BrowserWindow | null = null
export let hudWindow: BrowserWindow | null = null
export let cameraWindow: BrowserWindow | null = null
let regionWindow: BrowserWindow | null = null

const preload = join(__dirname, '../preload/index.js')

function rendererUrl(page: string): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}/${page}`
  }
  return `app://framewave/${page}`
}

function load(win: BrowserWindow, page: string, hash?: string): void {
  void win.loadURL(rendererUrl(page) + (hash ? `#${hash}` : ''))
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const { workAreaSize } = screen.getPrimaryDisplay()
  mainWindow = new BrowserWindow({
    width: Math.min(1560, workAreaSize.width - 40),
    height: Math.min(960, workAreaSize.height - 40),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    // macOS keeps its native traffic lights inset into our custom title bar
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 13 } : undefined,
    backgroundColor: '#0b0b10',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  if (is.dev) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.log(`[renderer:${level === 3 ? 'error' : 'warn'}] ${message} (${sourceId.split('/').pop()}:${line})`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d))
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:state', { maximized: true }))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:state', { maximized: false }))
  mainWindow.on('closed', () => (mainWindow = null))
  load(mainWindow, 'index.html')
  return mainWindow
}

// ── Recording HUD ───────────────────────────────────────────────────────────

export function showHud(display?: Display): BrowserWindow {
  const d = display ?? screen.getPrimaryDisplay()
  const w = 420
  const h = 76
  const x = Math.round(d.workArea.x + (d.workArea.width - w) / 2)
  const y = Math.round(d.workArea.y + d.workArea.height - h - 24)
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.setBounds({ x, y, width: w, height: h })
    hudWindow.showInactive()
    return hudWindow
  }
  hudWindow = new BrowserWindow({
    x,
    y,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false }
  })
  hudWindow.setAlwaysOnTop(true, 'screen-saver')
  // Exclude from screen capture (WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+)
  hudWindow.setContentProtection(true)
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive())
  hudWindow.on('closed', () => (hudWindow = null))
  load(hudWindow, 'hud.html')
  return hudWindow
}

export function hideHud(): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.close()
  }
  hudWindow = null
}

// ── Floating camera bubble ──────────────────────────────────────────────────

export function showCameraBubble(deviceId: string, display?: Display): BrowserWindow {
  const d = display ?? screen.getPrimaryDisplay()
  const size = 240
  const x = d.workArea.x + 24
  const y = d.workArea.y + d.workArea.height - size - 24
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    cameraWindow.webContents.send('camera:device', deviceId)
    cameraWindow.showInactive()
    return cameraWindow
  }
  cameraWindow = new BrowserWindow({
    x,
    y,
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    minWidth: 120,
    minHeight: 120,
    webPreferences: { preload, sandbox: false, contextIsolation: true, backgroundThrottling: false }
  })
  cameraWindow.setAlwaysOnTop(true, 'screen-saver')
  cameraWindow.setContentProtection(true)
  cameraWindow.setAspectRatio(1)
  cameraWindow.once('ready-to-show', () => cameraWindow?.showInactive())
  cameraWindow.on('closed', () => (cameraWindow = null))
  load(cameraWindow, 'hud.html', `camera=${encodeURIComponent(deviceId)}`)
  return cameraWindow
}

export function hideCameraBubble(): void {
  if (cameraWindow && !cameraWindow.isDestroyed()) cameraWindow.close()
  cameraWindow = null
}

// ── Region picker overlay ───────────────────────────────────────────────────

export function pickRegion(displayId?: number): Promise<Rect | null> {
  const d = (displayId != null && screen.getAllDisplays().find((x) => x.id === displayId)) || screen.getPrimaryDisplay()
  return new Promise((resolve) => {
    if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close()
    regionWindow = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      show: false,
      webPreferences: { preload, sandbox: false, contextIsolation: true }
    })
    regionWindow.setAlwaysOnTop(true, 'screen-saver')
    regionWindow.setContentProtection(true)
    let done = false
    const finish = (r: Rect | null): void => {
      if (done) return
      done = true
      ipcMain.removeListener('region:done', onDone)
      resolve(r)
      if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close()
      regionWindow = null
    }
    const onDone = (_e: Electron.IpcMainEvent, r: Rect | null): void => finish(r)
    ipcMain.on('region:done', onDone)
    regionWindow.on('closed', () => finish(null))
    regionWindow.once('ready-to-show', () => {
      regionWindow?.show()
      regionWindow?.focus()
      // Force exact bounds (Windows may clamp transparent windows)
      regionWindow?.setBounds(d.bounds)
    })
    load(regionWindow, 'region.html', `display=${d.id}&scale=${d.scaleFactor}`)
  })
}

export function focusMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}
