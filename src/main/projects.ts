import { promises as fs, createWriteStream, WriteStream, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import { randomUUID } from 'crypto'
import { getSettings } from './settings'
import * as ffmpeg from './ffmpeg'
import type { Project, ProjectSummary, RecordingMeta, MediaAsset } from '@shared/types'
import { DEFAULT_RENDER, DEFAULT_TIMELINE } from '@shared/types'

export function projectsDir(): string {
  return getSettings().projectsDir
}

export function projectDir(id: string): string {
  return join(projectsDir(), id)
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'Recording'
}

export function newProjectId(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${randomUUID().slice(0, 6)}`
}

export async function createProject(name: string, recording: RecordingMeta): Promise<Project> {
  const id = newProjectId()
  const dir = projectDir(id)
  await ensureDir(dir)
  const now = Date.now()
  const project: Project = {
    id,
    name: safeName(name),
    version: 1,
    createdAt: now,
    updatedAt: now,
    dir,
    recording,
    timeline: DEFAULT_TIMELINE(recording.durationMs || 0),
    render: { ...DEFAULT_RENDER, ...getSettings().defaultRender }
  }
  await saveProject(project)
  return project
}

export async function saveProject(project: Project): Promise<Project> {
  project.updatedAt = Date.now()
  project.dir = projectDir(project.id)
  await ensureDir(project.dir)
  const tmp = join(project.dir, 'project.json.tmp')
  await fs.writeFile(tmp, JSON.stringify(project, null, 1), 'utf-8')
  await fs.rename(tmp, join(project.dir, 'project.json'))
  return project
}

export async function loadProject(id: string): Promise<Project> {
  const file = join(projectDir(id), 'project.json')
  const raw = await fs.readFile(file, 'utf-8')
  const p = JSON.parse(raw) as Project
  p.dir = projectDir(id)
  // Forward-compat: fill defaults
  p.render = deepMerge(DEFAULT_RENDER, p.render ?? {})
  p.timeline = { ...DEFAULT_TIMELINE(p.recording?.durationMs ?? 0), ...p.timeline }
  return p
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (patch as T) ?? base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b, v as Record<string, unknown>)
    } else if (v !== undefined) out[k] = v
  }
  return out as T
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = projectsDir()
  await ensureDir(root)
  const entries = await fs.readdir(root, { withFileTypes: true })
  const out: ProjectSummary[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = join(root, e.name, 'project.json')
    if (!existsSync(file)) continue
    try {
      const p = JSON.parse(await fs.readFile(file, 'utf-8')) as Project
      const thumb = join(root, e.name, 'thumb.jpg')
      out.push({
        id: p.id,
        name: p.name,
        dir: join(root, e.name),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        durationMs: p.recording?.durationMs ?? 0,
        thumbnail: existsSync(thumb) ? thumb : undefined,
        width: p.recording?.width ?? 0,
        height: p.recording?.height ?? 0
      })
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

export async function deleteProject(id: string): Promise<void> {
  const dir = projectDir(id)
  if (!dir.startsWith(projectsDir())) throw new Error('refusing to delete outside projects dir')
  await fs.rm(dir, { recursive: true, force: true })
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const p = await loadProject(id)
  p.name = safeName(name)
  return saveProject(p)
}

export async function duplicateProject(id: string): Promise<Project> {
  const src = await loadProject(id)
  const newId = newProjectId()
  const dst = projectDir(newId)
  await fs.cp(projectDir(id), dst, { recursive: true })
  const p: Project = { ...src, id: newId, dir: dst, name: src.name + ' copy', createdAt: Date.now() }
  return saveProject(p)
}

// ── Streaming writes for recording chunks ────────────────────────────────────

const streams = new Map<string, WriteStream>()

export async function openChunkStream(id: string, file: string): Promise<string> {
  const dir = projectDir(id)
  await ensureDir(dir)
  const key = `${id}/${file}`
  if (streams.has(key)) return key
  const ws = createWriteStream(join(dir, file), { flags: 'w' })
  streams.set(key, ws)
  return key
}

export function writeChunk(key: string, data: Uint8Array): Promise<void> {
  const ws = streams.get(key)
  if (!ws) return Promise.reject(new Error('stream not open: ' + key))
  return new Promise((resolve, reject) => {
    ws.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err) => (err ? reject(err) : resolve()))
  })
}

export function closeChunkStream(key: string): Promise<void> {
  const ws = streams.get(key)
  if (!ws) return Promise.resolve()
  streams.delete(key)
  return new Promise((resolve) => ws.end(() => resolve()))
}

export async function writeFile(id: string, file: string, data: Uint8Array | string): Promise<string> {
  const dir = projectDir(id)
  await ensureDir(dir)
  const full = join(dir, file)
  if (typeof data === 'string') await fs.writeFile(full, data, 'utf-8')
  else await fs.writeFile(full, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  return full
}

export async function readFile(id: string, file: string): Promise<Uint8Array> {
  const buf = await fs.readFile(join(projectDir(id), file))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export async function readText(id: string, file: string): Promise<string> {
  return fs.readFile(join(projectDir(id), file), 'utf-8')
}

// ── Normalization (make recordings seekable & web playable) ─────────────────

const WEB_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])

/**
 * MediaRecorder output lacks duration & cues, so seeking is broken. We remux
 * (stream copy, near-instant) into a proper container. Non-web codecs are
 * transcoded to H.264.
 */
export async function normalizeAsset(
  id: string,
  asset: MediaAsset,
  kind: 'video' | 'audio',
  onProgress?: (p: number) => void
): Promise<MediaAsset> {
  const dir = projectDir(id)
  const input = join(dir, asset.file)
  const info = await ffmpeg.probe(input)
  const base = basename(asset.file, extname(asset.file))
  let out: string
  let args: string[]

  if (kind === 'audio' || !info.hasVideo) {
    // Audio-only → keep opus in webm when possible, else transcode to AAC in m4a
    if (info.audioCodec === 'opus' || info.audioCodec === 'vorbis') {
      out = `${base}.norm.webm`
      args = ['-i', input, '-vn', '-c:a', 'copy', join(dir, out)]
    } else {
      out = `${base}.norm.m4a`
      args = ['-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', join(dir, out)]
    }
  } else if (info.codec === 'h264') {
    out = `${base}.norm.mp4`
    args = ['-i', input, '-c:v', 'copy', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), '-movflags', '+faststart', join(dir, out)]
  } else if (WEB_VIDEO.has(info.codec)) {
    out = `${base}.norm.webm`
    args = ['-i', input, '-c', 'copy', join(dir, out)]
  } else {
    out = `${base}.norm.mp4`
    args = [
      '-i', input,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      '-movflags', '+faststart',
      join(dir, out)
    ]
  }

  await ffmpeg.run(args, { durationMs: info.durationMs || undefined, onProgress: (p) => onProgress?.(p.progress) })
  const finalInfo = await ffmpeg.probe(join(dir, out))
  return {
    ...asset,
    raw: asset.file,
    file: out,
    width: finalInfo.width || asset.width,
    height: finalInfo.height || asset.height,
    durationMs: finalInfo.durationMs || asset.durationMs,
    hasAudio: finalInfo.hasAudio,
    codec: finalInfo.codec || finalInfo.audioCodec
  }
}

export async function finalizeRecording(
  id: string,
  onProgress?: (label: string, p: number) => void
): Promise<Project> {
  const p = await loadProject(id)
  const r = p.recording
  if (r.screen) {
    r.screen = await normalizeAsset(id, r.screen, 'video', (x) => onProgress?.('Processing screen', x))
    r.width = r.screen.width ?? r.width
    r.height = r.screen.height ?? r.height
    if (r.screen.durationMs) r.durationMs = r.screen.durationMs
  }
  // Secondary assets are optional: drop them if they are empty/corrupt instead of failing the whole recording
  const tryNorm = async (asset: MediaAsset | undefined, kind: 'video' | 'audio', label: string): Promise<MediaAsset | undefined> => {
    if (!asset) return undefined
    try {
      return await normalizeAsset(id, asset, kind, (x) => onProgress?.(label, x))
    } catch (e) {
      console.warn(`[finalize] dropping ${label}:`, (e as Error).message)
      await fs.rm(join(p.dir, asset.file), { force: true }).catch(() => {})
      return undefined
    }
  }
  r.camera = await tryNorm(r.camera, 'video', 'Processing camera')
  r.mic = await tryNorm(r.mic, 'audio', 'Processing microphone')
  r.system = await tryNorm(r.system, 'audio', 'Processing system audio')
  // All recorders stop at the same instant, so tracks are aligned by their end.
  // A track that is shorter than the screen video therefore starts later.
  for (const a of [r.camera, r.mic, r.system]) {
    if (a?.durationMs && r.durationMs) a.offsetMs = Math.round(r.durationMs - a.durationMs)
  }
  // Convert absolute event timestamps to video-content time
  if (r.events && r.eventsAbsolute && r.stoppedAt) {
    try {
      const contentStart = r.stoppedAt - (r.pausedMs ?? 0) - r.durationMs
      const evPath = join(p.dir, r.events)
      const ev = JSON.parse(await fs.readFile(evPath, 'utf-8')) as { cursor: Array<{ t: number }>; clicks: Array<{ t: number }>; keys: Array<{ t: number }>; scrolls: Array<{ t: number }> }
      const conv = <T extends { t: number }>(arr: T[]): T[] => arr.map((e) => ({ ...e, t: Math.round(e.t - contentStart) })).filter((e) => e.t >= -100 && e.t <= r.durationMs + 500).sort((x, y) => x.t - y.t)
      const out = { cursor: conv(ev.cursor ?? []), clicks: conv(ev.clicks ?? []), keys: conv(ev.keys ?? []), scrolls: conv(ev.scrolls ?? []) }
      await fs.writeFile(evPath, JSON.stringify(out), 'utf-8')
      r.eventsAbsolute = false
    } catch (e) {
      console.warn('[finalize] event conversion failed', e)
    }
  }
  p.timeline = DEFAULT_TIMELINE(r.durationMs)
  // Remove raw files to save space
  for (const a of [r.screen, r.camera, r.mic, r.system]) {
    if (a?.raw && a.raw !== a.file) {
      await fs.rm(join(p.dir, a.raw), { force: true }).catch(() => {})
      delete a.raw
    }
  }
  return saveProject(p)
}

/** Import an existing video file as a new project. */
export async function importVideo(filePath: string, onProgress?: (label: string, p: number) => void): Promise<Project> {
  const info = await ffmpeg.probe(filePath)
  if (!info.hasVideo) throw new Error('File has no video stream')
  const id = newProjectId()
  const dir = projectDir(id)
  await ensureDir(dir)
  const ext = extname(filePath).toLowerCase()
  const isMp4 = ['.mp4', '.m4v', '.mov'].includes(ext)
  const isWebm = ['.webm', '.mkv'].includes(ext)
  let asset: MediaAsset
  if (info.codec === 'h264' && isMp4 && ext === '.mp4') {
    // Already ideal: copy as-is
    await fs.copyFile(filePath, join(dir, 'screen.mp4'))
    asset = { file: 'screen.mp4', width: info.width, height: info.height, durationMs: info.durationMs, hasAudio: info.hasAudio, codec: info.codec }
  } else if ((info.codec === 'h264' && isMp4) || (WEB_VIDEO.has(info.codec) && isWebm && info.codec !== 'h264')) {
    const out = info.codec === 'h264' ? 'screen.mp4' : 'screen.webm'
    await ffmpeg.run(
      ['-i', filePath, '-c:v', 'copy', ...(info.hasAudio ? (out.endsWith('mp4') ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy']) : ['-an']), ...(out.endsWith('mp4') ? ['-movflags', '+faststart'] : []), join(dir, out)],
      { durationMs: info.durationMs, onProgress: (p) => onProgress?.('Importing', p.progress) }
    )
    asset = { file: out, width: info.width, height: info.height, durationMs: info.durationMs, hasAudio: info.hasAudio, codec: info.codec }
  } else {
    await ffmpeg.run(
      ['-i', filePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), '-movflags', '+faststart', join(dir, 'screen.mp4')],
      { durationMs: info.durationMs, onProgress: (p) => onProgress?.('Transcoding', p.progress) }
    )
    const fi = await ffmpeg.probe(join(dir, 'screen.mp4'))
    asset = { file: 'screen.mp4', width: fi.width, height: fi.height, durationMs: fi.durationMs, hasAudio: fi.hasAudio, codec: 'h264' }
  }
  const recording: RecordingMeta = {
    mode: 'display',
    fps: info.fps ?? 30,
    durationMs: asset.durationMs ?? info.durationMs,
    width: asset.width ?? info.width,
    height: asset.height ?? info.height,
    screen: asset,
    eventsOffsetMs: 0,
    scaleFactor: 1,
    recordedAt: Date.now()
  }
  const now = Date.now()
  const project: Project = {
    id,
    name: safeName(basename(filePath, ext)),
    version: 1,
    createdAt: now,
    updatedAt: now,
    dir,
    recording,
    timeline: DEFAULT_TIMELINE(recording.durationMs),
    render: { ...DEFAULT_RENDER, ...getSettings().defaultRender, cursor: { ...DEFAULT_RENDER.cursor, mode: 'hidden' }, zoom: { ...DEFAULT_RENDER.zoom, autoEnabled: false } }
  }
  await saveProject(project)
  return project
}

// ── Montage: multiple media sources ─────────────────────────────────────────

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma', '.aiff', '.aif'])

/** Normalize a media file (video or image) into the project dir and return its asset. */
export async function ingestMedia(id: string, filePath: string, onProgress?: (label: string, p: number) => void): Promise<MediaAsset> {
  const dir = projectDir(id)
  await ensureDir(dir)
  const ext = extname(filePath).toLowerCase()
  const base = basename(filePath, ext).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 60) || 'media'
  const assetId = `m-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
  if (IMAGE_EXT.has(ext)) {
    const out = `${assetId}-${base}${ext === '.jpeg' ? '.jpg' : ext}`
    await fs.copyFile(filePath, join(dir, out))
    let width = 1920
    let height = 1080
    try {
      const info = await ffmpeg.probe(filePath)
      if (info.width) width = info.width
      if (info.height) height = info.height
    } catch {
      /* keep defaults */
    }
    return { id: assetId, kind: 'image', name: basename(filePath), file: out, width, height, durationMs: 4000, hasAudio: false }
  }
  const info = await ffmpeg.probe(filePath)
  if (AUDIO_EXT.has(ext) || (!info.hasVideo && info.hasAudio)) {
    // Audio-only asset → keep web-playable formats, transcode the rest to AAC
    let out: string
    if (['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac'].includes(ext) && ext !== '.aiff') {
      out = `${assetId}-${base}${ext}`
      await fs.copyFile(filePath, join(dir, out))
    } else {
      out = `${assetId}-${base}.m4a`
      await ffmpeg.run(['-i', filePath, '-vn', '-c:a', 'aac', '-b:a', '192k', join(dir, out)], { durationMs: info.durationMs, onProgress: (p) => onProgress?.(`Importing ${basename(filePath)}`, p.progress) })
    }
    return { id: assetId, kind: 'audio', name: basename(filePath), file: out, durationMs: info.durationMs, hasAudio: true, codec: info.audioCodec }
  }
  if (!info.hasVideo) throw new Error(`${basename(filePath)} has no video stream`)
  const isMp4 = ['.mp4', '.m4v', '.mov'].includes(ext)
  let out: string
  if (info.codec === 'h264' && ext === '.mp4') {
    out = `${assetId}-${base}.mp4`
    await fs.copyFile(filePath, join(dir, out))
  } else if (info.codec === 'h264' && isMp4) {
    out = `${assetId}-${base}.mp4`
    await ffmpeg.run(['-i', filePath, '-c:v', 'copy', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), '-movflags', '+faststart', join(dir, out)], {
      durationMs: info.durationMs,
      onProgress: (p) => onProgress?.(`Importing ${basename(filePath)}`, p.progress)
    })
  } else {
    out = `${assetId}-${base}.mp4`
    await ffmpeg.run(
      ['-i', filePath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']), '-movflags', '+faststart', join(dir, out)],
      { durationMs: info.durationMs, onProgress: (p) => onProgress?.(`Converting ${basename(filePath)}`, p.progress) }
    )
  }
  const fi = await ffmpeg.probe(join(dir, out))
  return { id: assetId, kind: 'video', name: basename(filePath), file: out, width: fi.width, height: fi.height, durationMs: fi.durationMs, hasAudio: fi.hasAudio, codec: fi.codec }
}

/** Create a montage project from several media files. */
export async function createMontage(files: string[], onProgress?: (label: string, p: number) => void): Promise<Project> {
  if (files.length === 0) throw new Error('No files')
  const id = newProjectId()
  const dir = projectDir(id)
  await ensureDir(dir)
  const media: MediaAsset[] = []
  for (let i = 0; i < files.length; i++) {
    media.push(await ingestMedia(id, files[i], (label, p) => onProgress?.(`${label} (${i + 1}/${files.length})`, p)))
  }
  const first = media.find((m) => m.kind === 'video') ?? media[0]
  const recording: RecordingMeta = {
    mode: 'montage',
    fps: 30,
    durationMs: 0,
    width: first.width ?? 1920,
    height: first.height ?? 1080,
    media,
    eventsOffsetMs: 0,
    scaleFactor: 1,
    recordedAt: Date.now()
  }
  const now = Date.now()
  const timeline = DEFAULT_TIMELINE(0)
  timeline.clips = media.map((m, i) => ({
    id: `clip-${i + 1}`,
    sourceId: m.id,
    sourceStart: 0,
    sourceEnd: m.durationMs ?? 4000,
    speed: 1,
    fit: 'cover' as const,
    transitionIn: i > 0 ? { type: 'fade' as const, durationMs: 500 } : undefined
  }))
  recording.durationMs = timeline.clips.reduce((a, c) => a + (c.sourceEnd - c.sourceStart), 0)
  const project: Project = {
    id,
    name: safeName(basename(files[0], extname(files[0]))) + (files.length > 1 ? ` +${files.length - 1}` : ''),
    version: 1,
    createdAt: now,
    updatedAt: now,
    dir,
    recording,
    timeline,
    render: {
      ...DEFAULT_RENDER,
      ...getSettings().defaultRender,
      aspect: '16:9',
      padding: 0,
      cornerRadius: 0,
      shadow: { ...DEFAULT_RENDER.shadow, enabled: false },
      background: { type: 'color', color: '#000000' },
      cursor: { ...DEFAULT_RENDER.cursor, mode: 'hidden' },
      zoom: { ...DEFAULT_RENDER.zoom, autoEnabled: false },
      keystrokes: { ...DEFAULT_RENDER.keystrokes, enabled: false },
      camera: { ...DEFAULT_RENDER.camera, enabled: false }
    }
  }
  await saveProject(project)
  return project
}

/** Add media files to an existing project; returns the new assets (project.json is NOT modified). */
export async function addMedia(id: string, files: string[], onProgress?: (label: string, p: number) => void): Promise<MediaAsset[]> {
  const out: MediaAsset[] = []
  for (let i = 0; i < files.length; i++) out.push(await ingestMedia(id, files[i], (label, p) => onProgress?.(`${label} (${i + 1}/${files.length})`, p)))
  return out
}

/** Copy an arbitrary file (music, background image) into the project. */
export async function importAsset(id: string, filePath: string): Promise<string> {
  const dir = projectDir(id)
  await ensureDir(dir)
  const name = `${Date.now()}-${basename(filePath)}`
  await fs.copyFile(filePath, join(dir, name))
  return name
}
