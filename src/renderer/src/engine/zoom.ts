import type { RecordingEvents, RenderSettings, Timeline, ZoomSegment, Vec2 } from '@shared/types'
import { sourceToTimeline, timelineToSource } from './timeline'
import { ease, expSmooth } from './easing'
import { clamp, lerp, uid } from '@/lib/utils'
import { cursorAt } from './cursor'

export interface ZoomState {
  scale: number
  /** Focus point in cropped-normalized screen coords */
  focus: Vec2
}

const IDENTITY: ZoomState = { scale: 1, focus: { x: 0.5, y: 0.5 } }

// ── Auto-zoom generation ────────────────────────────────────────────────────

export function generateAutoZooms(events: RecordingEvents | null, timeline: Timeline, render: RenderSettings, cropOf: (p: Vec2) => Vec2): ZoomSegment[] {
  if (!events) return []
  const z = render.zoom
  const sens = z.sensitivity
  const lead = 350
  const hold = z.holdMs
  const mergeGap = sens === 'high' ? 2600 : sens === 'medium' ? 1800 : 1200
  const minClicksPerSeg = sens === 'low' ? 2 : 1
  const clicks = events.clicks.filter((c) => c.phase === 'down' && (c.button === 'left' || c.button === 'right'))
  const keys = events.keys

  type Raw = { start: number; end: number; points: Vec2[]; clicks: number }
  const raws: Raw[] = []
  for (const c of clicks) {
    const tl = sourceToTimeline(timeline, c.t)
    if (tl == null) continue
    const p = cropOf({ x: c.x, y: c.y })
    if (p.x < -0.05 || p.x > 1.05 || p.y < -0.05 || p.y > 1.05) continue
    const last = raws[raws.length - 1]
    if (last && tl - last.end < mergeGap) {
      last.end = Math.max(last.end, tl + hold)
      last.points.push(p)
      last.clicks++
    } else {
      raws.push({ start: Math.max(0, tl - lead), end: tl + hold, points: [p], clicks: 1 })
    }
  }
  // Extend segments while the user is typing (keeps zoom on input fields)
  for (const k of keys) {
    const tl = sourceToTimeline(timeline, k.t)
    if (tl == null) continue
    const seg = raws.find((r) => tl >= r.start && tl <= r.end + 1500)
    if (seg) seg.end = Math.max(seg.end, tl + hold * 0.8)
  }
  // Avoid very short gaps between segments (merge) and drop weak ones
  const merged: Raw[] = []
  for (const r of raws) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end < z.transitionMs * 1.2) {
      last.end = r.end
      last.points.push(...r.points)
      last.clicks += r.clicks
    } else merged.push(r)
  }
  return merged
    .filter((r) => r.clicks >= minClicksPerSeg || r.end - r.start > hold * 1.5)
    .map((r) => {
      // Focus = first click point (following cursor will handle subsequent moves)
      const f = r.points[0]
      return {
        id: uid('zoom'),
        start: r.start,
        end: r.end,
        focus: { x: clamp(f.x, 0, 1), y: clamp(f.y, 0, 1) },
        scale: z.defaultScale,
        origin: 'auto' as const,
        followCursor: z.followCursor
      }
    })
}

// ── Solver ──────────────────────────────────────────────────────────────────

/** Clamp a focus so the zoom viewport stays inside the screen. */
export function clampFocus(focus: Vec2, scale: number): Vec2 {
  const half = 0.5 / scale
  return { x: clamp(focus.x, half, 1 - half), y: clamp(focus.y, half, 1 - half) }
}

interface Key {
  t: number
  scale: number
  focus: Vec2
}

/**
 * Stateless evaluation of the zoom keyframe track at timeline time t,
 * ignoring cursor following. Deterministic → safe for random access.
 */
export function baseZoomAt(zooms: ZoomSegment[], t: number, render: RenderSettings): ZoomState {
  if (zooms.length === 0) return IDENTITY
  const tr = render.zoom.transitionMs
  const easing = render.zoom.easing
  const segs = [...zooms].sort((a, b) => a.start - b.start)

  // Find current or neighbouring segments
  let cur: ZoomSegment | null = null
  let prev: ZoomSegment | null = null
  let next: ZoomSegment | null = null
  for (const s of segs) {
    if (t >= s.start && t < s.end) cur = s
    else if (s.end <= t) prev = s
    else if (s.start > t && !next) next = s
  }

  const stateOf = (s: ZoomSegment): ZoomState => ({ scale: s.scale, focus: clampFocus(s.focus, s.scale) })

  if (cur) {
    // Zooming in (possibly from a previous segment)
    const from: Key = prev && cur.start - prev.end < tr ? { t: cur.start, ...stateOf(prev) } : { t: cur.start, scale: 1, focus: clampFocus(cur.focus, cur.scale) }
    const p = clamp((t - cur.start) / tr, 0, 1)
    const e = ease(easing, p)
    const to = stateOf(cur)
    return { scale: lerp(from.scale, to.scale, e), focus: { x: lerp(from.focus.x, to.focus.x, e), y: lerp(from.focus.y, to.focus.y, e) } }
  }
  if (prev && t - prev.end < tr) {
    // Zooming out from prev (or towards next if it starts immediately)
    const from = stateOf(prev)
    const to: ZoomState = next && next.start - prev.end < tr ? stateOf(next) : { scale: 1, focus: from.focus }
    const p = clamp((t - prev.end) / tr, 0, 1)
    const e = ease(easing === 'spring' ? 'ease-in-out' : easing, p)
    return { scale: lerp(from.scale, to.scale, e), focus: { x: lerp(from.focus.x, to.focus.x, e), y: lerp(from.focus.y, to.focus.y, e) } }
  }
  return IDENTITY
}

/**
 * Stateful solver that adds cursor following with a dead-zone, so the camera
 * pans smoothly when the cursor approaches the edge of the zoomed viewport.
 * Works for sequential playback and re-simulates on seeks.
 */
export class ZoomSolver {
  private lastT = -Infinity
  private follow: Vec2 = { x: 0.5, y: 0.5 }
  private followActive = false

  constructor(
    private timeline: Timeline,
    private render: RenderSettings,
    private events: RecordingEvents | null,
    private cropOf: (p: Vec2) => Vec2
  ) {}

  update(timeline: Timeline, render: RenderSettings, events: RecordingEvents | null, cropOf: (p: Vec2) => Vec2): void {
    this.timeline = timeline
    this.render = render
    this.events = events
    this.cropOf = cropOf
  }

  reset(): void {
    this.lastT = -Infinity
    this.followActive = false
  }

  private activeSegment(t: number): ZoomSegment | null {
    for (const s of this.timeline.zooms) if (t >= s.start && t < s.end) return s
    return null
  }

  private cursorTL(t: number): Vec2 | null {
    if (!this.events) return null
    const s = timelineToSource(this.timeline, t)
    const c = cursorAt(this.events, s, this.render.cursor.smoothing)
    return c ? this.cropOf(c) : null
  }

  /** Evaluate at timeline time t (ms). */
  at(t: number): ZoomState {
    const base = baseZoomAt(this.timeline.zooms, t, this.render)
    const seg = this.activeSegment(t)
    const wantFollow = !!seg && seg.followCursor && this.render.zoom.followCursor && !!this.events
    if (!wantFollow && !this.followActive) {
      this.lastT = t
      return base
    }
    // Sequential step or re-simulate
    const dt = t - this.lastT
    if (!(dt > 0 && dt < 250)) {
      // Re-simulate from a bit before the segment start
      const from = Math.max((seg?.start ?? t) - 200, t - 4000)
      this.followActive = false
      this.lastT = from
      const step = 1000 / 60
      for (let x = from; x < t; x += step) this.step(x, step)
    }
    return this.step(t, Math.max(1, t - this.lastT))
  }

  private step(t: number, dt: number): ZoomState {
    this.lastT = t
    const base = baseZoomAt(this.timeline.zooms, t, this.render)
    const seg = this.activeSegment(t)
    const follow = !!seg && seg.followCursor && this.render.zoom.followCursor
    if (!follow) {
      if (this.followActive) {
        // ease the follow offset back to base focus while zooming out
        this.follow.x = expSmooth(this.follow.x, base.focus.x, dt, 120)
        this.follow.y = expSmooth(this.follow.y, base.focus.y, dt, 120)
        if (base.scale <= 1.001) this.followActive = false
        return { scale: base.scale, focus: clampFocus(this.follow, base.scale) }
      }
      return base
    }
    if (!this.followActive) {
      this.follow = { ...base.focus }
      this.followActive = true
    }
    const cursor = this.cursorTL(t)
    const scale = base.scale
    const target = { ...this.follow }
    if (cursor && scale > 1.05) {
      // Dead-zone: viewport half-size = 0.5/scale; keep cursor inside inner 55%
      const half = 0.5 / scale
      const inner = half * 0.55
      const dx = cursor.x - this.follow.x
      const dy = cursor.y - this.follow.y
      if (dx > inner) target.x = cursor.x - inner
      else if (dx < -inner) target.x = cursor.x + inner
      if (dy > inner) target.y = cursor.y - inner
      else if (dy < -inner) target.y = cursor.y + inner
    }
    // While the zoom-in transition runs, stay locked to the base (click) focus
    const trP = clamp((t - (seg!.start ?? t)) / this.render.zoom.transitionMs, 0, 1)
    const halfLife = 60 + (1 - this.render.zoom.followSmoothing) * 40 + this.render.zoom.followSmoothing * 260
    const clampedTarget = clampFocus(target, Math.max(1.0001, scale))
    this.follow.x = expSmooth(this.follow.x, lerp(base.focus.x, clampedTarget.x, trP), dt, halfLife)
    this.follow.y = expSmooth(this.follow.y, lerp(base.focus.y, clampedTarget.y, trP), dt, halfLife)
    return { scale, focus: clampFocus(this.follow, Math.max(1.0001, scale)) }
  }
}
