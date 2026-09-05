import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/** Locate the bundled ffmpeg binary (works in dev and packaged builds). */
export function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  let p: string = require('ffmpeg-static')
  if (app.isPackaged) {
    p = p.replace('app.asar', 'app.asar.unpacked')
  }
  if (!existsSync(p)) {
    const alt = join(process.resourcesPath ?? '', 'ffmpeg.exe')
    if (existsSync(alt)) return alt
  }
  return p
}

export interface ProbeResult {
  durationMs: number
  width: number
  height: number
  hasAudio: boolean
  hasVideo: boolean
  codec: string
  audioCodec?: string
  fps?: number
}

const jobs = new Map<string, ChildProcess>()

function parseTime(s: string): number {
  const m = s.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return 0
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
}

/** Probe a media file by reading ffmpeg's stderr header. */
export async function probe(file: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-i', file, '-f', 'null', '-t', '0.01', '-'], {
      windowsHide: true
    })
    let err = ''
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', () => {
      const dur = err.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/)
      const video = err.match(/Video:\s*([a-zA-Z0-9_]+).*?,\s*(\d{2,5})x(\d{2,5})/s)
      const audio = err.match(/Audio:\s*([a-zA-Z0-9_]+)/)
      const fps = err.match(/(\d+(?:\.\d+)?)\s*fps/)
      const res: ProbeResult = {
        durationMs: dur && dur[1] !== 'N/A' ? parseTime(dur[1]) : 0,
        width: video ? Number(video[2]) : 0,
        height: video ? Number(video[3]) : 0,
        hasAudio: !!audio,
        hasVideo: !!video,
        codec: video ? video[1] : '',
        audioCodec: audio ? audio[1] : undefined,
        fps: fps ? Number(fps[1]) : undefined
      }
      if (!res.hasVideo && !res.hasAudio) {
        reject(new Error('Could not read media file: ' + err.split('\n').slice(-3).join(' ')))
      } else resolve(res)
    })
  })
}

export interface RunOptions {
  jobId?: string
  durationMs?: number
  onProgress?: (p: { progress: number; timeMs: number; speed?: string; fps?: number }) => void
  onLog?: (line: string) => void
}

/** Run ffmpeg with progress reporting. Resolves when done, rejects on error. */
export function run(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-loglevel', 'error', ...args]
    const proc = spawn(ffmpegPath(), full, { windowsHide: true })
    if (opts.jobId) jobs.set(opts.jobId, proc)
    let errBuf = ''
    let timeMs = 0
    let speed: string | undefined
    let fps: number | undefined
    proc.stdout.on('data', (d) => {
      const lines = d.toString().split(/\r?\n/)
      for (const line of lines) {
        const [k, v] = line.split('=')
        if (k === 'out_time_ms' || k === 'out_time_us') timeMs = Number(v) / 1000
        else if (k === 'out_time') timeMs = parseTime(v)
        else if (k === 'speed') speed = v.trim()
        else if (k === 'fps') fps = Number(v)
        else if (k === 'progress') {
          const progress = opts.durationMs ? Math.min(1, Math.max(0, timeMs / opts.durationMs)) : 0
          opts.onProgress?.({ progress, timeMs, speed, fps })
        }
      }
    })
    proc.stderr.on('data', (d) => {
      const s = d.toString()
      errBuf += s
      opts.onLog?.(s)
    })
    proc.on('error', (e) => {
      if (opts.jobId) jobs.delete(opts.jobId)
      reject(e)
    })
    proc.on('close', (code, signal) => {
      if (opts.jobId) jobs.delete(opts.jobId)
      if (code === 0) resolve()
      else if (signal || code === null) reject(new Error('cancelled'))
      else reject(new Error(errBuf.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with ${code}`))
    })
  })
}

export function cancel(jobId: string): boolean {
  const p = jobs.get(jobId)
  if (!p) return false
  p.kill('SIGKILL')
  jobs.delete(jobId)
  return true
}

export function cancelAll(): void {
  for (const [, p] of jobs) p.kill('SIGKILL')
  jobs.clear()
}
