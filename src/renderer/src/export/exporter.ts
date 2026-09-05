import {
  Input,
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  WavOutputFormat,
  StreamTarget,
  CanvasSource,
  AudioBufferSource,
  VideoSampleSink,
  canEncodeVideo,
  canEncodeAudio,
  type VideoCodec,
  type AudioCodec,
  type VideoSample
} from 'mediabunny'
import type { ExportOptions, ExportProgress, Project, RecordingEvents } from '@shared/types'
import { Compositor, type FrameSource } from '@/engine/compositor'
import { outputSize } from '@/engine/layout'
import { timelineDuration, timelineToSource } from '@/engine/timeline'
import { mixdown, mixSourcesFor, openInput } from '@/engine/audio'
import { ensureImage } from '@/engine/background'
import { fw, projectMediaUrl } from '@/lib/fw'
import { uid } from '@/lib/utils'

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

function bitrateFor(q: ExportOptions['quality'], w: number, h: number, fps: number): number {
  const px = (w * h) / (1920 * 1080)
  const base = q === 'draft' ? 3.5e6 : q === 'good' ? 9e6 : q === 'high' ? 18e6 : 45e6
  return Math.round(base * Math.max(0.3, px) * (fps > 30 ? 1.3 : 1))
}

async function pickVideoCodec(pref: ExportOptions['codec'] | undefined, container: 'mp4' | 'webm', w: number, h: number, bitrate: number): Promise<VideoCodec> {
  const order: VideoCodec[] = container === 'webm' ? ['vp9', 'av1', 'vp8'] : pref === 'h265' ? ['hevc', 'avc'] : pref === 'av1' ? ['av1', 'avc'] : pref === 'vp9' ? ['vp9', 'avc'] : ['avc', 'hevc']
  for (const c of order) {
    try {
      if (await canEncodeVideo(c, { width: w, height: h, bitrate })) return c
    } catch {
      /* try next */
    }
  }
  return container === 'webm' ? 'vp9' : 'avc'
}

async function pickAudioCodec(container: 'mp4' | 'webm'): Promise<AudioCodec | null> {
  const order: AudioCodec[] = container === 'webm' ? ['opus'] : ['aac', 'opus']
  for (const c of order) {
    try {
      if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 })) return c
    } catch {
      /* next */
    }
  }
  return null
}

/** Writable stream that forwards positioned chunks to the main process. */
function fileWritable(key: string): WritableStream<{ type: 'write'; data: Uint8Array; position: number }> {
  return new WritableStream({
    async write(chunk) {
      await fw.file.write(key, chunk.data, chunk.position)
    }
  })
}

/**
 * Sequential frame reader. Random `getSample()` calls force a decode from the
 * previous keyframe every time, which is extremely slow; instead we walk the
 * decoded sample stream forward and only restart on seeks/large jumps.
 */
class FrameFeeder {
  private sink: VideoSampleSink
  private last: VideoSample | null = null
  private lastTs = -1
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null
  private current: VideoSample | null = null
  private next: VideoSample | null = null
  private exhausted = false
  constructor(
    private input: Input,
    sink: VideoSampleSink,
    public width: number,
    public height: number,
    public offsetMs: number,
    public durationSec: number
  ) {
    this.sink = sink
  }
  static async open(url: string, offsetMs: number): Promise<FrameFeeder | null> {
    const input = await openInput(url)
    const track = await input.getPrimaryVideoTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose?.()
      return null
    }
    const dur = await track.computeDuration()
    return new FrameFeeder(input, new VideoSampleSink(track), track.displayWidth, track.displayHeight, offsetMs, dur)
  }
  private async restart(ts: number): Promise<void> {
    await this.iter?.return()
    this.current?.close()
    this.next?.close()
    this.current = null
    this.next = null
    this.exhausted = false
    this.iter = this.sink.samples(Math.max(0, ts))
    const first = await this.iter.next()
    if (first.done || !first.value) {
      this.exhausted = true
      return
    }
    this.current = first.value
    const second = await this.iter.next()
    if (second.done || !second.value) this.exhausted = true
    else this.next = second.value
  }

  private async advance(): Promise<void> {
    if (!this.iter || this.exhausted) {
      // no more frames: keep current as the last frame
      if (this.next) {
        this.current?.close()
        this.current = this.next
        this.next = null
      }
      return
    }
    this.current?.close()
    this.current = this.next
    const n = await this.iter.next()
    if (n.done || !n.value) {
      this.exhausted = true
      this.next = null
    } else this.next = n.value
  }

  /** Get the frame for source time (ms). Sequential access is fast; seeks restart the decoder. */
  async frameAt(sourceMs: number): Promise<FrameSource | null> {
    const sec = (sourceMs - this.offsetMs) / 1000
    if (sec < -0.05 || sec > this.durationSec + 0.05) return null
    const ts = Math.max(0, sec)
    if (this.last && Math.abs(ts - this.lastTs) < 0.0005) return { image: this.last.toCanvasImageSource(), width: this.width, height: this.height }
    this.lastTs = ts
    // (Re)start when we have nothing, when seeking backwards, or when jumping far ahead
    if (!this.current || ts < this.current.timestamp - 0.001 || ts > this.current.timestamp + 3) {
      await this.restart(ts)
    }
    // Walk forward until current <= ts < next
    let guard = 0
    while (this.next && this.next.timestamp <= ts && guard++ < 10000) await this.advance()
    if (!this.current) return this.last ? { image: this.last.toCanvasImageSource(), width: this.width, height: this.height } : null
    this.last = this.current
    return { image: this.current.toCanvasImageSource(), width: this.width, height: this.height }
  }
  close(): void {
    void this.iter?.return()
    this.current?.close()
    this.next?.close()
    this.current = null
    this.next = null
    this.last = null
    this.input.dispose?.()
  }
}

export async function exportProject(
  project: Project,
  events: RecordingEvents | null,
  options: ExportOptions,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const check = (): void => {
    if (signal?.aborted) throw new ExportCancelled()
  }
  onProgress({ phase: 'preparing', progress: 0, message: 'Preparing…' })

  const total = timelineDuration(project.timeline)
  const range = options.range ?? { start: 0, end: total }
  const durMs = Math.max(1, range.end - range.start)
  const fps = options.fps
  const frameDur = 1000 / fps
  const totalFrames = Math.max(1, Math.round(durMs / frameDur))

  // Output size
  const rec = project.recording
  const size = outputSize(project.render, rec.width || 1920, rec.height || 1080, options.height)
  // Ensure even dimensions
  size.width = Math.round(size.width / 2) * 2
  size.height = Math.round(size.height / 2) * 2

  // Audio-only export
  if (options.format === 'mp3') return exportAudioOnly(project, options, range, onProgress, signal)

  // PNG sequence / GIF / MP4 / WebM all render frames
  const isGif = options.format === 'gif'
  const isPng = options.format === 'png-sequence'
  const container: 'mp4' | 'webm' = options.format === 'webm' ? 'webm' : 'mp4'
  const tmpPath = isGif ? await fw.file.tempPath(`gif-src-${uid()}.mp4`) : `${options.outPath}.tmp.${container}`
  const includeAudio = options.includeAudio && !isGif && !isPng

  // Sources
  if (project.render.background.type === 'image') await ensureImage(project.render.background.src)
  const screenFeeder = rec.screen ? await FrameFeeder.open(projectMediaUrl(project.dir, rec.screen.file), 0) : null
  const cameraFeeder = rec.camera && project.render.camera.enabled ? await FrameFeeder.open(projectMediaUrl(project.dir, rec.camera.file), rec.camera.offsetMs ?? 0) : null

  const compositor = new Compositor(project, events)
  compositor.resetMotion()
  const canvas = new OffscreenCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d', { alpha: options.format === 'webm' && project.render.background.type === 'transparent' })!

  // Audio mixdown first (so we can interleave)
  let audioBuffer: AudioBuffer | null = null
  if (includeAudio) {
    onProgress({ phase: 'encoding-audio', progress: 0, message: 'Mixing audio…' })
    audioBuffer = await mixdown(project, mixSourcesFor(project), range, 48000, (p) => onProgress({ phase: 'encoding-audio', progress: p, message: 'Mixing audio…' }))
    check()
  }

  let fileKey: string | null = null
  let output: Output | null = null
  const cleanup = async (): Promise<void> => {
    screenFeeder?.close()
    cameraFeeder?.close()
    if (fileKey) await fw.file.close(fileKey).catch(() => {})
  }

  try {
    if (isPng) {
      // PNG sequence: outPath is a folder prefix
      const base = options.outPath.replace(/\.png$/i, '')
      const t0 = performance.now()
      for (let i = 0; i < totalFrames; i++) {
        check()
        const t = range.start + i * frameDur
        const s = timelineToSource(project.timeline, t)
        const screen = screenFeeder ? await screenFeeder.frameAt(s) : null
        const camera = cameraFeeder ? await cameraFeeder.frameAt(s) : null
        compositor.renderFrame(ctx as unknown as CanvasRenderingContext2D, t, { screen, camera })
        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const key = await fw.file.open(`${base}_${String(i + 1).padStart(5, '0')}.png`)
        await fw.file.write(key, new Uint8Array(await blob.arrayBuffer()), 0)
        await fw.file.close(key)
        report(i, t0)
      }
      await cleanup()
      onProgress({ phase: 'done', progress: 1, outPath: base })
      return base
    }

    // ── Video output ─────────────────────────────────────────────────────
    const bitrate = isGif ? bitrateFor('high', size.width, size.height, fps) : bitrateFor(options.quality, size.width, size.height, fps)
    const codec = await pickVideoCodec(options.codec, container, size.width, size.height, bitrate)
    fileKey = await fw.file.open(tmpPath)
    const target = new StreamTarget(fileWritable(fileKey), { chunked: true, chunkSize: 8 * 1024 * 1024 })
    const format = container === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: false })
    output = new Output({ format, target })
    const videoSource = new CanvasSource(canvas, {
      codec,
      bitrate,
      keyFrameInterval: 2,
      latencyMode: 'quality',
      hardwareAcceleration: options.hwAccel ? 'prefer-hardware' : 'prefer-software'
    })
    output.addVideoTrack(videoSource, { frameRate: fps })

    let audioSource: AudioBufferSource | null = null
    let audioCodec: AudioCodec | null = null
    if (audioBuffer) {
      audioCodec = await pickAudioCodec(container)
      if (audioCodec) {
        audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 192000 })
        output.addAudioTrack(audioSource)
      }
    }
    await output.start()

    // Slice audio into 1s pieces so we can interleave with the video
    const audioSlices: AudioBuffer[] = []
    if (audioBuffer && audioSource) {
      const sr = audioBuffer.sampleRate
      const sliceLen = sr
      for (let off = 0; off < audioBuffer.length; off += sliceLen) {
        const len = Math.min(sliceLen, audioBuffer.length - off)
        const slice = new AudioBuffer({ numberOfChannels: audioBuffer.numberOfChannels, length: len, sampleRate: sr })
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
          const data = new Float32Array(len)
          audioBuffer.copyFromChannel(data, c, off)
          slice.copyToChannel(data, c)
        }
        audioSlices.push(slice)
      }
    }
    let audioFed = 0

    const t0 = performance.now()
    const prof = { decode: 0, render: 0, encode: 0 }

    for (let i = 0; i < totalFrames; i++) {
      check()
      const t = range.start + i * frameDur
      const s = timelineToSource(project.timeline, t)
      const pa = performance.now()
      const screen = screenFeeder ? await screenFeeder.frameAt(s) : null
      const camera = cameraFeeder ? await cameraFeeder.frameAt(s) : null
      const pb = performance.now()
      compositor.renderFrame(ctx as unknown as CanvasRenderingContext2D, t, { screen, camera })
      const pc = performance.now()
      await videoSource.add((i * frameDur) / 1000, frameDur / 1000)
      const pd = performance.now()
      prof.decode += pb - pa
      prof.render += pc - pb
      prof.encode += pd - pc
      // Interleave audio: feed slices up to current time + 1s
      while (audioSource && audioFed < audioSlices.length && audioFed <= Math.floor((i * frameDur) / 1000) + 1) {
        await audioSource.add(audioSlices[audioFed++])
      }
      if (i % 3 === 0) report(i, t0)
    }
    while (audioSource && audioFed < audioSlices.length) await audioSource.add(audioSlices[audioFed++])

    if (import.meta.env.DEV) console.warn(`[export] frames=${totalFrames} decode=${prof.decode.toFixed(0)}ms render=${prof.render.toFixed(0)}ms encode=${prof.encode.toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`)
    onProgress({ phase: 'finalizing', progress: 0.98, message: 'Finalizing…' })
    videoSource.close()
    audioSource?.close()
    await output.finalize()
    await fw.file.close(fileKey)
    fileKey = null
    screenFeeder?.close()
    cameraFeeder?.close()

    // ── Post-processing ──────────────────────────────────────────────────
    if (isGif) {
      const g = options.gif ?? { loop: true, colors: 256, dither: true }
      const gifFps = Math.min(fps, 30)
      const jobId = uid('ffmpeg')
      const unsub = fw.ffmpeg.onProgress((p) => p.jobId === jobId && onProgress({ phase: 'finalizing', progress: p.progress, message: 'Encoding GIF…' }))
      const dither = g.dither ? 'dither=bayer:bayer_scale=4' : 'dither=none'
      const filter = `fps=${gifFps},scale=${size.width}:${size.height}:flags=lanczos,split[a][b];[a]palettegen=max_colors=${g.colors}:stats_mode=diff[p];[b][p]paletteuse=${dither}:diff_mode=rectangle`
      try {
        await fw.ffmpeg.run(jobId, { args: ['-i', tmpPath, '-vf', filter, '-loop', g.loop ? '0' : '-1', options.outPath], durationMs: durMs })
      } finally {
        unsub()
        await fw.file.delete(tmpPath).catch(() => {})
      }
    } else if (container === 'mp4') {
      // Faststart remux for streaming-friendly files
      onProgress({ phase: 'finalizing', progress: 0.99, message: 'Optimizing file…' })
      const jobId = uid('ffmpeg')
      try {
        await fw.ffmpeg.run(jobId, { args: ['-i', tmpPath, '-c', 'copy', '-movflags', '+faststart', options.outPath], durationMs: durMs })
        await fw.file.delete(tmpPath).catch(() => {})
      } catch (e) {
        console.warn('faststart remux failed, keeping original', e)
        await fw.file.move(tmpPath, options.outPath)
      }
    } else {
      await fw.file.move(tmpPath, options.outPath)
    }
    check()
    onProgress({ phase: 'done', progress: 1, outPath: options.outPath })
    return options.outPath
  } catch (e) {
    try {
      await output?.cancel()
    } catch {
      /* ignore */
    }
    await cleanup()
    await fw.file.delete(tmpPath).catch(() => {})
    if (e instanceof ExportCancelled || signal?.aborted) {
      onProgress({ phase: 'cancelled', progress: 0 })
      throw new ExportCancelled()
    }
    onProgress({ phase: 'error', progress: 0, message: (e as Error).message })
    throw e
  }

  function report(i: number, start: number): void {
    const elapsed = performance.now() - start
    const rate = (i + 1) / Math.max(1, elapsed / 1000)
    onProgress({ phase: 'rendering', progress: (i + 1) / totalFrames, frame: i + 1, totalFrames, fps: rate, etaMs: ((totalFrames - i - 1) / Math.max(0.1, rate)) * 1000 })
  }
}

async function exportAudioOnly(project: Project, options: ExportOptions, range: { start: number; end: number }, onProgress: (p: ExportProgress) => void, signal?: AbortSignal): Promise<string> {
  onProgress({ phase: 'encoding-audio', progress: 0, message: 'Mixing audio…' })
  const buffer = await mixdown(project, mixSourcesFor(project), range, 48000, (p) => onProgress({ phase: 'encoding-audio', progress: p * 0.7, message: 'Mixing audio…' }))
  if (!buffer) throw new Error('No audio to export')
  if (signal?.aborted) throw new ExportCancelled()
  const wavPath = await fw.file.tempPath(`mix-${uid()}.wav`)
  const key = await fw.file.open(wavPath)
  const output = new Output({ format: new WavOutputFormat(), target: new StreamTarget(fileWritable(key), { chunked: true }) })
  const src = new AudioBufferSource({ codec: 'pcm-s16', bitrate: 0 })
  output.addAudioTrack(src)
  await output.start()
  await src.add(buffer)
  src.close()
  await output.finalize()
  await fw.file.close(key)
  onProgress({ phase: 'finalizing', progress: 0.8, message: 'Encoding MP3…' })
  const jobId = uid('ffmpeg')
  try {
    await fw.ffmpeg.run(jobId, { args: ['-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '2', options.outPath], durationMs: range.end - range.start })
  } finally {
    await fw.file.delete(wavPath).catch(() => {})
  }
  onProgress({ phase: 'done', progress: 1, outPath: options.outPath })
  return options.outPath
}

/** Render a single frame to a JPEG data URL (thumbnails). */
export async function renderThumbnail(project: Project, events: RecordingEvents | null, t: number, width = 640): Promise<Blob | null> {
  const rec = project.recording
  if (!rec.screen) return null
  const size = outputSize(project.render, rec.width || 1920, rec.height || 1080, 1080)
  const h = Math.round((width * size.height) / size.width)
  const feeder = await FrameFeeder.open(projectMediaUrl(project.dir, rec.screen.file), 0)
  if (!feeder) return null
  const camFeeder = rec.camera && project.render.camera.enabled ? await FrameFeeder.open(projectMediaUrl(project.dir, rec.camera.file), rec.camera.offsetMs ?? 0) : null
  try {
    if (project.render.background.type === 'image') await ensureImage(project.render.background.src)
    const canvas = new OffscreenCanvas(width, h)
    const ctx = canvas.getContext('2d')!
    const comp = new Compositor(project, events)
    const s = timelineToSource(project.timeline, t)
    const screen = await feeder.frameAt(s)
    const camera = camFeeder ? await camFeeder.frameAt(s) : null
    comp.renderFrame(ctx as unknown as CanvasRenderingContext2D, t, { screen, camera })
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  } finally {
    feeder.close()
    camFeeder?.close()
  }
}
