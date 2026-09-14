import type { Clip, Timeline, Project, MediaAsset, AudioClip } from '@shared/types'
import { uid } from '@/lib/utils'

/** Duration of a clip on the timeline (accounting for speed). */
export function clipDuration(c: Clip): number {
  return Math.max(0, (c.sourceEnd - c.sourceStart) / (c.speed || 1))
}

/** Overlap (ms) a clip's incoming transition takes from the previous clip. */
export function overlapOf(prev: Clip | undefined, c: Clip): number {
  if (!prev || !c.transitionIn || c.transitionIn.type === 'cut') return 0
  const max = Math.min(clipDuration(prev), clipDuration(c)) * 0.5
  return Math.max(0, Math.min(c.transitionIn.durationMs, max))
}

export interface ClipPlacement {
  clip: Clip
  index: number
  start: number // timeline start
  end: number // timeline end
  /** Length of the incoming transition overlap at the start of this clip. */
  overlapIn: number
}

/** Lay clips out on the timeline. Transitions overlap the end of the previous clip. */
export function placeClips(tl: Timeline): ClipPlacement[] {
  let t = 0
  const out: ClipPlacement[] = []
  tl.clips.forEach((clip, index) => {
    const ov = overlapOf(tl.clips[index - 1], clip)
    const start = Math.max(0, t - ov)
    const end = start + clipDuration(clip)
    out.push({ clip, index, start, end, overlapIn: ov })
    t = end
  })
  return out
}

export function timelineDuration(tl: Timeline): number {
  const p = placeClips(tl)
  let end = p.length ? p[p.length - 1].end : 0
  for (const a of tl.audioClips ?? []) end = Math.max(end, audioClipEnd(a))
  return end
}

/** Video-only duration (last video clip end). */
export function videoDuration(tl: Timeline): number {
  const p = placeClips(tl)
  return p.length ? p[p.length - 1].end : 0
}

export function audioClipDuration(a: AudioClip): number {
  return Math.max(0, a.sourceEnd - a.sourceStart)
}
export function audioClipEnd(a: AudioClip): number {
  return a.start + audioClipDuration(a)
}

/** Detach a video clip's audio into an independent AudioClip (the clip itself is muted). */
export function detachAudio(tl: Timeline, clipId: string): Timeline {
  const p = placeClips(tl).find((x) => x.clip.id === clipId)
  if (!p) return tl
  const c = p.clip
  const a: AudioClip = {
    id: uid('audio'),
    sourceId: c.sourceId ?? 'screen',
    sourceStart: c.sourceStart,
    sourceEnd: c.sourceEnd,
    start: p.start,
    volume: c.volume ?? 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    fromClipId: c.id
  }
  return {
    ...tl,
    clips: tl.clips.map((x) => (x.id === clipId ? { ...x, muted: true } : x)),
    audioClips: [...(tl.audioClips ?? []), a]
  }
}

/** Reverse of detachAudio: remove the block and un-mute its video clip. */
export function reattachAudio(tl: Timeline, audioClipId: string): Timeline {
  const a = (tl.audioClips ?? []).find((x) => x.id === audioClipId)
  if (!a) return tl
  return {
    ...tl,
    clips: a.fromClipId ? tl.clips.map((x) => (x.id === a.fromClipId ? { ...x, muted: false } : x)) : tl.clips,
    audioClips: (tl.audioClips ?? []).filter((x) => x.id !== audioClipId)
  }
}

/** Find the clip that "owns" timeline time t (the incoming clip during a transition). */
export function clipAt(tl: Timeline, t: number): ClipPlacement | null {
  const places = placeClips(tl)
  if (places.length === 0) return null
  // Later clips win inside overlaps
  for (let i = places.length - 1; i >= 0; i--) {
    const p = places[i]
    if (t >= p.start && t < p.end) return p
  }
  const last = places[places.length - 1]
  if (t >= last.end) return last
  return places[0]
}

export interface ActiveClips {
  current: ClipPlacement
  /** Outgoing clip while a transition is running */
  outgoing: ClipPlacement | null
  /** 0..1 progress of the transition (1 when no transition) */
  progress: number
}

/** Current clip plus the outgoing one (with progress) when t lies inside a transition overlap. */
export function activeClipsAt(tl: Timeline, t: number): ActiveClips | null {
  const cur = clipAt(tl, t)
  if (!cur) return null
  if (cur.overlapIn > 0 && t < cur.start + cur.overlapIn && cur.index > 0) {
    const places = placeClips(tl)
    const prev = places[cur.index - 1]
    return { current: cur, outgoing: prev, progress: Math.min(1, Math.max(0, (t - cur.start) / cur.overlapIn)) }
  }
  return { current: cur, outgoing: null, progress: 1 }
}

/** Source time of a placement at timeline time t (clamped to the clip). */
export function sourceTimeOf(p: ClipPlacement, t: number): number {
  const local = Math.min(Math.max(0, t - p.start), p.end - p.start)
  return p.clip.sourceStart + local * (p.clip.speed || 1)
}

/** Map timeline time → source (media) time of the owning clip. */
export function timelineToSource(tl: Timeline, t: number): number {
  const p = clipAt(tl, t)
  if (!p) return t
  return sourceTimeOf(p, t)
}

/** Map source time → timeline time (first clip of the given source that contains it). */
export function sourceToTimeline(tl: Timeline, s: number, sourceId?: string): number | null {
  for (const p of placeClips(tl)) {
    if ((p.clip.sourceId ?? undefined) !== (sourceId ?? undefined)) continue
    if (s >= p.clip.sourceStart && s <= p.clip.sourceEnd) {
      return p.start + (s - p.clip.sourceStart) / (p.clip.speed || 1)
    }
  }
  return null
}

/** Resolve the media asset for a source id ('screen' / 'mic' / 'system' / media asset id). */
export function assetFor(project: Project, sourceId: string | undefined): MediaAsset | undefined {
  if (!sourceId || sourceId === 'screen') return project.recording.screen
  if (sourceId === 'mic') return project.recording.mic
  if (sourceId === 'system') return project.recording.system
  return project.recording.media?.find((m) => m.id === sourceId)
}

/** Split the clip at timeline time t. Returns a new timeline. */
export function splitAt(tl: Timeline, t: number): Timeline {
  const p = clipAt(tl, t)
  if (!p || t <= p.start + p.overlapIn + 1 || t >= p.end - 1) return tl
  const s = sourceTimeOf(p, t)
  const a: Clip = { ...p.clip, id: uid('clip'), sourceEnd: s }
  const b: Clip = { ...p.clip, id: uid('clip'), sourceStart: s, transitionIn: undefined }
  const clips = [...tl.clips]
  clips.splice(p.index, 1, a, b)
  return { ...tl, clips }
}

/** Remove the timeline range [a,b) and shift everything after it left. */
export function deleteRange(tl: Timeline, a: number, b: number): Timeline {
  if (b <= a) return tl
  let t = splitAt(tl, a)
  t = splitAt(t, b)
  const places = placeClips(t)
  const keep = places.filter((p) => !(p.start >= a - 0.5 && p.end <= b + 0.5)).map((p) => p.clip)
  const removed = b - a
  const shift = (x: number): number => (x >= b ? x - removed : x > a ? a : x)
  const shiftSeg = <T extends { start: number; end: number }>(arr: T[]): T[] =>
    arr
      .map((z) => ({ ...z, start: shift(z.start), end: shift(z.end) }))
      .filter((z) => z.end - z.start > 30)
  return {
    ...t,
    clips: keep,
    zooms: shiftSeg(t.zooms),
    camera: shiftSeg(t.camera),
    texts: shiftSeg(t.texts),
    captions: shiftSeg(t.captions),
    audioClips: (t.audioClips ?? [])
      .filter((x) => !(x.start >= a - 0.5 && audioClipEnd(x) <= b + 0.5))
      .map((x) => ({ ...x, start: x.start >= b ? x.start - removed : x.start })),
    markers: t.markers.filter((m) => m.t < a || m.t >= b).map((m) => ({ ...m, t: shift(m.t) }))
  }
}

export function removeClip(tl: Timeline, clipId: string): Timeline {
  const idx = tl.clips.findIndex((c) => c.id === clipId)
  if (idx < 0) return tl
  const clips = tl.clips.filter((c) => c.id !== clipId)
  // The clip that now follows loses its transition target if it was first
  if (idx === 0 && clips[0]) clips[0] = { ...clips[0], transitionIn: undefined }
  return clampSegments({ ...tl, clips })
}

/** Trim a clip edge. `edge` = which side; `t` = new timeline position. */
export function trimClip(tl: Timeline, clipId: string, edge: 'start' | 'end', t: number): Timeline {
  const places = placeClips(tl)
  const p = places.find((x) => x.clip.id === clipId)
  if (!p) return tl
  const speed = p.clip.speed || 1
  const clips = tl.clips.map((c) => {
    if (c.id !== clipId) return c
    if (edge === 'start') {
      const delta = (t - p.start) * speed
      const ns = Math.max(0, Math.min(c.sourceEnd - 50, c.sourceStart + delta))
      return { ...c, sourceStart: ns }
    } else {
      const delta = (t - p.end) * speed
      const ne = Math.max(c.sourceStart + 50, c.sourceEnd + delta)
      return { ...c, sourceEnd: ne }
    }
  })
  return { ...tl, clips }
}

export function setClipSpeed(tl: Timeline, clipId: string, speed: number): Timeline {
  return { ...tl, clips: tl.clips.map((c) => (c.id === clipId ? { ...c, speed } : c)) }
}

export function updateClip(tl: Timeline, clipId: string, patch: Partial<Clip>): Timeline {
  return { ...tl, clips: tl.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) }
}

/** Move a clip to a new index. */
export function moveClip(tl: Timeline, clipId: string, toIndex: number): Timeline {
  const from = tl.clips.findIndex((c) => c.id === clipId)
  if (from < 0) return tl
  const clips = [...tl.clips]
  const [c] = clips.splice(from, 1)
  const idx = Math.max(0, Math.min(clips.length, toIndex))
  clips.splice(idx, 0, c)
  if (clips[0]?.transitionIn) clips[0] = { ...clips[0], transitionIn: undefined }
  return { ...tl, clips }
}

export function duplicateClip(tl: Timeline, clipId: string): Timeline {
  const idx = tl.clips.findIndex((c) => c.id === clipId)
  if (idx < 0) return tl
  const clips = [...tl.clips]
  clips.splice(idx + 1, 0, { ...tl.clips[idx], id: uid('clip') })
  return { ...tl, clips }
}

/** Merge adjacent clips that are continuous in source time & same speed. */
export function mergeContinuous(tl: Timeline): Timeline {
  const out: Clip[] = []
  for (const c of tl.clips) {
    const prev = out[out.length - 1]
    if (prev && prev.sourceId === c.sourceId && Math.abs(prev.sourceEnd - c.sourceStart) < 1 && prev.speed === c.speed && !c.transitionIn) {
      out[out.length - 1] = { ...prev, sourceEnd: c.sourceEnd }
    } else out.push({ ...c })
  }
  return { ...tl, clips: out }
}

/** Clamp all segment tracks to the timeline duration. */
export function clampSegments(tl: Timeline): Timeline {
  const d = timelineDuration(tl)
  const clampSeg = <T extends { start: number; end: number }>(arr: T[]): T[] =>
    arr.map((s) => ({ ...s, start: Math.min(s.start, d), end: Math.min(s.end, d) })).filter((s) => s.end - s.start > 30)
  return { ...tl, zooms: clampSeg(tl.zooms), camera: clampSeg(tl.camera), texts: clampSeg(tl.texts), captions: clampSeg(tl.captions) }
}

/** Snap a time to nearby interesting points */
export function snapPoints(tl: Timeline, extra: number[] = []): number[] {
  const pts = new Set<number>([0, timelineDuration(tl), ...extra])
  for (const p of placeClips(tl)) {
    pts.add(p.start)
    pts.add(p.end)
  }
  for (const z of tl.zooms) {
    pts.add(z.start)
    pts.add(z.end)
  }
  for (const a of tl.audioClips ?? []) {
    pts.add(a.start)
    pts.add(audioClipEnd(a))
  }
  for (const m of tl.markers) pts.add(m.t)
  return [...pts]
}
