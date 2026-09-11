import type { RecordingOptions, RecordingMeta, RecordingEvents, HudState, HudCommand, Project, DisplayInfo, CaptureSource } from '@shared/types'
import { fw } from '@/lib/fw'

export type RecorderStatus = 'idle' | 'preparing' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'processing' | 'error'

export interface RecorderSnapshot {
  status: RecorderStatus
  elapsedMs: number
  countdown: number
  micLevel: number
  micEnabled: boolean
  cameraEnabled: boolean
  processing?: { label: string; progress: number }
  error?: string
}

type Listener = (s: RecorderSnapshot) => void

interface Rec {
  name: 'screen' | 'camera' | 'mic' | 'system'
  recorder: MediaRecorder
  key: string
  file: string
  startEpoch: number
  bytes: number
  stopped: Promise<void>
  error?: string
}

function pickMime(kind: 'video' | 'audio'): string {
  const candidates =
    kind === 'video'
      ? ['video/webm;codecs=h264', 'video/x-matroska;codecs=avc1', 'video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c
  return ''
}

function extFor(mime: string): string {
  if (mime.startsWith('video/mp4') || mime.startsWith('audio/mp4')) return 'mp4'
  if (mime.includes('matroska')) return 'mkv'
  return 'webm'
}

function bitrateFor(q: RecordingOptions['quality'], w: number, h: number, fps: number): number {
  const base = q === 'ultra' ? 30e6 : q === 'high' ? 16e6 : 8e6
  const pixelScale = Math.max(0.35, (w * h) / (1920 * 1080))
  return Math.round(base * pixelScale * (fps >= 60 ? 1.35 : 1))
}

export class RecorderEngine {
  snapshot: RecorderSnapshot = { status: 'idle', elapsedMs: 0, countdown: 0, micLevel: 0, micEnabled: true, cameraEnabled: false }
  private listeners = new Set<Listener>()
  private opts: RecordingOptions | null = null
  private streams: MediaStream[] = []
  private recs: Rec[] = []
  private projectId: string | null = null
  private startEpoch = 0
  private pauses: Array<{ start: number; end: number }> = []
  private pauseStart = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  private analyser: AnalyserNode | null = null
  private audioCtx: AudioContext | null = null
  private unsubHud: (() => void) | null = null
  private cancelled = false
  private countdownTimer: ReturnType<typeof setTimeout> | null = null
  private videoSize = { width: 0, height: 0 }
  private cameraSize = { width: 0, height: 0 }
  private micTrack: MediaStreamTrack | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private display: DisplayInfo | null = null
  private source: CaptureSource | null = null
  /** macOS: system audio captured by the native ScreenCaptureKit helper (see main/sysaudio.ts) */
  private useSysHelper = false
  onDone: ((project: Project) => void) | null = null
  onCancelled: (() => void) | null = null

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    l(this.snapshot)
    return () => this.listeners.delete(l)
  }

  private emit(patch: Partial<RecorderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const l of this.listeners) l(this.snapshot)
    if (['countdown', 'recording', 'paused', 'stopping'].includes(this.snapshot.status)) {
      const hs: HudState = {
        status: this.snapshot.status === 'countdown' ? 'countdown' : this.snapshot.status === 'paused' ? 'paused' : this.snapshot.status === 'stopping' ? 'stopping' : 'recording',
        countdown: this.snapshot.countdown,
        elapsedMs: this.snapshot.elapsedMs,
        micLevel: this.snapshot.micLevel,
        micEnabled: this.snapshot.micEnabled,
        cameraEnabled: this.snapshot.cameraEnabled
      }
      fw.hud.setState(hs)
    }
  }

  get active(): boolean {
    return !['idle', 'error'].includes(this.snapshot.status)
  }

  async start(opts: RecordingOptions, source: CaptureSource, display: DisplayInfo | null): Promise<void> {
    if (this.active) return
    this.opts = opts
    this.source = source
    this.display = display
    this.cancelled = false
    this.pauses = []
    this.recs = []
    this.streams = []
    this.emit({ status: 'preparing', elapsedMs: 0, micEnabled: !!opts.micDeviceId, cameraEnabled: !!opts.cameraDeviceId, error: undefined })

    try {
      // ── Acquire streams ────────────────────────────────────────────────
      await fw.capture.pick(opts.sourceId, opts.systemAudio)
      // Note: do not pass width/height constraints — Chromium would *upscale* the
      // capture to the given max. Native resolution is what we want.
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: opts.fps, max: opts.fps } },
        audio: opts.systemAudio
      })
      this.streams.push(displayStream)
      const vTrack = displayStream.getVideoTracks()[0]
      const vs = vTrack.getSettings()
      this.videoSize = { width: vs.width ?? 1920, height: vs.height ?? 1080 }
      vTrack.addEventListener('ended', () => {
        if (this.snapshot.status === 'recording' || this.snapshot.status === 'paused') void this.stop()
      })
      const sysTracks = displayStream.getAudioTracks()
      // macOS: Chromium has no loopback capture → use the bundled ScreenCaptureKit helper
      this.useSysHelper = opts.systemAudio && sysTracks.length === 0 && fw.platform === 'darwin' && (await fw.sysaudio.available().catch(() => false))

      let cameraStream: MediaStream | null = null
      if (opts.cameraDeviceId) {
        try {
          cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: opts.cameraDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
          })
          this.streams.push(cameraStream)
          this.cameraTrack = cameraStream.getVideoTracks()[0]
          const cs = this.cameraTrack.getSettings()
          this.cameraSize = { width: cs.width ?? 1280, height: cs.height ?? 720 }
        } catch (e) {
          console.warn('camera unavailable', e)
          this.emit({ cameraEnabled: false })
        }
      }
      let micStream: MediaStream | null = null
      if (opts.micDeviceId) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: opts.micDeviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 }
          })
          this.streams.push(micStream)
          this.micTrack = micStream.getAudioTracks()[0]
          this.setupMeter(micStream)
        } catch (e) {
          console.warn('mic unavailable', e)
          this.emit({ micEnabled: false })
        }
      }

      // ── Project ────────────────────────────────────────────────────────
      const now = new Date()
      const pad = (n: number): string => String(n).padStart(2, '0')
      const name = `Recording ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${pad(now.getHours())}h${pad(now.getMinutes())}`
      const meta: RecordingMeta = {
        mode: opts.mode,
        fps: opts.fps,
        durationMs: 0,
        width: this.videoSize.width,
        height: this.videoSize.height,
        eventsOffsetMs: 0,
        scaleFactor: display?.scaleFactor ?? 1,
        displayBounds: display?.bounds,
        recordedAt: Date.now()
      }
      const project = await fw.projects.create(name, meta)
      this.projectId = project.id

      // ── Recorders ──────────────────────────────────────────────────────
      const vMime = pickMime('video')
      const aMime = pickMime('audio')
      const vbr = bitrateFor(opts.quality, this.videoSize.width, this.videoSize.height, opts.fps)
      await this.addRec('screen', new MediaStream([vTrack]), vMime, `screen.${extFor(vMime)}`, { videoBitsPerSecond: vbr })
      if (cameraStream) await this.addRec('camera', new MediaStream([this.cameraTrack!]), vMime, `camera.${extFor(vMime)}`, { videoBitsPerSecond: 6e6 })
      if (micStream) await this.addRec('mic', new MediaStream([this.micTrack!]), aMime, `mic.${extFor(aMime)}`, { audioBitsPerSecond: 192000 })
      if (sysTracks.length) await this.addRec('system', new MediaStream([sysTracks[0]]), aMime, `system.${extFor(aMime)}`, { audioBitsPerSecond: 192000 })

      // ── HUD + countdown ────────────────────────────────────────────────
      await fw.hud.show(display?.id)
      if (opts.cameraDeviceId && this.cameraTrack) await fw.hud.cameraBubble(opts.cameraDeviceId, display?.id)
      this.unsubHud = fw.hud.onCommand((c) => this.handleCommand(c))
      fw.window.hide()

      if (opts.countdown > 0) {
        this.emit({ status: 'countdown', countdown: opts.countdown })
        await new Promise<void>((resolve) => {
          let n = opts.countdown
          const step = (): void => {
            if (this.cancelled) return resolve()
            n--
            if (n <= 0) return resolve()
            this.emit({ countdown: n })
            this.countdownTimer = setTimeout(step, 1000)
          }
          this.countdownTimer = setTimeout(step, 1000)
        })
        if (this.cancelled) return
      }

      // ── Go ─────────────────────────────────────────────────────────────
      if (opts.cursorCapture) {
        const hwnd = source.kind === 'window' ? Number(source.id.split(':')[1]) : undefined
        await fw.tracker.start({ kind: source.kind === 'window' ? 'window' : 'display', displayId: display?.id, hwnd, hideCursor: opts.hideSystemCursor !== false })
      }
      if (this.useSysHelper) {
        try {
          await fw.sysaudio.start(project.id, 'system.wav')
        } catch (e) {
          console.warn('system audio helper failed, continuing without system audio', e)
          this.useSysHelper = false
        }
      }
      const startPromises = this.recs.map(
        (r) =>
          new Promise<number>((resolve) => {
            r.recorder.addEventListener('start', () => resolve(Date.now()), { once: true })
          })
      )
      for (const r of this.recs) r.recorder.start(1000)
      const starts = await Promise.all(startPromises)
      this.recs.forEach((r, i) => (r.startEpoch = starts[i]))
      this.startEpoch = this.recs[0].startEpoch
      this.emit({ status: 'recording', elapsedMs: 0 })
      this.ticker = setInterval(() => this.tick(), 100)
    } catch (e) {
      console.error('recording failed', e)
      await this.teardown()
      if (this.projectId) await fw.projects.delete(this.projectId).catch(() => {})
      this.projectId = null
      fw.window.show()
      this.emit({ status: 'error', error: (e as Error).message || String(e) })
      setTimeout(() => this.emit({ status: 'idle' }), 100)
    }
  }

  private async addRec(name: Rec['name'], stream: MediaStream, mime: string, file: string, bits: MediaRecorderOptions): Promise<void> {
    const recorder = new MediaRecorder(stream, { mimeType: mime || undefined, ...bits })
    const key = await fw.projects.openStream(this.projectId!, file)
    const rec: Rec = { name, recorder, key, file, startEpoch: 0, bytes: 0, stopped: Promise.resolve() }
    let chain = Promise.resolve()
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return
      rec.bytes += e.data.size
      chain = chain.then(async () => {
        const buf = new Uint8Array(await e.data.arrayBuffer())
        await fw.projects.writeChunk(key, buf)
      })
    }
    rec.stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => {
        chain.then(() => fw.projects.closeStream(key)).then(resolve, resolve)
      }
    })
    recorder.onerror = (e) => {
      const msg = (e as unknown as { error?: Error }).error?.message ?? 'MediaRecorder error'
      console.error(`[rec:${name}]`, msg)
      rec.error = msg
      if (name === 'screen') this.emit({ error: `Screen encoder failed: ${msg}` })
    }
    this.recs.push(rec)
  }

  private setupMeter(stream: MediaStream): void {
    try {
      this.audioCtx = new AudioContext()
      const src = this.audioCtx.createMediaStreamSource(stream)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 512
      src.connect(this.analyser)
    } catch {
      /* ignore */
    }
  }

  private tick(): void {
    if (this.snapshot.status !== 'recording' && this.snapshot.status !== 'paused') return
    let level = 0
    if (this.analyser && this.snapshot.micEnabled) {
      const buf = new Uint8Array(this.analyser.fftSize)
      this.analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / buf.length)
      level = Math.min(1, rms * 3.2)
    }
    this.emit({ elapsedMs: this.elapsed(), micLevel: level })
  }

  private elapsed(): number {
    const now = this.snapshot.status === 'paused' ? this.pauseStart : Date.now()
    const paused = this.pauses.reduce((a, p) => a + (p.end - p.start), 0)
    return Math.max(0, now - this.startEpoch - paused)
  }

  private handleCommand(c: HudCommand): void {
    switch (c) {
      case 'pause':
        this.pause()
        break
      case 'resume':
        this.resume()
        break
      case 'stop':
        void this.stop()
        break
      case 'cancel':
        void this.cancel()
        break
      case 'restart':
        void this.restart()
        break
      case 'toggle-mic':
        if (this.micTrack) {
          this.micTrack.enabled = !this.micTrack.enabled
          this.emit({ micEnabled: this.micTrack.enabled })
        }
        break
      case 'toggle-camera':
        if (this.cameraTrack) {
          this.cameraTrack.enabled = !this.cameraTrack.enabled
          this.emit({ cameraEnabled: this.cameraTrack.enabled })
        }
        break
    }
  }

  pause(): void {
    if (this.snapshot.status !== 'recording') return
    for (const r of this.recs) if (r.recorder.state === 'recording') r.recorder.pause()
    if (this.useSysHelper) void fw.sysaudio.pause()
    this.pauseStart = Date.now()
    this.emit({ status: 'paused' })
  }

  resume(): void {
    if (this.snapshot.status !== 'paused') return
    for (const r of this.recs) if (r.recorder.state === 'paused') r.recorder.resume()
    if (this.useSysHelper) void fw.sysaudio.resume()
    this.pauses.push({ start: this.pauseStart, end: Date.now() })
    this.emit({ status: 'recording' })
  }

  togglePause(): void {
    if (this.snapshot.status === 'paused') this.resume()
    else this.pause()
  }

  async stop(): Promise<void> {
    if (this.snapshot.status === 'countdown') return this.cancel()
    if (this.snapshot.status !== 'recording' && this.snapshot.status !== 'paused') return
    if (this.snapshot.status === 'paused') this.pauses.push({ start: this.pauseStart, end: Date.now() })
    const durationMs = this.elapsed()
    this.emit({ status: 'stopping', elapsedMs: durationMs })
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    const stopEpoch = Date.now()

    // Stop recorders and flush (the system-audio helper stops at the same instant → end-aligned)
    const sysStop = this.useSysHelper ? fw.sysaudio.stop().catch((e) => console.warn('sysaudio stop failed', e)) : null
    for (const r of this.recs) {
      try {
        if (r.recorder.state !== 'inactive') r.recorder.requestData()
        if (r.recorder.state !== 'inactive') r.recorder.stop()
      } catch {
        /* ignore */
      }
    }
    await Promise.all(this.recs.map((r) => r.stopped))
    if (sysStop) await sysStop

    // Events
    let events: RecordingEvents | null = null
    if (this.opts?.cursorCapture) {
      // Keep absolute timestamps; finalize aligns them to the actual video content.
      events = await fw.tracker.stop()
      if (events) events = this.compensatePauses(events)
    }
    const pausedMs = this.pauses.reduce((a, p) => a + (p.end - p.start), 0)
    await this.teardown()
    fw.window.show()
    this.emit({ status: 'processing', processing: { label: 'Saving recording', progress: 0 } })

    try {
      const pid = this.projectId!
      const screenRec = this.recs.find((r) => r.name === 'screen')
      if (!screenRec || screenRec.bytes === 0) throw new Error(screenRec?.error ?? 'No video data was captured. Try a lower frame rate or quality.')
      const project = await fw.projects.load(pid)
      const r = project.recording
      r.durationMs = durationMs
      r.width = this.videoSize.width
      r.height = this.videoSize.height
      for (const rec of this.recs) {
        const offsetMs = rec.startEpoch - this.startEpoch
        if (rec.name === 'screen') r.screen = { file: rec.file, width: this.videoSize.width, height: this.videoSize.height, offsetMs: 0 }
        if (rec.name === 'camera') r.camera = { file: rec.file, width: this.cameraSize.width, height: this.cameraSize.height, offsetMs }
        if (rec.name === 'mic') r.mic = { file: rec.file, offsetMs }
        if (rec.name === 'system') r.system = { file: rec.file, offsetMs }
      }
      if (this.useSysHelper) r.system = { file: 'system.wav', offsetMs: 0 }
      r.recordedAt = this.startEpoch
      r.stoppedAt = stopEpoch
      r.pausedMs = pausedMs
      if (events) {
        await fw.projects.writeFile(pid, 'events.json', JSON.stringify(events))
        r.events = 'events.json'
        r.eventsAbsolute = true
      }
      // Region → default crop
      if (this.opts?.mode === 'region' && this.opts.region && this.display) {
        const s = this.display.scaleFactor
        const reg = this.opts.region
        r.crop = { x: reg.x * s, y: reg.y * s, width: reg.width * s, height: reg.height * s }
        project.render.crop = {
          x: r.crop.x / r.width,
          y: r.crop.y / r.height,
          width: r.crop.width / r.width,
          height: r.crop.height / r.height
        }
      }
      await fw.projects.save(project)

      const unsub = fw.projects.onProgress((p) => {
        if (p.id === pid) this.emit({ processing: { label: p.label, progress: p.progress } })
      })
      const finalized = await fw.projects.finalize(pid)
      unsub()
      this.projectId = null
      this.emit({ status: 'idle', processing: undefined })
      this.onDone?.(finalized)
    } catch (e) {
      console.error('finalize failed', e)
      if (this.projectId) await fw.projects.delete(this.projectId).catch(() => {})
      this.projectId = null
      this.emit({ status: 'error', error: 'Processing failed: ' + ((e as Error).message || e), processing: undefined })
      setTimeout(() => this.emit({ status: 'idle' }), 100)
    }
  }

  /** Drop events that happened while paused and shift later ones back (absolute epoch domain). */
  private compensatePauses(ev: RecordingEvents): RecordingEvents {
    if (this.pauses.length === 0) return ev
    const rel = this.pauses.map((p) => ({ start: p.start, end: p.end })).sort((a, b) => a.start - b.start)
    const map = (t: number): number | null => {
      let shift = 0
      for (const p of rel) {
        if (t >= p.start && t < p.end) return null
        if (t >= p.end) shift += p.end - p.start
      }
      return t - shift
    }
    const fix = <T extends { t: number }>(arr: T[]): T[] => {
      const out: T[] = []
      for (const e of arr) {
        const t = map(e.t)
        if (t != null) out.push({ ...e, t })
      }
      return out
    }
    return { cursor: fix(ev.cursor), clicks: fix(ev.clicks), keys: fix(ev.keys), scrolls: fix(ev.scrolls) }
  }

  async cancel(): Promise<void> {
    if (!this.active) return
    this.cancelled = true
    if (this.countdownTimer) clearTimeout(this.countdownTimer)
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    for (const r of this.recs) {
      try {
        if (r.recorder.state !== 'inactive') r.recorder.stop()
      } catch {
        /* ignore */
      }
    }
    await Promise.all(this.recs.map((r) => r.stopped)).catch(() => {})
    await fw.tracker.stop().catch(() => null)
    await this.teardown()
    if (this.projectId) await fw.projects.delete(this.projectId).catch(() => {})
    this.projectId = null
    fw.window.show()
    this.emit({ status: 'idle', elapsedMs: 0 })
    this.onCancelled?.()
  }

  async restart(): Promise<void> {
    const opts = this.opts
    const source = this.source
    const display = this.display
    await this.cancel()
    if (opts && source) await this.start(opts, source, display)
  }

  private async teardown(): Promise<void> {
    if (this.useSysHelper) await fw.sysaudio.stop().catch(() => {})
    this.unsubHud?.()
    this.unsubHud = null
    for (const s of this.streams) s.getTracks().forEach((t) => t.stop())
    this.streams = []
    this.micTrack = null
    this.cameraTrack = null
    this.analyser = null
    await this.audioCtx?.close().catch(() => {})
    this.audioCtx = null
    await fw.hud.hide().catch(() => {})
    await fw.hud.cameraBubble(null).catch(() => {})
  }
}

export const recorder = new RecorderEngine()
