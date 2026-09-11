import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import type {
  AppSettings,
  CaptureSource,
  DisplayInfo,
  HudCommand,
  HudState,
  Project,
  ProjectSummary,
  RecordingEvents,
  RecordingMeta,
  MediaAsset,
  Rect,
  FfmpegJob,
  FfmpegProgress
} from '@shared/types'

type Unsub = () => void
function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): Unsub {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** Convert an absolute path to a streamable media URL. */
function mediaUrl(absPath: string): string {
  return 'fwmedia://local/' + encodeURIComponent(absPath.replace(/\\/g, '/'))
}

const api = {
  platform: process.platform,
  mediaUrl,
  /** Absolute path of a File dropped into the window. */
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  window: {
    minimize: (): void => ipcRenderer.send('win:minimize'),
    maximize: (): void => ipcRenderer.send('win:maximize'),
    close: (): void => ipcRenderer.send('win:close'),
    hide: (): void => ipcRenderer.send('win:hide'),
    show: (): void => ipcRenderer.send('win:show'),
    setSize: (w: number, h: number): void => ipcRenderer.send('win:setSize', w, h),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
    onState: (cb: (s: { maximized: boolean }) => void): Unsub => on('win:state', cb)
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
    chooseProjectsDir: (): Promise<AppSettings | null> => ipcRenderer.invoke('settings:chooseProjectsDir'),
    updateHotkeys: (hk: AppSettings['hotkeys']): void => ipcRenderer.send('hotkeys:update', hk)
  },
  capture: {
    displays: (): Promise<DisplayInfo[]> => ipcRenderer.invoke('capture:displays'),
    sources: (kinds: Array<'screen' | 'window'>): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:sources', kinds),
    pick: (sourceId: string, systemAudio: boolean): Promise<void> => ipcRenderer.invoke('capture:pick', sourceId, systemAudio),
    pickRegion: (displayId?: number): Promise<Rect | null> => ipcRenderer.invoke('capture:pickRegion', displayId),
    windowRect: (hwnd: number): Promise<{ phys: Rect; dip: Rect } | null> => ipcRenderer.invoke('capture:windowRect', hwnd)
  },
  tracker: {
    start: (target: { kind: 'display' | 'window' | 'region'; displayId?: number; hwnd?: number; region?: Rect; hideCursor?: boolean }): Promise<boolean> =>
      ipcRenderer.invoke('tracker:start', target),
    stop: (startEpochMs?: number): Promise<RecordingEvents | null> => ipcRenderer.invoke('tracker:stop', startEpochMs),
    cursor: (): Promise<{ x: number; y: number } | null> => ipcRenderer.invoke('tracker:cursor')
  },
  sysaudio: {
    available: (): Promise<boolean> => ipcRenderer.invoke('sysaudio:available'),
    start: (projectId: string, file: string): Promise<void> => ipcRenderer.invoke('sysaudio:start', projectId, file),
    stop: (): Promise<void> => ipcRenderer.invoke('sysaudio:stop'),
    pause: (): Promise<void> => ipcRenderer.invoke('sysaudio:pause'),
    resume: (): Promise<void> => ipcRenderer.invoke('sysaudio:resume')
  },
  hud: {
    show: (displayId?: number): Promise<void> => ipcRenderer.invoke('hud:show', displayId),
    hide: (): Promise<void> => ipcRenderer.invoke('hud:hide'),
    setState: (s: HudState): void => ipcRenderer.send('hud:state', s),
    onState: (cb: (s: HudState) => void): Unsub => on('hud:state', cb),
    sendCommand: (c: HudCommand): void => ipcRenderer.send('hud:command', c),
    onCommand: (cb: (c: HudCommand) => void): Unsub => on('hud:command', cb),
    cameraBubble: (deviceId: string | null, displayId?: number): Promise<void> => ipcRenderer.invoke('camera:bubble', deviceId, displayId),
    onCameraDevice: (cb: (id: string) => void): Unsub => on('camera:device', cb)
  },
  region: {
    done: (r: Rect | null): void => ipcRenderer.send('region:done', r)
  },
  projects: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:list'),
    create: (name: string, meta: RecordingMeta): Promise<Project> => ipcRenderer.invoke('project:create', name, meta),
    load: (id: string): Promise<Project> => ipcRenderer.invoke('project:load', id),
    save: (p: Project): Promise<Project> => ipcRenderer.invoke('project:save', p),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('project:delete', id),
    rename: (id: string, name: string): Promise<Project> => ipcRenderer.invoke('project:rename', id, name),
    duplicate: (id: string): Promise<Project> => ipcRenderer.invoke('project:duplicate', id),
    openStream: (id: string, file: string): Promise<string> => ipcRenderer.invoke('project:openStream', id, file),
    writeChunk: (key: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke('project:writeChunk', key, data),
    closeStream: (key: string): Promise<void> => ipcRenderer.invoke('project:closeStream', key),
    writeFile: (id: string, file: string, data: Uint8Array | string): Promise<string> => ipcRenderer.invoke('project:writeFile', id, file, data),
    readFile: (id: string, file: string): Promise<Uint8Array> => ipcRenderer.invoke('project:readFile', id, file),
    readText: (id: string, file: string): Promise<string> => ipcRenderer.invoke('project:readText', id, file),
    finalize: (id: string): Promise<Project> => ipcRenderer.invoke('project:finalize', id),
    import: (filePath?: string): Promise<Project | null> => ipcRenderer.invoke('project:import', filePath),
    importAsset: (id: string, kind: 'audio' | 'image' | 'video'): Promise<{ file: string; path: string } | null> =>
      ipcRenderer.invoke('project:importAsset', id, kind),
    createMontage: (filePaths?: string[]): Promise<Project | null> => ipcRenderer.invoke('project:createMontage', filePaths),
    addMedia: (id: string, filePaths?: string[]): Promise<MediaAsset[]> => ipcRenderer.invoke('project:addMedia', id, filePaths),
    openFolder: (id: string): Promise<string> => ipcRenderer.invoke('project:openFolder', id),
    onProgress: (cb: (p: { id: string; label: string; progress: number }) => void): Unsub => on('project:progress', cb)
  },
  ffmpeg: {
    probe: (path: string): Promise<{ durationMs: number; width: number; height: number; hasAudio: boolean; hasVideo: boolean; codec: string; fps?: number }> =>
      ipcRenderer.invoke('ffmpeg:probe', path),
    run: (jobId: string, job: FfmpegJob): Promise<void> => ipcRenderer.invoke('ffmpeg:run', jobId, job),
    cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke('ffmpeg:cancel', jobId),
    onProgress: (cb: (p: FfmpegProgress & { fps?: number }) => void): Unsub => on('ffmpeg:progress', cb)
  },
  file: {
    open: (path: string): Promise<string> => ipcRenderer.invoke('file:open', path),
    write: (key: string, data: Uint8Array, position: number | null): Promise<void> => ipcRenderer.invoke('file:write', key, data, position),
    close: (key: string): Promise<void> => ipcRenderer.invoke('file:close', key),
    stat: (path: string): Promise<{ size: number; mtime: number } | null> => ipcRenderer.invoke('file:stat', path),
    read: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('file:read', path),
    delete: (path: string): Promise<void> => ipcRenderer.invoke('file:delete', path),
    move: (from: string, to: string): Promise<void> => ipcRenderer.invoke('file:move', from, to),
    tempPath: (name: string): Promise<string> => ipcRenderer.invoke('file:tempPath', name)
  },
  dialog: {
    save: (opts: { defaultName: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:save', opts),
    open: (opts: { filters: Array<{ name: string; extensions: string[] }>; multiple?: boolean }): Promise<string[]> =>
      ipcRenderer.invoke('dialog:open', opts)
  },
  shell: {
    openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:openPath', p),
    showItem: (p: string): Promise<void> => ipcRenderer.invoke('shell:showItem', p),
    openExternal: (u: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', u),
    copyFile: (p: string): Promise<void> => ipcRenderer.invoke('shell:copyFile', p)
  },
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    paths: (): Promise<{ videos: string; temp: string; userData: string }> => ipcRenderer.invoke('app:paths'),
    basename: (p: string): Promise<string> => ipcRenderer.invoke('app:basename', p),
    onHotkey: (cb: (k: 'toggle-record' | 'pause-resume') => void): Unsub => on('hotkey', cb)
  }
}

export type FramewaveApi = typeof api

contextBridge.exposeInMainWorld('fw', api)
