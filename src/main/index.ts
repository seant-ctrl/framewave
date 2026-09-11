import { app, BrowserWindow, protocol, session, globalShortcut, desktopCapturer, ipcMain } from 'electron'
import { promises as fs, createReadStream } from 'fs'
import { extname, join, normalize } from 'path'
import { Readable } from 'stream'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.json': 'application/json'
}
const APP_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain'
}
import { createMainWindow, mainWindow, focusMain } from './windows'
import { registerIpc, capturePick } from './ipc'
import { getSettings } from './settings'
import { cancelAll } from './ffmpeg'
import { stopTracking, restoreSystemCursors } from './tracker'
import { stop as stopSysAudio } from './sysaudio'

// Custom protocol for streaming local media into the renderer with range support.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'fwmedia',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
  },
  {
    // Serves the built renderer in production (file:// would block fetch() of wasm/model assets)
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, allowServiceWorkers: true }
  }
])

// GPU / media flags
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCEncoderSupport,PlatformHEVCDecoderSupport,WebRtcAllowInputVolumeAdjustment')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (!getSettings().hardwareAcceleration) app.disableHardwareAcceleration()
if (!app.isPackaged && process.env.FW_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.FW_DEBUG_PORT)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => focusMain())
}

app.setAppUserModelId('com.framewave.app')

app.whenReady().then(() => {
  // fwmedia://local/<encoded absolute path>
  protocol.handle('fwmedia', async (request) => {
    const url = new URL(request.url)
    let p = decodeURIComponent(url.pathname)
    if (p.startsWith('/')) p = p.slice(1)
    let size: number
    try {
      size = (await fs.stat(p)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const ext = extname(p).toLowerCase()
    const mime = MIME[ext] ?? 'application/octet-stream'
    const range = request.headers.get('range')
    const headers: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/)
      let start = m && m[1] ? Number(m[1]) : 0
      let end = m && m[2] ? Number(m[2]) : size - 1
      if (!m || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      end = Math.min(end, size - 1)
      if (!m[1] && m[2]) {
        start = Math.max(0, size - Number(m[2]))
        end = size - 1
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      headers['Content-Length'] = String(end - start + 1)
      const stream = Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream
      return new Response(stream, { status: 206, headers })
    }
    headers['Content-Length'] = String(size)
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { status: 200, headers })
  })

  // app://framewave/<file> → out/renderer/<file>
  const rendererRoot = join(__dirname, '../renderer')
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    if (!rel) rel = 'index.html'
    const full = normalize(join(rendererRoot, rel))
    if (!full.startsWith(normalize(rendererRoot))) return new Response('Forbidden', { status: 403 })
    try {
      const size = (await fs.stat(full)).size
      const mime = MIME[extname(full).toLowerCase()] ?? APP_MIME[extname(full).toLowerCase()] ?? 'application/octet-stream'
      return new Response(Readable.toWeb(createReadStream(full)) as ReadableStream, { status: 200, headers: { 'Content-Type': mime, 'Content-Length': String(size) } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  // Route getDisplayMedia to the source chosen in the UI; enable Windows loopback audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        const src = sources.find((s) => s.id === capturePick.sourceId) ?? sources.find((s) => s.id.startsWith('screen'))
        if (!src) return callback({})
        // Loopback (system) audio capture is only implemented by Chromium on Windows
        const loopback = process.platform === 'win32' && capturePick.systemAudio
        callback({ video: src, audio: loopback ? 'loopback' : undefined })
      } catch (e) {
        console.error('display media handler failed', e)
        callback({})
      }
    },
    { useSystemPicker: false }
  )

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']
    callback(allowed.includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  registerIpc()
  // Safety: if a previous session crashed while recording, bring the cursor back
  restoreSystemCursors()
  createMainWindow()

  // Global hotkeys
  const hk = getSettings().hotkeys
  try {
    globalShortcut.register(hk.toggleRecord, () => mainWindow?.webContents.send('hotkey', 'toggle-record'))
    globalShortcut.register(hk.pauseResume, () => mainWindow?.webContents.send('hotkey', 'pause-resume'))
  } catch (e) {
    console.warn('hotkey registration failed', e)
  }

  ipcMain.on('hotkeys:update', (_e, hotkeys: { toggleRecord: string; pauseResume: string }) => {
    globalShortcut.unregisterAll()
    try {
      globalShortcut.register(hotkeys.toggleRecord, () => mainWindow?.webContents.send('hotkey', 'toggle-record'))
      globalShortcut.register(hotkeys.pauseResume, () => mainWindow?.webContents.send('hotkey', 'pause-resume'))
    } catch (e) {
      console.warn('hotkey registration failed', e)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  cancelAll()
  stopTracking()
  void stopSysAudio()
  restoreSystemCursors()
  globalShortcut.unregisterAll()
})
