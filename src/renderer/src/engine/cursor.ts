import type { RecordingEvents, CursorSample, ClickEvent, RenderSettings, Vec2, CursorKind } from '@shared/types'
import { clamp, lerp } from '@/lib/utils'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Binary search: index of last sample with t <= time */
function indexAt(samples: CursorSample[], t: number): number {
  let lo = 0
  let hi = samples.length - 1
  if (hi < 0) return -1
  if (t < samples[0].t) return -1
  if (t >= samples[hi].t) return hi
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].t <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Raw interpolated cursor position at source time s. */
export function rawCursorAt(events: RecordingEvents | null, s: number): Vec2 | null {
  if (!events || events.cursor.length === 0) return null
  const c = events.cursor
  const i = indexAt(c, s)
  if (i < 0) return { x: c[0].x, y: c[0].y }
  if (i >= c.length - 1) return { x: c[i].x, y: c[i].y }
  const a = c[i]
  const b = c[i + 1]
  const span = b.t - a.t
  const f = span <= 0 ? 0 : clamp((s - a.t) / span, 0, 1)
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) }
}

/**
 * Smoothed cursor position. Smoothing uses a Gaussian-weighted window over the
 * raw path so the result is deterministic for any time (export-safe) and does
 * not depend on the previous frame.
 */
export function cursorAt(events: RecordingEvents | null, s: number, smoothing: number): Vec2 | null {
  if (!events || events.cursor.length === 0) return null
  if (smoothing <= 0.01) return rawCursorAt(events, s)
  const windowMs = 20 + smoothing * 140 // 20..160 ms std-dev
  const taps = 9
  let sx = 0
  let sy = 0
  let sw = 0
  for (let i = -taps; i <= taps; i++) {
    const dt = (i / taps) * windowMs * 2
    const w = Math.exp(-(dt * dt) / (2 * windowMs * windowMs))
    const p = rawCursorAt(events, s + dt)
    if (!p) continue
    sx += p.x * w
    sy += p.y * w
    sw += w
  }
  if (sw === 0) return rawCursorAt(events, s)
  return { x: sx / sw, y: sy / sw }
}

/** Cursor shape at source time s (last known kind). */
export function cursorKindAt(events: RecordingEvents | null, s: number): CursorKind {
  if (!events || events.cursor.length === 0) return 'arrow'
  const c = events.cursor
  let i = indexAt(c, s)
  if (i < 0) return 'arrow'
  // walk back to the last sample carrying a kind (kinds are sparse)
  for (; i >= 0; i--) {
    const k = c[i].k
    if (k) return k
    if (i < c.length - 400 && i % 400 === 0) break // bound the scan on huge arrays
  }
  return 'arrow'
}

/** Approximate speed (normalized units per second) — used for idle detection & motion blur. */
export function cursorSpeedAt(events: RecordingEvents | null, s: number): number {
  const a = rawCursorAt(events, s - 40)
  const b = rawCursorAt(events, s + 40)
  if (!a || !b) return 0
  return Math.hypot(b.x - a.x, b.y - a.y) / 0.08
}

/** Time (ms) since the cursor last moved meaningfully before s. */
export function idleTimeAt(events: RecordingEvents | null, s: number): number {
  if (!events || events.cursor.length === 0) return Infinity
  const c = events.cursor
  let i = indexAt(c, s)
  if (i < 0) return Infinity
  const ref = c[i]
  while (i > 0) {
    const p = c[i - 1]
    if (Math.hypot(p.x - ref.x, p.y - ref.y) > 0.003) return s - c[i].t
    i--
  }
  return s - c[0].t
}

export function clicksAround(events: RecordingEvents | null, s: number, beforeMs: number, afterMs = 0): ClickEvent[] {
  if (!events) return []
  return events.clicks.filter((c) => c.phase === 'down' && c.t <= s + afterMs && c.t >= s - beforeMs)
}

/** Is any mouse button held at time s? */
export function isPressedAt(events: RecordingEvents | null, s: number): boolean {
  if (!events) return false
  let down = false
  for (const c of events.clicks) {
    if (c.t > s) break
    if (c.button === 'left') down = c.phase === 'down'
  }
  return down
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/**
 * Draw the cursor sprite at (x,y) with tip at that point. `size` is the
 * height of the arrow in output pixels.
 */
export function drawCursor(ctx: Ctx, style: RenderSettings['cursor']['style'], x: number, y: number, size: number, opts: { tint?: string | null; pressed?: boolean; alpha?: number; kind?: CursorKind } = {}): void {
  const alpha = opts.alpha ?? 1
  if (alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  const s = size / 24
  ctx.scale(s, s)
  const fill = opts.tint ?? (style === 'arrow-dark' ? '#111318' : '#ffffff')
  const stroke = style === 'arrow-dark' || (opts.tint && opts.tint !== '#ffffff') ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.85)'
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 1.5
  const kind = opts.kind ?? 'arrow'
  const arrowLike = style === 'arrow' || style === 'arrow-dark'
  if (arrowLike && kind === 'ibeam') {
    // I-beam centred on the hotspot
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.strokeStyle = stroke
    const beam = (): void => {
      ctx.beginPath()
      ctx.moveTo(0, -9)
      ctx.lineTo(0, 9)
      ctx.moveTo(-3.5, -9.5)
      ctx.lineTo(3.5, -9.5)
      ctx.moveTo(-3.5, 9.5)
      ctx.lineTo(3.5, 9.5)
      ctx.stroke()
    }
    ctx.lineWidth = 4
    beam()
    ctx.strokeStyle = fill
    ctx.lineWidth = 1.8
    beam()
    ctx.restore()
    return
  }
  if (arrowLike && (kind === 'resize-h' || kind === 'resize-v' || kind === 'resize-d' || kind === 'move')) {
    ctx.rotate(kind === 'resize-v' ? Math.PI / 2 : kind === 'resize-d' ? Math.PI / 4 : 0)
    const arrow = (): void => {
      ctx.beginPath()
      ctx.moveTo(-11, 0)
      ctx.lineTo(-6, -4.5)
      ctx.lineTo(-6, -1.6)
      ctx.lineTo(6, -1.6)
      ctx.lineTo(6, -4.5)
      ctx.lineTo(11, 0)
      ctx.lineTo(6, 4.5)
      ctx.lineTo(6, 1.6)
      ctx.lineTo(-6, 1.6)
      ctx.lineTo(-6, 4.5)
      ctx.closePath()
    }
    arrow()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1.4
    ctx.lineJoin = 'round'
    ctx.strokeStyle = stroke
    ctx.stroke()
    if (kind === 'move') {
      ctx.rotate(Math.PI / 2)
      arrow()
      ctx.fill()
      ctx.stroke()
    }
    ctx.restore()
    return
  }
  const effStyle = arrowLike && kind === 'hand' ? 'hand' : style
  if (effStyle === 'dot') {
    ctx.beginPath()
    ctx.arc(0, 0, opts.pressed ? 6 : 7.5, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1.8
    ctx.strokeStyle = stroke
    ctx.stroke()
  } else if (effStyle === 'ring') {
    ctx.beginPath()
    ctx.arc(0, 0, opts.pressed ? 8 : 10, 0, Math.PI * 2)
    ctx.lineWidth = 3
    ctx.strokeStyle = fill
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, 0, 2.2, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
  } else if (effStyle === 'hand') {
    // Simplified hand pointer
    ctx.beginPath()
    ctx.moveTo(6, 22)
    ctx.lineTo(3, 14)
    ctx.quadraticCurveTo(1, 10, 4, 10)
    ctx.lineTo(7, 13)
    ctx.lineTo(7, 2.5)
    ctx.quadraticCurveTo(7, 0, 9.5, 0)
    ctx.quadraticCurveTo(12, 0, 12, 2.5)
    ctx.lineTo(12, 9)
    ctx.lineTo(14, 8.6)
    ctx.quadraticCurveTo(16.5, 8.2, 16.7, 10.4)
    ctx.lineTo(18.5, 10.2)
    ctx.quadraticCurveTo(21, 10, 21, 12.4)
    ctx.lineTo(21, 15)
    ctx.quadraticCurveTo(21, 19, 19, 22)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.strokeStyle = stroke
    ctx.stroke()
  } else {
    // Classic arrow (tip at origin)
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(0, 18.5)
    ctx.lineTo(4.6, 14.3)
    ctx.lineTo(8.2, 22)
    ctx.lineTo(11.4, 20.6)
    ctx.lineTo(7.8, 13)
    ctx.lineTo(13.6, 13)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1.6
    ctx.lineJoin = 'round'
    ctx.strokeStyle = stroke
    ctx.stroke()
  }
  ctx.restore()
}

export function drawMotionTrail(ctx: Ctx, points: Array<{ x: number; y: number; a: number }>, size: number, color: string): void {
  if (points.length < 2) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]
    const q = points[i]
    ctx.globalAlpha = q.a
    ctx.strokeStyle = color
    ctx.lineWidth = size * 0.28 * (i / points.length)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    ctx.lineTo(q.x, q.y)
    ctx.stroke()
  }
  ctx.restore()
}

/** Draw click ripple / pulse / spotlight effects. `age` is ms since click. */
export function drawClickEffect(ctx: Ctx, effect: RenderSettings['cursor']['clickEffect'], x: number, y: number, age: number, size: number, color: string, button: ClickEvent['button']): void {
  if (effect === 'none') return
  const life = effect === 'spotlight' ? 900 : 650
  if (age < 0 || age > life) return
  const p = age / life
  ctx.save()
  if (effect === 'ripple') {
    const r = size * (0.6 + p * 2.4)
    ctx.globalAlpha = (1 - p) * 0.9
    ctx.lineWidth = Math.max(1.5, size * 0.12 * (1 - p))
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
    if (p < 0.5) {
      ctx.globalAlpha = (0.5 - p) * 0.5
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, r * 0.8, 0, Math.PI * 2)
      ctx.fill()
    }
    if (button === 'right') {
      // second ring for right click
      ctx.globalAlpha = (1 - p) * 0.6
      ctx.beginPath()
      ctx.arc(x, y, r * 0.55, 0, Math.PI * 2)
      ctx.stroke()
    }
  } else if (effect === 'pulse') {
    const r = size * (1.4 - p * 0.6)
    ctx.globalAlpha = (1 - p) * 0.55
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, color)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  } else if (effect === 'spotlight') {
    const r = size * 3.2
    ctx.globalAlpha = Math.sin(p * Math.PI) * 0.45
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, color)
    g.addColorStop(0.6, color.replace(/[\d.]+\)$/, '0.25)'))
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}
