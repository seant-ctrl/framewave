import { Input, ALL_FORMATS, UrlSource, BlobSource, AudioBufferSink, type InputAudioTrack } from 'mediabunny'
import type { AudioTrackSettings, Project, Timeline } from '@shared/types'
import { placeClips } from './timeline'
import { projectMediaUrl } from '@/lib/fw'

export async function openInput(url: string): Promise<Input> {
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) })
    await input.getTracks()
    return input
  } catch (e) {
    // Fallback: load entire file into memory
    const blob = await fetch(url).then((r) => r.blob())
    return new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  }
}

/** Compute waveform peaks (0..1) for a media file, `buckets` values across the whole duration. */
export async function computePeaks(url: string, buckets = 2000): Promise<number[] | null> {
  let input: Input | null = null
  try {
    input = await openInput(url)
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return null
    const duration = await track.computeDuration()
    if (!duration) return null
    const sink = new AudioBufferSink(track)
    const peaks = new Float32Array(buckets)
    const perBucket = duration / buckets
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch = buffer.getChannelData(0)
      const ch2 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null
      const sr = buffer.sampleRate
      for (let i = 0; i < ch.length; i += 4) {
        const t = timestamp + i / sr
        const b = Math.min(buckets - 1, Math.floor(t / perBucket))
        const v = Math.abs(ch2 ? (ch[i] + ch2[i]) / 2 : ch[i])
        if (v > peaks[b]) peaks[b] = v
      }
    }
    // normalize softly
    let max = 0
    for (const p of peaks) if (p > max) max = p
    const norm = max > 0 ? 1 / max : 1
    return Array.from(peaks, (p) => Math.round(Math.min(1, p * norm) * 1000) / 1000)
  } catch (e) {
    console.warn('peaks failed', e)
    return null
  } finally {
    input?.dispose?.()
  }
}

// ── Mixdown for export ──────────────────────────────────────────────────────

export interface MixSource {
  name: 'mic' | 'system' | 'camera' | 'screen' | 'music'
  url: string
  settings: AudioTrackSettings
  offsetMs: number
  basis: 'source' | 'timeline'
  loop?: boolean
}

function applyGate(buffer: AudioBuffer, thresholdDb: number): void {
  const thr = Math.pow(10, thresholdDb / 20)
  const win = Math.floor(buffer.sampleRate * 0.02)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c)
    const gains = new Float32Array(Math.ceil(d.length / win))
    for (let w = 0; w < gains.length; w++) {
      let sum = 0
      const start = w * win
      const end = Math.min(d.length, start + win)
      for (let i = start; i < end; i++) sum += d[i] * d[i]
      const rms = Math.sqrt(sum / Math.max(1, end - start))
      gains[w] = rms < thr ? 0 : 1
    }
    // smooth gains (attack/release)
    let g = 1
    for (let i = 0; i < d.length; i++) {
      const target = gains[Math.floor(i / win)]
      g += (target - g) * (target > g ? 0.01 : 0.0015)
      d[i] *= g
    }
  }
}

/**
 * Renders all audio tracks for the given timeline range into one AudioBuffer.
 */
export async function mixdown(
  project: Project,
  sources: MixSource[],
  range: { start: number; end: number },
  sampleRate = 48000,
  onProgress?: (p: number) => void
): Promise<AudioBuffer | null> {
  const timeline: Timeline = project.timeline
  const lengthSec = (range.end - range.start) / 1000
  if (lengthSec <= 0) return null
  const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * sampleRate), sampleRate)
  let any = false
  const places = placeClips(timeline)
  let done = 0

  for (const src of sources) {
    if (src.settings.muted || src.settings.volume <= 0) {
      done++
      continue
    }
    let input: Input | null = null
    try {
      input = await openInput(src.url)
      const track: InputAudioTrack | null = await input.getPrimaryAudioTrack()
      if (!track || !(await track.canDecode())) continue
      const trackDur = await track.computeDuration()
      const sink = new AudioBufferSink(track)
      const trackGain = ctx.createGain()
      trackGain.gain.value = src.settings.volume
      trackGain.connect(ctx.destination)
      // fades (relative to export range)
      if (src.settings.fadeIn > 0) {
        trackGain.gain.setValueAtTime(0, 0)
        trackGain.gain.linearRampToValueAtTime(src.settings.volume, src.settings.fadeIn / 1000)
      }
      if (src.settings.fadeOut > 0) {
        trackGain.gain.setValueAtTime(src.settings.volume, Math.max(0, lengthSec - src.settings.fadeOut / 1000))
        trackGain.gain.linearRampToValueAtTime(0, lengthSec)
      }

      if (src.basis === 'timeline') {
        // Music: plays along the timeline from offset, optionally looping
        const startTl = src.offsetMs
        let cursor = startTl
        while (cursor < range.end) {
          const segStart = Math.max(cursor, range.start)
          const segEnd = Math.min(range.end, cursor + trackDur * 1000)
          if (segEnd > segStart) {
            const mediaStart = (segStart - cursor) / 1000
            const mediaEnd = (segEnd - cursor) / 1000
            for await (const { buffer, timestamp } of sink.buffers(mediaStart, mediaEnd)) {
              if (src.settings.gate != null) applyGate(buffer, src.settings.gate)
              const node = ctx.createBufferSource()
              node.buffer = buffer
              node.connect(trackGain)
              const when = (cursor - range.start) / 1000 + timestamp
              const offset = when < 0 ? -when : 0
              node.start(Math.max(0, when), offset)
              any = true
            }
          }
          if (!src.loop) break
          cursor += trackDur * 1000
        }
      } else {
        // Recording-clock tracks: follow clips (speed & cuts)
        for (const p of places) {
          if (p.end <= range.start || p.start >= range.end) continue
          const speed = p.clip.speed || 1
          // portion of clip within the range
          const tlA = Math.max(p.start, range.start)
          const tlB = Math.min(p.end, range.end)
          const srcA = p.clip.sourceStart + (tlA - p.start) * speed
          const srcB = p.clip.sourceStart + (tlB - p.start) * speed
          const mA = (srcA - src.offsetMs) / 1000
          const mB = (srcB - src.offsetMs) / 1000
          if (mB <= 0 || mA >= trackDur) continue
          for await (const { buffer, timestamp } of sink.buffers(Math.max(0, mA), Math.min(trackDur, mB))) {
            if (src.settings.gate != null) applyGate(buffer, src.settings.gate)
            const node = ctx.createBufferSource()
            node.buffer = buffer
            node.playbackRate.value = speed
            node.connect(trackGain)
            // timeline time where this chunk starts
            const srcMs = timestamp * 1000 + src.offsetMs
            const tl = p.start + (srcMs - p.clip.sourceStart) / speed
            const when = (tl - range.start) / 1000
            const chunkDurTl = buffer.duration / speed
            if (when + chunkDurTl <= 0) continue
            if (when < 0) node.start(0, -when * speed)
            else node.start(when)
            // stop at clip end
            const endWhen = (tlB - range.start) / 1000
            if (when + chunkDurTl > endWhen) node.stop(Math.max(0, endWhen))
            any = true
          }
        }
      }
    } catch (e) {
      console.warn(`[mixdown] ${src.name} failed`, e)
    } finally {
      input?.dispose?.()
      done++
      onProgress?.(done / sources.length)
    }
  }
  if (!any) return null
  return ctx.startRendering()
}

export function mixSourcesFor(project: Project): MixSource[] {
  const r = project.recording
  const a = project.timeline.audio
  const out: MixSource[] = []
  if (r.mic) out.push({ name: 'mic', url: projectMediaUrl(project.dir, r.mic.file), settings: a.mic, offsetMs: r.mic.offsetMs ?? 0, basis: 'source' })
  if (r.system) out.push({ name: 'system', url: projectMediaUrl(project.dir, r.system.file), settings: a.system, offsetMs: r.system.offsetMs ?? 0, basis: 'source' })
  if (r.screen?.hasAudio) out.push({ name: 'screen', url: projectMediaUrl(project.dir, r.screen.file), settings: a.system, offsetMs: 0, basis: 'source' })
  if (r.camera?.hasAudio && !a.camera.muted) out.push({ name: 'camera', url: projectMediaUrl(project.dir, r.camera.file), settings: a.camera, offsetMs: r.camera.offsetMs ?? 0, basis: 'source' })
  if (a.music) out.push({ name: 'music', url: projectMediaUrl(project.dir, a.music.file), settings: { volume: a.music.volume, muted: a.music.muted, gate: null, fadeIn: 0, fadeOut: 1500 }, offsetMs: a.music.offset, basis: 'timeline', loop: a.music.loop })
  return out
}

/** Detect silent regions in a track (returns source-time ranges in ms). */
export async function detectSilence(url: string, thresholdDb = -40, minDurationMs = 600): Promise<Array<{ start: number; end: number }>> {
  let input: Input | null = null
  try {
    input = await openInput(url)
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) return []
    const sink = new AudioBufferSink(track)
    const thr = Math.pow(10, thresholdDb / 20)
    const win = 0.02
    const loud: Array<{ t: number; loud: boolean }> = []
    for await (const { buffer, timestamp } of sink.buffers()) {
      const d = buffer.getChannelData(0)
      const ws = Math.floor(buffer.sampleRate * win)
      for (let i = 0; i < d.length; i += ws) {
        let sum = 0
        const end = Math.min(d.length, i + ws)
        for (let j = i; j < end; j++) sum += d[j] * d[j]
        loud.push({ t: (timestamp + i / buffer.sampleRate) * 1000, loud: Math.sqrt(sum / Math.max(1, end - i)) > thr })
      }
    }
    const out: Array<{ start: number; end: number }> = []
    let start: number | null = null
    for (let i = 0; i < loud.length; i++) {
      if (!loud[i].loud && start == null) start = loud[i].t
      if ((loud[i].loud || i === loud.length - 1) && start != null) {
        const end = loud[i].t
        if (end - start >= minDurationMs) out.push({ start: start + 150, end: end - 150 })
        start = null
      }
    }
    return out.filter((r) => r.end > r.start)
  } catch (e) {
    console.warn('silence detection failed', e)
    return []
  } finally {
    input?.dispose?.()
  }
}
