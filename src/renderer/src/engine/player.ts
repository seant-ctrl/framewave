import type { Project, Timeline, TransitionType } from '@shared/types'
import { projectMediaUrl } from '@/lib/fw'
import { activeClipsAt, clipAt, placeClips, sourceTimeOf, timelineDuration, timelineToSource, assetFor, audioClipEnd, type ClipPlacement } from './timeline'
import type { FrameSources, FrameSource } from './compositor'

type TrackName = 'camera' | 'mic' | 'system' | 'music'

interface Track {
  el: HTMLVideoElement | HTMLAudioElement
  offsetMs: number
  ready: boolean
  gain: GainNode | null
  /** Media time basis: 'source' (recording clock) or 'timeline' (music) */
  basis: 'source' | 'timeline'
}

interface SourceEl {
  id: string
  kind: 'video' | 'image'
  el: HTMLVideoElement | HTMLImageElement
  ready: boolean
  gain: GainNode | null
  width: number
  height: number
}

/**
 * Synchronised multi-track media player for the editor preview. The current
 * clip's video is the master clock; every other element is nudged to follow it.
 * Supports several video/image sources (montage) and transition overlaps.
 */
export class MediaPlayer {
  tracks = new Map<TrackName, Track>()
  sources = new Map<string, SourceEl>()
  /** One media element per independent audio block */
  audioEls = new Map<string, { el: HTMLMediaElement; gain: GainNode | null }>()
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private timeline: Timeline
  private project: Project
  private _time = 0
  private _playing = false
  private clock0 = 0
  private time0 = 0
  private currentClipIndex = -1
  private destroyed = false
  onEnded: (() => void) | null = null
  /** Fired whenever a media element becomes ready / seeks, so the preview can repaint. */
  onReady: (() => void) | null = null
  masterVolume = 1
  muted = false

  constructor(project: Project) {
    this.project = project
    this.timeline = project.timeline
    this.setupAudio()
    this.build()
  }

  private setupAudio(): void {
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
    } catch (e) {
      console.warn('audio graph failed', e)
    }
  }

  private connectGain(el: HTMLMediaElement): GainNode | null {
    if (!this.ctx || !this.master) return null
    try {
      const src = this.ctx.createMediaElementSource(el)
      const g = this.ctx.createGain()
      src.connect(g)
      g.connect(this.master)
      return g
    } catch {
      return null
    }
  }

  private mkMedia(url: string, video: boolean): HTMLVideoElement | HTMLAudioElement {
    const el = document.createElement(video ? 'video' : 'audio') as HTMLVideoElement
    el.src = url
    el.preload = 'auto'
    el.crossOrigin = 'anonymous'
    el.playsInline = true
    for (const ev of ['loadeddata', 'seeked', 'canplay']) el.addEventListener(ev, () => this.onReady?.())
    el.addEventListener('error', () => {
      if (!el.src || this.destroyed) return
      console.warn('[player] failed to load media:', el.error?.message ?? el.error)
    })
    return el
  }

  private build(): void {
    const r = this.project.recording
    const dir = this.project.dir
    // Video/image sources
    const ensureSource = (id: string): void => {
      if (this.sources.has(id)) return
      const asset = assetFor(this.project, id === 'screen' ? undefined : id)
      if (!asset) return
      if (asset.kind === 'image') {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        const s: SourceEl = { id, kind: 'image', el: img, ready: false, gain: null, width: asset.width ?? 1920, height: asset.height ?? 1080 }
        img.onload = () => {
          s.ready = true
          s.width = img.naturalWidth
          s.height = img.naturalHeight
          this.onReady?.()
        }
        img.src = projectMediaUrl(dir, asset.file)
        this.sources.set(id, s)
      } else {
        const el = this.mkMedia(projectMediaUrl(dir, asset.file), true) as HTMLVideoElement
        el.muted = false
        const s: SourceEl = { id, kind: 'video', el, ready: false, gain: this.connectGain(el), width: asset.width ?? 0, height: asset.height ?? 0 }
        el.addEventListener('loadedmetadata', () => {
          s.ready = true
          s.width = el.videoWidth
          s.height = el.videoHeight
        })
        this.sources.set(id, s)
      }
    }
    if (r.screen) ensureSource('screen')
    for (const c of this.timeline.clips) ensureSource(c.sourceId ?? 'screen')

    const mk = (name: TrackName, file: string, offsetMs: number, video: boolean, basis: Track['basis'] = 'source'): void => {
      const el = this.mkMedia(projectMediaUrl(dir, file), video)
      if (name === 'camera') el.muted = true
      const track: Track = { el, offsetMs, ready: false, gain: null, basis }
      el.addEventListener('loadedmetadata', () => (track.ready = true))
      if (name !== 'camera') track.gain = this.connectGain(el)
      this.tracks.set(name, track)
    }
    if (r.camera) mk('camera', r.camera.file, r.camera.offsetMs ?? 0, true)
    if (r.mic) mk('mic', r.mic.file, r.mic.offsetMs ?? 0, false)
    if (r.system) mk('system', r.system.file, r.system.offsetMs ?? 0, false)
    if (this.timeline.audio.music) mk('music', this.timeline.audio.music.file, this.timeline.audio.music.offset, false, 'timeline')
    this.syncAudioClipEls()
    this.applyVolumes()
  }

  /** Create/remove media elements so they match timeline.audioClips. */
  private syncAudioClipEls(): void {
    const clips = this.timeline.audioClips ?? []
    const ids = new Set(clips.map((a) => a.id))
    for (const [id, a] of this.audioEls) {
      if (!ids.has(id)) {
        a.el.pause()
        a.el.removeAttribute('src')
        a.el.load()
        this.audioEls.delete(id)
      }
    }
    for (const a of clips) {
      if (this.audioEls.has(a.id)) continue
      const asset = assetFor(this.project, a.sourceId === 'screen' ? undefined : a.sourceId)
      if (!asset) continue
      const el = this.mkMedia(projectMediaUrl(this.project.dir, asset.file), false)
      this.audioEls.set(a.id, { el, gain: this.connectGain(el) })
    }
  }

  private audioClipMediaTime(a: { start: number; sourceStart: number }, t: number): number {
    return (a.sourceStart + (t - a.start)) / 1000
  }

  update(project: Project): void {
    const musicChanged = project.timeline.audio.music?.file !== this.project.timeline.audio.music?.file
    this.project = project
    this.timeline = project.timeline
    // New sources (media added)
    for (const c of project.timeline.clips) {
      const id = c.sourceId ?? 'screen'
      if (!this.sources.has(id)) {
        const asset = assetFor(project, c.sourceId)
        if (!asset) continue
        if (asset.kind === 'image') {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          const s: SourceEl = { id, kind: 'image', el: img, ready: false, gain: null, width: asset.width ?? 1920, height: asset.height ?? 1080 }
          img.onload = () => {
            s.ready = true
            s.width = img.naturalWidth
            s.height = img.naturalHeight
            this.onReady?.()
          }
          img.src = projectMediaUrl(project.dir, asset.file)
          this.sources.set(id, s)
        } else {
          const el = this.mkMedia(projectMediaUrl(project.dir, asset.file), true) as HTMLVideoElement
          const s: SourceEl = { id, kind: 'video', el, ready: false, gain: this.connectGain(el), width: asset.width ?? 0, height: asset.height ?? 0 }
          el.addEventListener('loadedmetadata', () => {
            s.ready = true
            s.width = el.videoWidth
            s.height = el.videoHeight
          })
          this.sources.set(id, s)
        }
      }
    }
    if (musicChanged) {
      const m = this.tracks.get('music')
      if (m) {
        m.el.pause()
        m.el.removeAttribute('src')
        this.tracks.delete('music')
      }
      if (project.timeline.audio.music) {
        const el = this.mkMedia(projectMediaUrl(project.dir, project.timeline.audio.music.file), false)
        const track: Track = { el, offsetMs: project.timeline.audio.music.offset, ready: false, gain: this.connectGain(el), basis: 'timeline' }
        el.addEventListener('loadedmetadata', () => (track.ready = true))
        this.tracks.set('music', track)
      }
    } else {
      const m = this.tracks.get('music')
      if (m && project.timeline.audio.music) m.offsetMs = project.timeline.audio.music.offset
    }
    this.syncAudioClipEls()
    this.applyVolumes()
    // Re-seek if clip structure changed while paused
    if (!this._playing) this.seek(this._time)
  }

  applyVolumes(): void {
    const a = this.timeline.audio
    const vol = (v: number, muted: boolean): number => (this.muted || muted ? 0 : v * this.masterVolume)
    const setTrack = (name: TrackName, v: number): void => {
      const t = this.tracks.get(name)
      if (!t) return
      if (t.gain) t.gain.gain.value = v
      else t.el.volume = Math.min(1, v)
    }
    setTrack('mic', vol(a.mic.volume, a.mic.muted))
    setTrack('system', vol(a.system.volume, a.system.muted))
    setTrack('camera', 0)
    if (a.music) setTrack('music', vol(a.music.volume, a.music.muted))
    for (const ac of this.timeline.audioClips ?? []) {
      const e = this.audioEls.get(ac.id)
      if (!e) continue
      const v = vol(ac.volume, ac.muted)
      if (e.gain) e.gain.gain.value = v
      else e.el.volume = Math.min(1, v)
    }
    this.applyClipVolumes()
  }

  /** Per-source gains follow the active clip (and transition crossfade). */
  private applyClipVolumes(): void {
    const a = this.timeline.audio
    const act = activeClipsAt(this.timeline, this._time)
    const gainFor = (p: ClipPlacement | null, fade: number): number => {
      if (!p) return 0
      const c = p.clip
      const own = c.muted ? 0 : (c.volume ?? 1)
      // The recording's own screen audio is controlled by the "system" track settings
      const sys = !c.sourceId || c.sourceId === 'screen' ? (a.system.muted ? 0 : a.system.volume) : 1
      return this.muted ? 0 : own * sys * this.masterVolume * fade
    }
    const curId = act?.current.clip.sourceId ?? 'screen'
    const outId = act?.outgoing ? act.outgoing.clip.sourceId ?? 'screen' : null
    for (const [id, s] of this.sources) {
      if (!s.gain) continue
      let g = 0
      if (act && id === curId) g = gainFor(act.current, act.outgoing ? act.progress : 1)
      else if (act && outId && id === outId) g = gainFor(act.outgoing, 1 - act.progress)
      s.gain.gain.value = g
    }
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

  /** Whether the current source is ready to be drawn. */
  get ready(): boolean {
    const p = clipAt(this.timeline, this._time)
    const s = this.sources.get(p?.clip.sourceId ?? 'screen')
    return !!s && (s.kind === 'image' ? s.ready : (s.el as HTMLVideoElement).readyState >= 2)
  }

  private frameOf(id: string): FrameSource | null {
    const s = this.sources.get(id)
    if (!s) return null
    if (s.kind === 'image') return s.ready ? { image: s.el, width: s.width, height: s.height } : null
    const v = s.el as HTMLVideoElement
    return v.readyState >= 2 && v.videoWidth ? { image: v, width: v.videoWidth, height: v.videoHeight } : null
  }

  frameSources(): FrameSources {
    const act = activeClipsAt(this.timeline, this._time)
    const cur = act?.current ?? null
    const curId = cur?.clip.sourceId ?? 'screen'
    const c = this.tracks.get('camera')?.el as HTMLVideoElement | undefined
    const s2 = timelineToSource(this.timeline, this._time)
    const camT = c ? s2 - (this.tracks.get('camera')!.offsetMs ?? 0) : 0
    const isRecording = !cur || !cur.clip.sourceId || cur.clip.sourceId === 'screen'
    const out: FrameSources = {
      screen: this.frameOf(curId),
      camera: isRecording && c && c.readyState >= 2 && c.videoWidth && camT >= 0 && camT <= c.duration * 1000 + 100 ? { image: c, width: c.videoWidth, height: c.videoHeight } : null,
      sourceId: cur?.clip.sourceId,
      fit: cur?.clip.fit
    }
    if (act?.outgoing && act.current.clip.transitionIn) {
      out.outgoing = this.frameOf(act.outgoing.clip.sourceId ?? 'screen')
      out.outgoingFit = act.outgoing.clip.fit
      out.transition = { type: act.current.clip.transitionIn.type as TransitionType, progress: act.progress }
    }
    return out
  }

  private mediaTime(track: Track, sourceMs: number, timelineMs: number): number {
    if (track.basis === 'timeline') return (timelineMs - track.offsetMs) / 1000
    return (sourceMs - track.offsetMs) / 1000
  }

  private seekSource(id: string, sec: number): void {
    const s = this.sources.get(id)
    if (!s || s.kind !== 'video') return
    const v = s.el as HTMLVideoElement
    if (Math.abs(v.currentTime - sec) > 0.012 || !this._playing) {
      try {
        v.currentTime = Math.max(0, sec)
      } catch {
        /* not ready */
      }
    }
  }

  seek(t: number): void {
    const dur = this.duration
    t = Math.max(0, Math.min(dur, t))
    this._time = t
    const act = activeClipsAt(this.timeline, t)
    const place = act?.current ?? null
    this.currentClipIndex = place?.index ?? -1
    // Recording-clock tracks follow the recording source time; other sources have their own
    const sRec = place && (!place.clip.sourceId || place.clip.sourceId === 'screen') ? sourceTimeOf(place, t) : -1
    const speed = place?.clip.speed ?? 1
    for (const [name, tr] of this.tracks) {
      const mt = name === 'music' ? this.mediaTime(tr, 0, t) : sRec >= 0 ? this.mediaTime(tr, sRec, t) : -1
      if (!isFinite(mt)) continue
      if (mt < 0) {
        tr.el.pause()
        continue
      }
      if (Math.abs(tr.el.currentTime - mt) > 0.012 || !this._playing) {
        try {
          tr.el.currentTime = Math.max(0, mt)
        } catch {
          /* not ready */
        }
      }
      tr.el.playbackRate = name === 'music' ? 1 : speed
    }
    // Pause sources that are not active
    const activeIds = new Set<string>()
    if (place) {
      const id = place.clip.sourceId ?? 'screen'
      activeIds.add(id)
      this.seekSource(id, sourceTimeOf(place, t) / 1000)
      const s = this.sources.get(id)
      if (s?.kind === 'video') (s.el as HTMLVideoElement).playbackRate = speed
    }
    if (act?.outgoing) {
      const id = act.outgoing.clip.sourceId ?? 'screen'
      activeIds.add(id)
      this.seekSource(id, sourceTimeOf(act.outgoing, t) / 1000)
    }
    for (const [id, s] of this.sources) {
      if (s.kind === 'video' && !activeIds.has(id)) (s.el as HTMLVideoElement).pause()
    }
    // Independent audio blocks
    for (const ac of this.timeline.audioClips ?? []) {
      const e = this.audioEls.get(ac.id)
      if (!e) continue
      if (t < ac.start || t >= audioClipEnd(ac)) {
        e.el.pause()
        continue
      }
      const mt = this.audioClipMediaTime(ac, t)
      if (Math.abs(e.el.currentTime - mt) > 0.012 || !this._playing) {
        try {
          e.el.currentTime = Math.max(0, mt)
        } catch {
          /* not ready */
        }
      }
    }
    this.applyClipVolumes()
    if (this._playing) {
      this.clock0 = performance.now()
      this.time0 = t
    }
  }

  private playActive(): void {
    const act = activeClipsAt(this.timeline, this._time)
    if (!act) return
    const ids = [act.current.clip.sourceId ?? 'screen', ...(act.outgoing ? [act.outgoing.clip.sourceId ?? 'screen'] : [])]
    for (const id of ids) {
      const s = this.sources.get(id)
      if (s?.kind === 'video') (s.el as HTMLVideoElement).play().catch(() => {})
    }
    const place = act.current
    const sRec = !place.clip.sourceId || place.clip.sourceId === 'screen' ? sourceTimeOf(place, this._time) : -1
    for (const [name, tr] of this.tracks) {
      const mt = name === 'music' ? this.mediaTime(tr, 0, this._time) : sRec >= 0 ? this.mediaTime(tr, sRec, this._time) : -1
      if (mt < 0 || (tr.ready && mt > tr.el.duration)) {
        tr.el.pause()
        continue
      }
      tr.el.play().catch(() => {})
    }
    for (const ac of this.timeline.audioClips ?? []) {
      const e = this.audioEls.get(ac.id)
      if (!e) continue
      if (this._time >= ac.start && this._time < audioClipEnd(ac)) e.el.play().catch(() => {})
      else e.el.pause()
    }
  }

  async play(): Promise<void> {
    if (this._playing) return
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
    if (this._time >= this.duration - 1) this.seek(0)
    this._playing = true
    this.seek(this._time)
    this.clock0 = performance.now()
    this.time0 = this._time
    this.playActive()
  }

  pause(): void {
    if (!this._playing) return
    this._playing = false
    for (const [, tr] of this.tracks) tr.el.pause()
    for (const [, s] of this.sources) if (s.kind === 'video') (s.el as HTMLVideoElement).pause()
    for (const [, e] of this.audioEls) e.el.pause()
  }

  /** Advance the clock. Call once per animation frame while playing. */
  tick(): number {
    if (!this._playing) return this._time
    const place = clipAt(this.timeline, this._time)
    const master = place ? this.sources.get(place.clip.sourceId ?? 'screen') : undefined
    let t: number
    if (place && master && master.kind === 'video' && master.ready && !(master.el as HTMLVideoElement).paused) {
      // Current clip's video is master
      const sMs = (master.el as HTMLVideoElement).currentTime * 1000
      const local = (sMs - place.clip.sourceStart) / (place.clip.speed || 1)
      t = place.start + local
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
    // Clip boundary → switch sources
    const np = clipAt(this.timeline, t)
    if (np && np.index !== this.currentClipIndex) {
      this._time = t
      this.seek(Math.max(np.start, t))
      this.playActive()
      return this._time
    }
    this._time = t
    const act = activeClipsAt(this.timeline, t)
    // Outgoing clip during a transition must be playing
    if (act?.outgoing) {
      const s = this.sources.get(act.outgoing.clip.sourceId ?? 'screen')
      if (s?.kind === 'video') {
        const v = s.el as HTMLVideoElement
        const want = sourceTimeOf(act.outgoing, t) / 1000
        if (v.paused) {
          v.currentTime = want
          v.play().catch(() => {})
        } else if (Math.abs(v.currentTime - want) > 0.12) v.currentTime = want
      }
      this.applyClipVolumes()
    }
    // Drift correction for secondary tracks (recording clock)
    const sRec = place && (!place.clip.sourceId || place.clip.sourceId === 'screen') ? sourceTimeOf(place, t) : -1
    for (const [name, tr] of this.tracks) {
      if (!tr.ready) continue
      const mt = name === 'music' ? this.mediaTime(tr, 0, t) : sRec >= 0 ? this.mediaTime(tr, sRec, t) : -1
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
    // Independent audio blocks: start/stop at their bounds, correct drift
    for (const ac of this.timeline.audioClips ?? []) {
      const e = this.audioEls.get(ac.id)
      if (!e) continue
      const inside = t >= ac.start && t < audioClipEnd(ac)
      if (!inside) {
        if (!e.el.paused) e.el.pause()
        continue
      }
      const mt = this.audioClipMediaTime(ac, t)
      if (e.el.paused) {
        e.el.currentTime = mt
        e.el.play().catch(() => {})
      } else if (Math.abs(e.el.currentTime - mt) > 0.09) e.el.currentTime = mt
    }
    if (master && master.kind === 'video' && master.ready && (master.el as HTMLVideoElement).paused && this._playing) (master.el as HTMLVideoElement).play().catch(() => {})
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
    for (const [, s] of this.sources) {
      if (s.kind === 'video') {
        s.el.removeAttribute('src')
        ;(s.el as HTMLVideoElement).load()
      } else (s.el as HTMLImageElement).src = ''
    }
    for (const [, e] of this.audioEls) {
      e.el.removeAttribute('src')
      e.el.load()
    }
    this.audioEls.clear()
    this.tracks.clear()
    this.sources.clear()
    void this.ctx?.close()
  }
}
