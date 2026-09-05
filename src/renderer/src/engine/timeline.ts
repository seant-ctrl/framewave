import type { Clip, Timeline } from '@shared/types'
import { uid } from '@/lib/utils'

/** Duration of a clip on the timeline (accounting for speed). */
export function clipDuration(c: Clip): number {
  return Math.max(0, (c.sourceEnd - c.sourceStart) / (c.speed || 1))
}

export function timelineDuration(tl: Timeline): number {
  return tl.clips.reduce((a, c) => a + clipDuration(c), 0)
}

export interface ClipPlacement {
  clip: Clip
  index: number
  start: number // timeline start
  end: number // timeline end
}

export function placeClips(tl: Timeline): ClipPlacement[] {
  let t = 0
  return tl.clips.map((clip, index) => {
    const start = t
    t += clipDuration(clip)
    return { clip, index, start, end: t }
  })
}

/** Find which clip a timeline time falls in. */
export function clipAt(tl: Timeline, t: number): ClipPlacement | null {
  const places = placeClips(tl)
  if (places.length === 0) return null
  for (const p of places) {
    if (t >= p.start && t < p.end) return p
  }
  const last = places[places.length - 1]
  if (t >= last.end) return last
  return places[0]
}

/** Map timeline time → source (media) time. */
export function timelineToSource(tl: Timeline, t: number): number {
  const p = clipAt(tl, t)
  if (!p) return t
  const local = Math.min(Math.max(0, t - p.start), p.end - p.start)
  return p.clip.sourceStart + local * (p.clip.speed || 1)
}

/** Map source time → timeline time (first match). */
export function sourceToTimeline(tl: Timeline, s: number): number | null {
  for (const p of placeClips(tl)) {
    if (s >= p.clip.sourceStart && s <= p.clip.sourceEnd) {
      return p.start + (s - p.clip.sourceStart) / (p.clip.speed || 1)
    }
  }
  return null
}

/** Split the clip at timeline time t. Returns a new timeline. */
export function splitAt(tl: Timeline, t: number): Timeline {
  const p = clipAt(tl, t)
  if (!p || t <= p.start + 1 || t >= p.end - 1) return tl
  const s = timelineToSource(tl, t)
  const a: Clip = { ...p.clip, id: uid('clip'), sourceEnd: s }
  const b: Clip = { ...p.clip, id: uid('clip'), sourceStart: s }
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
    markers: t.markers.filter((m) => m.t < a || m.t >= b).map((m) => ({ ...m, t: shift(m.t) }))
  }
}

export function removeClip(tl: Timeline, clipId: string): Timeline {
  const p = placeClips(tl).find((x) => x.clip.id === clipId)
  if (!p) return tl
  return deleteRange(tl, p.start, p.end)
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

/** Merge adjacent clips that are continuous in source time & same speed. */
export function mergeContinuous(tl: Timeline): Timeline {
  const out: Clip[] = []
  for (const c of tl.clips) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(prev.sourceEnd - c.sourceStart) < 1 && prev.speed === c.speed) {
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
  for (const m of tl.markers) pts.add(m.t)
  return [...pts]
}
