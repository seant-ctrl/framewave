import type { Project, Timeline } from '@shared/types'
import { projectMediaUrl } from '@/lib/fw'
import { clipAt, placeClips, timelineDuration, timelineToSource } from './timeline'
import type { FrameSources } from './compositor'

type TrackName = 'screen' | 'camera' | 'mic' | 'system' | 'music'

interface Track {
  el: HTMLVideoElement | HTMLAudioElement
  offsetMs: number
  ready: boolean
  gain: GainNode | null
  /** Media time basis: 'source' (recording clock) or 'timeline' (music) */
  basis: 'source' | 'timeline'
}

/**
 * Synchronised multi-track media player for the editor preview. The screen
 * video is the master clock; every other element is nudged to follow it.
 */
export class MediaPlayer {
  tracks = new Map<TrackName, Track>()
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private timeline: Timeline
  private project: Project
  private _time = 0
  private _playing = false
  private clock0 = 0
  private time0 = 0
  private currentClipIndex = -1
  private seekSeq = 0
  private destroyed = false
  onEnded: (() => void) | null = null
  /** Fired whenever a media element becomes ready / seeks, so the preview can repaint. */
  onReady: (() => void) | null = null
  masterVolume = 1
  muted = false

  constructor(project: Project) {
    this.project = project
    this.timeline = project.timeline
    this.build()
  }

  private build(): void {
    const r = this.project.recording
    const dir = this.project.dir
    const mk = (name: TrackName, file: string, offsetMs: number, video: boolean, basis: Track['basis'] = 'source'): void => {
      const el = document.createElement(video ? 'video' : 'audio') as HTMLVideoElement
      el.src = projectMediaUrl(dir, file)
      el.preload = 'auto'
      el.crossOrigin = 'anonymous'
      el.playsInline = true
      el.muted = video && name === 'camera' // camera audio comes via mic
      const track: Track = { el, offsetMs, ready: false, gain: null, basis }
      el.addEventListener('loadedmetadata', () => (track.ready = true))
      for (const ev of ['loadeddata', 'seeked', 'canplay']) el.addEventListener(ev, () => this.onReady?.())
      el.addEventListener('error', () => {
        if (!el.src || this.destroyed) return
        console.warn(`[player] failed to load ${name}:`, el.error?.message ?? el.error)
      })
      this.tracks.set(name, track)
    }
    if (r.screen) mk('screen', r.screen.file, 0, true)
    if (r.camera) mk('camera', r.camera.file, r.camera.offsetMs ?? 0, true)
    if (r.mic) mk('mic', r.mic.file, r.mic.offsetMs ?? 0, false)
    if (r.system) mk('system', r.system.file, r.system.offsetMs ?? 0, false)
    if (this.timeline.audio.music) mk('music', this.timeline.audio.music.file, this.timeline.audio.music.offset, false, 'timeline')
    this.setupAudio()
    this.applyVolumes()
  }

  private setupAudio(): void {
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
      for (const [name, t] of this.tracks) {
        if (name === 'camera') continue
        const src = this.ctx.createMediaElementSource(t.el)
        const g = this.ctx.createGain()
        src.connect(g)
        g.connect(this.master)
        t.gain = g
      }
    } catch (e) {
      console.warn('audio graph failed', e)
    }
  }

  update(project: Project): void {
    const musicChanged = project.timeline.audio.music?.file !== this.project.timeline.audio.music?.file
    this.project = project
    this.timeline = project.timeline
    if (musicChanged) {
      const m = this.tracks.get('music')
      if (m) {
        m.el.pause()
        m.el.src = ''
        this.tracks.delete('music')
      }
      if (project.timeline.audio.music && this.ctx) {
        const el = document.createElement('audio')
        el.src = projectMediaUrl(project.dir, project.timeline.audio.music.file)
        el.preload = 'auto'
        el.crossOrigin = 'anonymous'
        const track: Track = { el, offsetMs: project.timeline.audio.music.offset, ready: false, gain: null, basis: 'timeline' }
        el.addEventListener('loadedmetadata', () => (track.ready = true))
        const src = this.ctx.createMediaElementSource(el)
        const g = this.ctx.createGain()
        src.connect(g)
        g.connect(this.master!)
        track.gain = g
        this.tracks.set('music', track)
      }
    } else {
      const m = this.tracks.get('music')
      if (m && project.timeline.audio.music) m.offsetMs = project.timeline.audio.music.offset
    }
    this.applyVolumes()
    // Re-seek if clip structure changed while paused
    if (!this._playing) this.seek(this._time)
  }

  applyVolumes(): void {
    const a = this.timeline.audio
    const vol = (v: number, muted: boolean): number => (this.muted || muted ? 0 : v * this.masterVolume)
    const set = (name: TrackName, v: number): void => {
      const t = this.tracks.get(name)
      if (!t) return
      if (t.gain) t.gain.gain.value = v
      else t.el.volume = Math.min(1, v)
    }
    set('mic', vol(a.mic.volume, a.mic.muted))
    set('system', vol(a.system.volume, a.system.muted))
    // If the screen video itself has audio (imported video), treat it as the system track
    set('screen', vol(a.system.volume, a.system.muted))
    set('camera', 0)
    if (a.music) set('music', vol(a.music.volume, a.music.muted))
  }

  get time(): number {
    return this._time
  }
  get playing(): boolean {
    return this._playing
  }
  get duration(): number {
    return timelineDuration(this.timeline)
  }

  /** Whether the screen element is ready to be drawn. */
  get ready(): boolean {
    const s = this.tracks.get('screen')
    return !!s && s.el.readyState >= 2
  }

  frameSources(): FrameSources {
    const s = this.tracks.get('screen')?.el as HTMLVideoElement | undefined
    const c = this.tracks.get('camera')?.el as HTMLVideoElement | undefined
    const s2 = timelineToSource(this.timeline, this._time)
    const camT = c ? s2 - (this.tracks.get('camera')!.offsetMs ?? 0) : 0
    return {
      screen: s && s.readyState >= 2 && s.videoWidth ? { image: s, width: s.videoWidth, height: s.videoHeight } : null,
      camera: c && c.readyState >= 2 && c.videoWidth && camT >= 0 && camT <= c.duration * 1000 + 100 ? { image: c, width: c.videoWidth, height: c.videoHeight } : null
    }
  }

  private mediaTime(track: Track, sourceMs: number, timelineMs: number): number {
    if (track.basis === 'timeline') return (timelineMs - track.offsetMs) / 1000
    return (sourceMs - track.offsetMs) / 1000
  }

  seek(t: number): void {
    const dur = this.duration
    t = Math.max(0, Math.min(dur, t))
    this._time = t
    const s = timelineToSource(this.timeline, t)
    const place = clipAt(this.timeline, t)
    this.currentClipIndex = place?.index ?? -1
    const seq = ++this.seekSeq
    for (const [, tr] of this.tracks) {
      const mt = this.mediaTime(tr, s, t)
      if (!isFinite(mt)) continue
      if (Math.abs(tr.el.currentTime - mt) > 0.012 || !this._playing) {
        try {
          tr.el.currentTime = Math.max(0, mt)
        } catch {
          /* not ready */
        }
      }
      tr.el.playbackRate = place?.clip.speed ?? 1
    }
    if (this._playing) {
      this.clock0 = performance.now()
      this.time0 = t
    }
    void seq
  }

  async play(): Promise<void> {
    if (this._playing) return
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
    if (this._time >= this.duration - 1) this.seek(0)
    this._playing = true
    this.seek(this._time)
    this.clock0 = performance.now()
    this.time0 = this._time
    const s = timelineToSource(this.timeline, this._time)
    for (const [, tr] of this.tracks) {
      const mt = this.mediaTime(tr, s, this._time)
      if (mt < 0 || (tr.ready && mt > tr.el.duration)) {
        tr.el.pause()
        continue
      }
      tr.el.play().catch(() => {})
    }
  }

  pause(): void {
    if (!this._playing) return
    this._playing = false
    for (const [, tr] of this.tracks) tr.el.pause()
  }

  /** Advance the clock. Call once per animation frame while playing. */
  tick(): number {
    if (!this._playing) return this._time
    const screen = this.tracks.get('screen')
    const place = clipAt(this.timeline, this._time)
    let t: number
    if (screen && screen.ready && !screen.el.paused && place) {
      // Screen video is master
      const sMs = screen.el.currentTime * 1000
      const local = (sMs - place.clip.sourceStart) / (place.clip.speed || 1)
      t = place.start + local
      // If we drifted before the clip start (seek landed early) use wall clock
      if (local < -50) t = this.time0 + (performance.now() - this.clock0)
    } else {
      t = this.time0 + (performance.now() - this.clock0)
    }
    const dur = this.duration
    if (t >= dur - 1) {
      this._time = dur
      this.pause()
      this.onEnded?.()
      return this._time
    }
    // Clip boundary → jump to the next clip's source position
    const np = clipAt(this.timeline, t)
    if (np && np.index !== this.currentClipIndex) {
      this._time = t
      this.seek(Math.max(np.start, t))
      for (const [, tr] of this.tracks) if (tr.el.paused) tr.el.play().catch(() => {})
      return this._time
    }
    this._time = t
    // Drift correction for secondary tracks
    const s = timelineToSource(this.timeline, t)
    for (const [name, tr] of this.tracks) {
      if (name === 'screen' || !tr.ready) continue
      const mt = this.mediaTime(tr, s, t)
      if (mt < 0 || mt > tr.el.duration) {
        if (!tr.el.paused) tr.el.pause()
        continue
      }
      if (tr.el.paused) {
        tr.el.currentTime = mt
        tr.el.play().catch(() => {})
      } else if (Math.abs(tr.el.currentTime - mt) > 0.09) {
        tr.el.currentTime = mt
      }
    }
    // Screen element itself paused unexpectedly (e.g. buffering)
    if (screen && screen.ready && screen.el.paused && this._playing) screen.el.play().catch(() => {})
    return this._time
  }

  /** Place list for the current timeline (used by UI) */
  places(): ReturnType<typeof placeClips> {
    return placeClips(this.timeline)
  }

  destroy(): void {
    this.destroyed = true
    this.pause()
    for (const [, tr] of this.tracks) {
      tr.el.removeAttribute('src')
      tr.el.load()
    }
    this.tracks.clear()
    void this.ctx?.close()
  }
}
