import { ipcMain, desktopCapturer, screen, dialog, shell, BrowserWindow, app, clipboard, nativeImage } from 'electron'
import { promises as fs, openSync, writeSync, closeSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'
import * as projects from './projects'
import * as ffmpeg from './ffmpeg'
import * as tracker from './tracker'
import { getSettings, updateSettings } from './settings'
import { mainWindow, hudWindow, showHud, hideHud, pickRegion, showCameraBubble, hideCameraBubble, focusMain } from './windows'
import { toRendererError } from './util'
import type { CaptureSource, DisplayInfo, HudState, HudCommand, RecordingMeta, Project, AppSettings, FfmpegJob } from '@shared/types'

/** Source chosen for the next getDisplayMedia call (see index.ts handler). */
export const capturePick: { sourceId: string | null; systemAudio: boolean } = { sourceId: null, systemAudio: false }

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...(args as T))
    } catch (e) {
      console.error(`[ipc:${channel}]`, e)
      throw new Error(toRendererError(e))
    }
  })
}

export function registerIpc(): void {
  // ── Window controls ─────────────────────────────────────────────────────
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('win:hide', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:show', () => focusMain())
  handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false)
  ipcMain.on('win:setSize', (e, w: number, h: number) => BrowserWindow.fromWebContents(e.sender)?.setSize(Math.round(w), Math.round(h)))

  // ── Settings ────────────────────────────────────────────────────────────
  handle('settings:get', () => getSettings())
  handle('settings:set', (patch: Partial<AppSettings>) => updateSettings(patch))
  handle('settings:chooseProjectsDir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: getSettings().projectsDir })
    if (r.canceled || !r.filePaths[0]) return null
    return updateSettings({ projectsDir: r.filePaths[0] })
  })

  // ── Capture sources ─────────────────────────────────────────────────────
  handle('capture:displays', (): DisplayInfo[] => {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || `Display ${i + 1}`,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primary.id
    }))
  })

  handle('capture:sources', async (kinds: Array<'screen' | 'window'>): Promise<CaptureSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: kinds,
      thumbnailSize: { width: 480, height: 300 },
      fetchWindowIcons: true
    })
    const displays = screen.getAllDisplays()
    return sources
      .filter((s) => !s.name.startsWith('Framewave') && s.name !== '')
      .map((s) => {
        const kind = s.id.startsWith('screen') ? 'screen' : 'window'
        let bounds: CaptureSource['bounds']
        let scaleFactor: number | undefined
        if (kind === 'screen') {
          const d = displays.find((x) => String(x.id) === s.display_id) ?? displays[Number(s.id.split(':')[1]) || 0]
          bounds = d?.bounds
          scaleFactor = d?.scaleFactor
        } else {
          const hwnd = Number(s.id.split(':')[1])
          const phys = tracker.windowRect(hwnd)
          if (phys) bounds = screen.screenToDipRect(null, phys)
        }
        return {
          id: s.id,
          name: s.name,
          kind,
          thumbnail: s.thumbnail.toDataURL(),
          appIcon: s.appIcon?.toDataURL(),
          displayId: s.display_id,
          bounds,
          scaleFactor
        }
      })
  })

  handle('capture:pick', (sourceId: string, systemAudio: boolean) => {
    capturePick.sourceId = sourceId
    capturePick.systemAudio = systemAudio
  })

  handle('capture:pickRegion', (displayId?: number) => pickRegion(displayId))

  handle('capture:windowRect', (hwnd: number) => {
    const phys = tracker.windowRect(hwnd)
    return phys ? { phys, dip: screen.screenToDipRect(null, phys) } : null
  })

  // ── Input tracker ───────────────────────────────────────────────────────
  handle('tracker:start', (target: tracker.TrackerTarget) => tracker.startTracking(target))
  handle('tracker:stop', (startEpochMs?: number) => tracker.stopTracking(startEpochMs))
  handle('tracker:cursor', () => tracker.currentCursor())

  // ── HUD ─────────────────────────────────────────────────────────────────
  handle('hud:show', (displayId?: number) => {
    const d = displayId != null ? screen.getAllDisplays().find((x) => x.id === displayId) : undefined
    showHud(d)
  })
  handle('hud:hide', () => hideHud())
  ipcMain.on('hud:state', (_e, state: HudState) => {
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send('hud:state', state)
  })
  ipcMain.on('hud:command', (_e, cmd: HudCommand) => send('hud:command', cmd))
  handle('camera:bubble', (deviceId: string | null, displayId?: number) => {
    if (!deviceId) return hideCameraBubble()
    const d = displayId != null ? screen.getAllDisplays().find((x) => x.id === displayId) : undefined
    showCameraBubble(deviceId, d)
  })

  // ── Projects ────────────────────────────────────────────────────────────
  handle('project:list', () => projects.listProjects())
  handle('project:create', (name: string, meta: RecordingMeta) => projects.createProject(name, meta))
  handle('project:load', (id: string) => projects.loadProject(id))
  handle('project:save', (p: Project) => projects.saveProject(p))
  handle('project:delete', (id: string) => projects.deleteProject(id))
  handle('project:rename', (id: string, name: string) => projects.renameProject(id, name))
  handle('project:duplicate', (id: string) => projects.duplicateProject(id))
  handle('project:openStream', (id: string, file: string) => projects.openChunkStream(id, file))
  handle('project:writeChunk', (key: string, data: Uint8Array) => projects.writeChunk(key, data))
  handle('project:closeStream', (key: string) => projects.closeChunkStream(key))
  handle('project:writeFile', (id: string, file: string, data: Uint8Array | string) => projects.writeFile(id, file, data))
  handle('project:readFile', (id: string, file: string) => projects.readFile(id, file))
  handle('project:readText', (id: string, file: string) => projects.readText(id, file))
  handle('project:finalize', (id: string) =>
    projects.finalizeRecording(id, (label, p) => send('project:progress', { id, label, progress: p }))
  )
  handle('project:import', async (filePath?: string) => {
    let file = filePath
    if (!file) {
      const r = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'gif'] }]
      })
      if (r.canceled) return null
      file = r.filePaths[0]
    }
    return projects.importVideo(file, (label, p) => send('project:progress', { id: 'import', label, progress: p }))
  })
  handle('project:importAsset', async (id: string, kind: 'audio' | 'image' | 'video') => {
    const filters =
      kind === 'audio'
        ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'] }]
        : kind === 'image'
          ? [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
          : [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv'] }]
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters })
    if (r.canceled) return null
    const name = await projects.importAsset(id, r.filePaths[0])
    return { file: name, path: join(projects.projectDir(id), name) }
  })
  handle('project:openFolder', (id: string) => shell.openPath(projects.projectDir(id)))

  // ── ffmpeg ──────────────────────────────────────────────────────────────
  handle('ffmpeg:probe', (path: string) => ffmpeg.probe(path))
  handle('ffmpeg:run', (jobId: string, job: FfmpegJob) =>
    ffmpeg.run(job.args, {
      jobId,
      durationMs: job.durationMs,
      onProgress: (p) => send('ffmpeg:progress', { jobId, ...p })
    })
  )
  handle('ffmpeg:cancel', (jobId: string) => ffmpeg.cancel(jobId))

  // ── Export file streaming (random-access writes) ─────────────────────────
  const fds = new Map<string, number>()
  handle('file:open', async (path: string) => {
    await fs.mkdir(dirname(path), { recursive: true })
    const fd = openSync(path, 'w')
    const key = `${fd}:${Date.now()}`
    fds.set(key, fd)
    return key
  })
  handle('file:write', (key: string, data: Uint8Array, position: number | null) => {
    const fd = fds.get(key)
    if (fd == null) throw new Error('file not open')
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    writeSync(fd, buf, 0, buf.length, position ?? null)
  })
  handle('file:close', (key: string) => {
    const fd = fds.get(key)
    if (fd == null) return
    closeSync(fd)
    fds.delete(key)
  })
  handle('file:stat', (path: string) => {
    try {
      const s = statSync(path)
      return { size: s.size, mtime: s.mtimeMs }
    } catch {
      return null
    }
  })
  handle('file:read', async (path: string) => {
    const b = await fs.readFile(path)
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  })
  handle('file:delete', (path: string) => fs.rm(path, { force: true }))
  handle('file:move', async (from: string, to: string) => {
    await fs.mkdir(dirname(to), { recursive: true })
    try {
      await fs.rename(from, to)
    } catch {
      await fs.copyFile(from, to)
      await fs.rm(from, { force: true })
    }
  })
  handle('file:tempPath', (name: string) => join(app.getPath('temp'), 'framewave', `${Date.now()}-${name}`))

  // ── Dialogs / shell ─────────────────────────────────────────────────────
  handle('dialog:save', async (opts: { defaultName: string; filters: Array<{ name: string; extensions: string[] }> }) => {
    const s = getSettings()
    const r = await dialog.showSaveDialog({
      defaultPath: join(s.lastExportDir ?? app.getPath('videos'), opts.defaultName),
      filters: opts.filters
    })
    if (r.canceled || !r.filePath) return null
    updateSettings({ lastExportDir: dirname(r.filePath) })
    return r.filePath
  })
  handle('dialog:open', async (opts: { filters: Array<{ name: string; extensions: string[] }>; multiple?: boolean }) => {
    const r = await dialog.showOpenDialog({
      properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts.filters
    })
    return r.canceled ? [] : r.filePaths
  })
  handle('shell:openPath', (p: string) => shell.openPath(p))
  handle('shell:showItem', (p: string) => shell.showItemInFolder(p))
  handle('shell:openExternal', (u: string) => shell.openExternal(u))
  handle('shell:copyFile', (p: string) => {
    // Copy file reference to clipboard (Windows: CF_HDROP via writeBuffer isn't exposed; copy path + image fallback)
    if (/\.(png|jpe?g|gif|webp)$/i.test(p)) clipboard.writeImage(nativeImage.createFromPath(p))
    else clipboard.writeText(p)
  })
  handle('app:version', () => app.getVersion())
  handle('app:paths', () => ({ videos: app.getPath('videos'), temp: app.getPath('temp'), userData: app.getPath('userData') }))
  handle('app:basename', (p: string) => basename(p))
}
