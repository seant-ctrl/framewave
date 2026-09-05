import type { Project, RecordingEvents, RenderSettings, Timeline, Vec2, CameraSegment, TextOverlay, KeyEvent, Rect, TransitionType } from '@shared/types'
import { computeLayout, fullToCropped, roundRectPath, squirclePath, type Layout } from './layout'
import { drawBackground } from './background'
import { ZoomSolver, type ZoomState } from './zoom'
import { cursorAt, rawCursorAt, drawCursor, drawClickEffect, idleTimeAt, isPressedAt, drawMotionTrail, cursorKindAt } from './cursor'
import { timelineToSource } from './timeline'
import { clamp, lerp, rgba } from '@/lib/utils'
import { ease } from './easing'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface FrameSource {
  image: CanvasImageSource
  width: number
  height: number
}

export interface FrameSources {
  screen: FrameSource | null
  camera: FrameSource | null
  /** Outgoing clip frame while a transition is running */
  outgoing?: FrameSource | null
  transition?: { type: TransitionType; progress: number }
  /** Current clip's source id (undefined/'screen' = the recording) and fit mode */
  sourceId?: string
  fit?: 'contain' | 'cover'
  outgoingFit?: 'contain' | 'cover'
}

export interface RenderOptions {
  /** Draw lower-cost effects (preview) */
  preview?: boolean
  /** Show guides (safe zones / camera bounds) */
  guides?: boolean
  /** Highlight a text overlay id */
  selectedTextId?: string | null
}

interface Transform {
  s: number
  tx: number
  ty: number
  px: number
  py: number
}

export class Compositor {
  private zoom: ZoomSolver
  private layoutCache: { key: string; layout: Layout } | null = null
  private shadowCache: { key: string; canvas: OffscreenCanvas; margin: number } | null = null

  constructor(
    public project: Project,
    public events: RecordingEvents | null
  ) {
    this.zoom = new ZoomSolver(project.timeline, project.render, events, (p) => this.cropOf(p))
  }

  update(project: Project, events: RecordingEvents | null): void {
    this.project = project
    this.events = events
    this.zoom.update(project.timeline, project.render, events, (p) => this.cropOf(p))
  }

  resetMotion(): void {
    this.zoom.reset()
  }

  get render(): RenderSettings {
    return this.project.render
  }
  get timeline(): Timeline {
    return this.project.timeline
  }

  /** Convert a full-video normalized point to cropped-normalized */
  cropOf(p: Vec2): Vec2 {
    return fullToCropped(this.layout(), p.x, p.y)
  }

  layout(size?: { width: number; height: number }): Layout {
    const r = this.project.recording
    const key = JSON.stringify([this.render.aspect, this.render.outputHeight, this.render.padding, this.render.crop, r.width, r.height, size])
    if (this.layoutCache && this.layoutCache.key === key) return this.layoutCache.layout
    const layout = computeLayout(this.render, r.width || 1920, r.height || 1080, size)
    this.layoutCache = { key, layout }
    return layout
  }

  zoomAt(t: number): ZoomState {
    return this.zoom.at(t)
  }

  /** Compute the screen frame transform for a zoom state. */
  transformFor(layout: Layout, z: ZoomState): Transform {
    const F = layout.screen
    const s = z.scale
    const px = F.x + z.focus.x * F.width
    const py = F.y + z.focus.y * F.height
    // scaled frame rect
    const x1 = px + (F.x - px) * s
    const y1 = py + (F.y - py) * s
    const w1 = F.width * s
    const h1 = F.height * s
    let tx = 0
    let ty = 0
    // Keep the zoomed frame covering the canvas when it is large enough
    if (w1 >= layout.width) {
      if (x1 > 0) tx = -x1
      else if (x1 + w1 < layout.width) tx = layout.width - (x1 + w1)
    } else if (s > 1.001) {
      // Interpolate towards centering as the frame grows
      const k = clamp((s - 1) / 0.6, 0, 1)
      tx = ((layout.width - w1) / 2 - x1) * k
    }
    if (h1 >= layout.height) {
      if (y1 > 0) ty = -y1
      else if (y1 + h1 < layout.height) ty = layout.height - (y1 + h1)
    } else if (s > 1.001) {
      const k = clamp((s - 1) / 0.6, 0, 1)
      ty = ((layout.height - h1) / 2 - y1) * k
    }
    return { s, tx, ty, px, py }
  }

  /** Map a cropped-normalized screen point to output pixels under the transform. */
  toOutput(layout: Layout, tr: Transform, p: Vec2): Vec2 {
    const F = layout.screen
    const x = F.x + p.x * F.width
    const y = F.y + p.y * F.height
    return { x: tr.px + (x - tr.px) * tr.s + tr.tx, y: tr.py + (y - tr.py) * tr.s + tr.ty }
  }

  /** Inverse: output pixel → cropped-normalized screen point */
  fromOutput(layout: Layout, tr: Transform, o: Vec2): Vec2 {
    const F = layout.screen
    const x = (o.x - tr.tx - tr.px) / tr.s + tr.px
    const y = (o.y - tr.ty - tr.py) / tr.s + tr.py
    return { x: (x - F.x) / F.width, y: (y - F.y) / F.height }
  }

  cameraSegmentAt(t: number): CameraSegment | null {
    for (const s of this.timeline.camera) if (t >= s.start && t < s.end) return s
    return null
  }

  /** Rect (output px) where the camera is drawn; null if hidden. */
  cameraRect(layout: Layout, t: number): { rect: Rect; fullscreen: boolean } | null {
    const cam = this.render.camera
    const seg = this.cameraSegmentAt(t)
    if (!cam.enabled) return null
    if (seg && !seg.visible) return null
    if (seg?.fullscreen) return { rect: { x: 0, y: 0, width: layout.width, height: layout.height }, fullscreen: true }
    const size = (seg?.size ?? cam.size) * layout.height
    const margin = cam.margin * layout.unit
    const pos = seg?.position ?? cam.position
    let x: number
    let y: number
    switch (pos) {
      case 'top-left':
        x = margin
        y = margin
        break
      case 'top-right':
        x = layout.width - margin - size
        y = margin
        break
      case 'bottom-left':
        x = margin
        y = layout.height - margin - size
        break
      case 'bottom-right':
        x = layout.width - margin - size
        y = layout.height - margin - size
        break
      default:
        x = cam.custom.x * layout.width - size / 2
        y = cam.custom.y * layout.height - size / 2
    }
    return { rect: { x, y, width: size, height: size }, fullscreen: false }
  }

  // ── Main render ─────────────────────────────────────────────────────────

  renderFrame(ctx: Ctx, t: number, sources: FrameSources, opts: RenderOptions = {}): void {
    const layout = this.layout({ width: ctx.canvas.width, height: ctx.canvas.height })
    const r = this.render
    const W = layout.width
    const H = layout.height
    const s = timelineToSource(this.timeline, t)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = opts.preview ? 'medium' : 'high'

    // 1. Background
    drawBackground(ctx, W, H, r.background, sources.screen ? { image: sources.screen.image, width: sources.screen.width, height: sources.screen.height } : null)

    // 2. Zoom transform
    const z = this.zoomAt(t)
    const tr = this.transformFor(layout, z)

    const camInfo = this.cameraRect(layout, t)
    const fullscreenCam = camInfo?.fullscreen && sources.camera

    if (!fullscreenCam) {
      ctx.save()
      ctx.translate(tr.tx, tr.ty)
      ctx.translate(tr.px, tr.py)
      ctx.scale(tr.s, tr.s)
      ctx.translate(-tr.px, -tr.py)
      this.drawScreenFrame(ctx, layout, sources, opts)
      ctx.restore()

      // 3. Cursor + click effects (only for the recording's own footage)
      const isRecordingSource = !sources.sourceId || sources.sourceId === 'screen'
      if (r.cursor.mode !== 'hidden' && this.events && isRecordingSource) {
        this.drawCursorLayer(ctx, layout, tr, t, s, opts)
      }
    }

    // 4. Camera
    if (camInfo && sources.camera) this.drawCamera(ctx, layout, camInfo.rect, camInfo.fullscreen, sources.camera, t)

    // 5. Keystrokes
    if (r.keystrokes.enabled && this.events) this.drawKeystrokes(ctx, layout, s)

    // 6. Text overlays
    for (const tx of this.timeline.texts) {
      if (t >= tx.start && t < tx.end) this.drawText(ctx, layout, tx, t, opts.selectedTextId === tx.id)
    }

    // 7. Captions
    if (r.captions.enabled) this.drawCaptions(ctx, layout, t)

    // 8. Vignette
    if (r.color.vignette > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, `rgba(0,0,0,${r.color.vignette * 0.9})`)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
    }

    if (opts.guides) this.drawGuides(ctx, layout)
    ctx.restore()
  }

  private colorFilter(): string {
    const c = this.render.color
    if (!c.brightness && !c.contrast && !c.saturation) return 'none'
    return `brightness(${1 + c.brightness}) contrast(${1 + c.contrast}) saturate(${1 + c.saturation})`
  }

  /** Draw a source into the frame rect honoring crop (recording) or fit mode (montage media). */
  private drawSource(ctx: Ctx, layout: Layout, src: FrameSource, isRecording: boolean, fit: 'contain' | 'cover' | undefined, F: Rect): void {
    const filter = this.colorFilter()
    if (filter !== 'none') ctx.filter = filter
    try {
      if (isRecording) {
        const c = layout.crop
        ctx.drawImage(src.image, c.x * src.width, c.y * src.height, c.width * src.width, c.height * src.height, F.x, F.y, F.width, F.height)
      } else {
        const sa = src.width / Math.max(1, src.height)
        const fa = F.width / Math.max(1, F.height)
        if ((fit ?? 'cover') === 'cover') {
          // crop source to fill the frame
          let sw = src.width
          let sh = src.height
          if (sa > fa) sw = src.height * fa
          else sh = src.width / fa
          ctx.drawImage(src.image, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, F.x, F.y, F.width, F.height)
        } else {
          let dw = F.width
          let dh = F.height
          if (sa > fa) dh = F.width / sa
          else dw = F.height * sa
          ctx.drawImage(src.image, F.x + (F.width - dw) / 2, F.y + (F.height - dh) / 2, dw, dh)
        }
      }
    } catch {
      /* frame not ready */
    }
    ctx.filter = 'none'
  }

  /** Draw current (and outgoing) sources with the active transition inside the frame rect. */
  private drawContent(ctx: Ctx, layout: Layout, sources: FrameSources, F: Rect): void {
    const isRec = !sources.sourceId || sources.sourceId === 'screen'
    const tr = sources.transition
    const cur = sources.screen
    const out = sources.outgoing ?? null
    const drawCur = (): void => {
      if (cur) this.drawSource(ctx, layout, cur, isRec, sources.fit, F)
    }
    const drawOut = (): void => {
      if (out) this.drawSource(ctx, layout, out, false, sources.outgoingFit, F)
    }
    if (!tr || tr.progress >= 1 || !out) {
      drawCur()
      return
    }
    const p = clamp(tr.progress, 0, 1)
    const e = ease('ease-in-out', p)
    switch (tr.type) {
      case 'fade':
        drawOut()
        ctx.save()
        ctx.globalAlpha = e
        drawCur()
        ctx.restore()
        break
      case 'dip-black':
      case 'dip-white': {
        const color = tr.type === 'dip-black' ? '#000' : '#fff'
        if (p < 0.5) {
          drawOut()
          ctx.save()
          ctx.globalAlpha = ease('ease-in-out', p * 2)
          ctx.fillStyle = color
          ctx.fillRect(F.x, F.y, F.width, F.height)
          ctx.restore()
        } else {
          drawCur()
          ctx.save()
          ctx.globalAlpha = 1 - ease('ease-in-out', (p - 0.5) * 2)
          ctx.fillStyle = color
          ctx.fillRect(F.x, F.y, F.width, F.height)
          ctx.restore()
        }
        break
      }
      case 'slide-left':
      case 'slide-right':
      case 'slide-up':
      case 'slide-down': {
        const dx = tr.type === 'slide-left' ? -1 : tr.type === 'slide-right' ? 1 : 0
        const dy = tr.type === 'slide-up' ? -1 : tr.type === 'slide-down' ? 1 : 0
        ctx.save()
        ctx.translate(dx * e * F.width, dy * e * F.height)
        drawOut()
        ctx.restore()
        ctx.save()
        ctx.translate(-dx * (1 - e) * F.width, -dy * (1 - e) * F.height)
        drawCur()
        ctx.restore()
        break
      }
      case 'wipe':
        drawOut()
        ctx.save()
        ctx.beginPath()
        ctx.rect(F.x, F.y, F.width * e, F.height)
        ctx.clip()
        drawCur()
        ctx.restore()
        break
      case 'zoom': {
        ctx.save()
        const s1 = 1 + e * 0.35
        ctx.translate(F.x + F.width / 2, F.y + F.height / 2)
        ctx.scale(s1, s1)
        ctx.translate(-(F.x + F.width / 2), -(F.y + F.height / 2))
        ctx.globalAlpha = 1 - e
        drawOut()
        ctx.restore()
        ctx.save()
        const s2 = 0.8 + e * 0.2
        ctx.translate(F.x + F.width / 2, F.y + F.height / 2)
        ctx.scale(s2, s2)
        ctx.translate(-(F.x + F.width / 2), -(F.y + F.height / 2))
        ctx.globalAlpha = e
        drawCur()
        ctx.restore()
        break
      }
      case 'blur': {
        const b = Math.sin(p * Math.PI) * 24 * layout.unit
        ctx.save()
        ctx.filter = `blur(${b.toFixed(1)}px)`
        if (p < 0.5) drawOut()
        else drawCur()
        ctx.filter = 'none'
        ctx.restore()
        ctx.save()
        ctx.globalAlpha = p < 0.5 ? 0 : (p - 0.5) * 2
        if (p >= 0.5) drawCur()
        ctx.restore()
        break
      }
      default:
        drawCur()
    }
  }

  private drawScreenFrame(ctx: Ctx, layout: Layout, sources: FrameSources, opts: RenderOptions): void {
    const r = this.render
    const F = layout.screen
    const radius = r.cornerRadius * layout.unit
    const shape = (): void => roundRectPath(ctx, F.x, F.y, F.width, F.height, radius)
    const screen = sources.screen

    // Shadow (pre-rendered once per layout/settings — blur is expensive per frame)
    if (r.shadow.enabled && r.shadow.opacity > 0 && r.background.type !== 'transparent') {
      const blur = r.shadow.blur * layout.unit
      const offY = r.shadow.offsetY * layout.unit
      const sp = r.shadow.spread * layout.unit
      const margin = Math.ceil(blur * 2 + Math.abs(offY) + sp + 4)
      const key = JSON.stringify([Math.round(F.width), Math.round(F.height), radius, blur, offY, sp, r.shadow.opacity])
      if (!this.shadowCache || this.shadowCache.key !== key) {
        const w = Math.ceil(F.width + margin * 2)
        const h = Math.ceil(F.height + margin * 2)
        const c = new OffscreenCanvas(Math.max(1, w), Math.max(1, h))
        const g = c.getContext('2d')!
        g.shadowColor = `rgba(0,0,0,${r.shadow.opacity})`
        g.shadowBlur = blur
        g.shadowOffsetY = offY
        roundRectPath(g, margin - sp, margin - sp, F.width + sp * 2, F.height + sp * 2, radius + sp)
        g.fillStyle = 'rgba(0,0,0,1)'
        g.fill()
        // Punch out the frame area so the shadow never tints the video edges
        g.shadowColor = 'transparent'
        g.globalCompositeOperation = 'destination-out'
        roundRectPath(g, margin, margin, F.width, F.height, radius)
        g.fill()
        this.shadowCache = { key, canvas: c, margin }
      }
      ctx.drawImage(this.shadowCache.canvas, F.x - this.shadowCache.margin, F.y - this.shadowCache.margin)
    }

    // Video
    ctx.save()
    shape()
    ctx.clip()
    ctx.fillStyle = '#000'
    ctx.fillRect(F.x, F.y, F.width, F.height)
    if (screen || sources.outgoing) {
      this.drawContent(ctx, layout, sources, F)
    } else if (opts.preview) {
      ctx.fillStyle = '#14151f'
      ctx.fillRect(F.x, F.y, F.width, F.height)
    }
    ctx.restore()

    // Border
    if (r.border.enabled && r.border.width > 0) {
      ctx.save()
      shape()
      ctx.lineWidth = r.border.width * layout.unit
      ctx.strokeStyle = rgba(r.border.color, r.border.opacity)
      ctx.stroke()
      ctx.restore()
    }
    // Subtle inner highlight for depth
    if (r.background.type !== 'transparent' && radius > 0) {
      ctx.save()
      shape()
      ctx.lineWidth = Math.max(1, layout.unit)
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawCursorLayer(ctx: Ctx, layout: Layout, tr: Transform, t: number, s: number, opts: RenderOptions): void {
    const r = this.render.cursor
    const ev = this.events!
    const pos = cursorAt(ev, s, r.smoothing)
    if (!pos) return
    const cp = this.cropOf(pos)
    if (cp.x < -0.02 || cp.x > 1.02 || cp.y < -0.02 || cp.y > 1.02) return
    const o = this.toOutput(layout, tr, cp)
    const zoomBoost = Math.sqrt(tr.s)
    const size = 26 * layout.unit * r.size * zoomBoost

    // Idle fade
    let alpha = 1
    if (r.hideWhenIdle) {
      const idle = idleTimeAt(ev, s)
      alpha = 1 - clamp((idle - r.idleAfterMs) / 400, 0, 1)
    }

    // Click effects
    if (r.clickEffect !== 'none') {
      for (const c of ev.clicks) {
        if (c.phase !== 'down') continue
        const age = s - c.t
        if (age < 0 || age > 1000) continue
        const p = this.toOutput(layout, tr, this.cropOf({ x: c.x, y: c.y }))
        drawClickEffect(ctx, r.clickEffect, p.x, p.y, age, size * 0.9, r.clickColor, c.button)
      }
    }

    // Motion trail
    if (r.motionBlur && !opts.preview) {
      const pts: Array<{ x: number; y: number; a: number }> = []
      for (let i = 6; i >= 1; i--) {
        const q = rawCursorAt(ev, s - i * 12)
        if (!q) continue
        const qo = this.toOutput(layout, tr, this.cropOf(q))
        pts.push({ x: qo.x, y: qo.y, a: (1 - i / 7) * 0.35 * alpha })
      }
      pts.push({ x: o.x, y: o.y, a: 0.35 * alpha })
      const dist = pts.length > 1 ? Math.hypot(pts[0].x - o.x, pts[0].y - o.y) : 0
      if (dist > size * 0.6) drawMotionTrail(ctx, pts, size, r.tint ?? '#ffffff')
    }

    const kind = r.adaptiveShape === false ? 'arrow' : cursorKindAt(ev, s)
    drawCursor(ctx, r.style, o.x, o.y, size, { tint: r.tint, pressed: isPressedAt(ev, s), alpha, kind })
  }

  private drawCamera(ctx: Ctx, layout: Layout, rect: Rect, fullscreen: boolean, cam: FrameSource, t: number): void {
    const c = this.render.camera
    ctx.save()
    const radius = fullscreen ? 0 : c.shape === 'circle' ? rect.width / 2 : c.shape === 'rounded' ? c.radius * layout.unit : c.shape === 'square' ? 0 : 0
    const path = (): void => {
      if (fullscreen) {
        ctx.beginPath()
        ctx.rect(rect.x, rect.y, rect.width, rect.height)
      } else if (c.shape === 'squircle') squirclePath(ctx, rect.x, rect.y, rect.width, rect.height, 4)
      else roundRectPath(ctx, rect.x, rect.y, rect.width, rect.height, radius)
    }
    if (c.shadow && !fullscreen) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 30 * layout.unit
      ctx.shadowOffsetY = 10 * layout.unit
      path()
      ctx.fillStyle = '#000'
      ctx.fill()
      ctx.restore()
    }
    // Camera segment fade in/out
    const seg = this.cameraSegmentAt(t)
    let alpha = 1
    if (seg) {
      alpha = Math.min(clamp((t - seg.start) / 250, 0, 1), clamp((seg.end - t) / 250, 0, 1))
    }
    ctx.globalAlpha = alpha
    path()
    ctx.clip()
    // cover-fit with zoom
    const zoom = fullscreen ? 1 : c.zoom
    const sc = Math.max(rect.width / cam.width, rect.height / cam.height) * zoom
    const dw = cam.width * sc
    const dh = cam.height * sc
    const dx = rect.x + (rect.width - dw) / 2
    const dy = rect.y + (rect.height - dh) / 2
    if (c.mirror) {
      ctx.translate(rect.x + rect.width / 2, 0)
      ctx.scale(-1, 1)
      ctx.translate(-(rect.x + rect.width / 2), 0)
    }
    try {
      ctx.drawImage(cam.image, dx, dy, dw, dh)
    } catch {
      /* not ready */
    }
    ctx.restore()
    if (c.border.enabled && !fullscreen) {
      ctx.save()
      ctx.globalAlpha = alpha
      path()
      ctx.lineWidth = c.border.width * layout.unit
      ctx.strokeStyle = c.border.color
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawKeystrokes(ctx: Ctx, layout: Layout, s: number): void {
    const k = this.render.keystrokes
    const ev = this.events!
    const groups = groupKeys(ev.keys, s, k.durationMs, k.showModifiersOnly)
    if (groups.length === 0) return
    const g = groups[groups.length - 1]
    const age = s - g.lastT
    const alpha = Math.min(1, clamp((s - g.firstT + 80) / 120, 0, 1), clamp((k.durationMs - age) / 300, 0, 1))
    if (alpha <= 0) return
    const unit = layout.unit * k.size
    const fontSize = 26 * unit
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font = `600 ${fontSize}px ${this.render.captions.fontFamily}`
    ctx.textBaseline = 'middle'
    const padX = 16 * unit
    const gap = 8 * unit
    const h = 46 * unit
    const items = g.labels
    const widths = items.map((l) => ctx.measureText(l).width + padX * 2)
    const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1)
    let x: number
    let y: number
    const margin = 40 * layout.unit
    switch (k.position) {
      case 'top':
        x = (layout.width - total) / 2
        y = margin
        break
      case 'bottom-left':
        x = margin
        y = layout.height - margin - h
        break
      case 'bottom-right':
        x = layout.width - margin - total
        y = layout.height - margin - h
        break
      default:
        x = (layout.width - total) / 2
        y = layout.height - margin - h
    }
    // pop animation
    const pop = 1 + (1 - ease('ease-out-cubic', clamp((s - g.lastT) / 160, 0, 1))) * 0.08
    ctx.translate(x + total / 2, y + h / 2)
    ctx.scale(pop, pop)
    ctx.translate(-(x + total / 2), -(y + h / 2))
    for (let i = 0; i < items.length; i++) {
      const w = widths[i]
      if (k.style === 'keycaps') {
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.5)'
        ctx.shadowBlur = 12 * unit
        ctx.shadowOffsetY = 4 * unit
        roundRectPath(ctx, x, y, w, h, 10 * unit)
        ctx.fillStyle = '#f4f4f8'
        ctx.fill()
        ctx.restore()
        roundRectPath(ctx, x, y + h - 4 * unit, w, 4 * unit, 2 * unit)
        ctx.fillStyle = 'rgba(0,0,0,0.18)'
        ctx.fill()
        ctx.fillStyle = '#15161e'
      } else {
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.45)'
        ctx.shadowBlur = 16 * unit
        ctx.shadowOffsetY = 6 * unit
        roundRectPath(ctx, x, y, w, h, h / 2)
        ctx.fillStyle = 'rgba(18,18,26,0.82)'
        ctx.fill()
        ctx.restore()
        roundRectPath(ctx, x, y, w, h, h / 2)
        ctx.lineWidth = 1.2 * unit
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'
        ctx.stroke()
        ctx.fillStyle = '#ffffff'
      }
      ctx.textAlign = 'center'
      ctx.fillText(items[i], x + w / 2, y + h / 2 + 1 * unit)
      x += w + gap
    }
    ctx.restore()
  }

  private drawText(ctx: Ctx, layout: Layout, tx: TextOverlay, t: number, selected: boolean): void {
    const u = layout.unit
    const inDur = 380
    const outDur = 260
    const pIn = clamp((t - tx.start) / inDur, 0, 1)
    const pOut = clamp((tx.end - t) / outDur, 0, 1)
    let alpha = 1
    let dy = 0
    let scale = 1
    let visibleChars = Infinity
    switch (tx.animation) {
      case 'fade':
        alpha = Math.min(ease('ease-out-cubic', pIn), pOut)
        break
      case 'slide-up':
        alpha = Math.min(ease('ease-out-cubic', pIn), pOut)
        dy = (1 - ease('ease-out-expo', pIn)) * 40 * u
        break
      case 'pop':
        alpha = Math.min(pIn * 2, 1, pOut)
        scale = 0.6 + 0.4 * ease('spring', pIn)
        break
      case 'typewriter': {
        const total = tx.text.length
        visibleChars = Math.floor(clamp((t - tx.start) / (Math.max(600, total * 45)), 0, 1) * total)
        alpha = pOut
        break
      }
      default:
        alpha = 1
    }
    if (alpha <= 0) return
    const fontSize = tx.fontSize * u
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font = `${tx.fontWeight} ${fontSize}px ${tx.fontFamily}`
    ctx.textBaseline = 'top'
    const text = visibleChars === Infinity ? tx.text : tx.text.slice(0, visibleChars)
    const lines = text.split('\n')
    const lineH = fontSize * 1.25
    const widths = lines.map((l) => ctx.measureText(l).width)
    const tw = Math.max(...widths, 1)
    const th = lineH * lines.length
    const pad = tx.padding * u
    const bw = tw + pad * 2
    const bh = th + pad * 2
    const ax = tx.position.x * layout.width
    const ay = tx.position.y * layout.height + dy
    // anchor
    let bx = ax - bw / 2
    let by = ay - bh / 2
    if (tx.anchor.includes('left')) bx = ax
    if (tx.anchor.includes('right')) bx = ax - bw
    if (tx.anchor.startsWith('top')) by = ay
    if (tx.anchor.startsWith('bottom')) by = ay - bh
    ctx.translate(bx + bw / 2, by + bh / 2)
    ctx.scale(scale, scale)
    ctx.translate(-(bx + bw / 2), -(by + bh / 2))
    if (tx.background) {
      ctx.save()
      if (tx.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.4)'
        ctx.shadowBlur = 24 * u
        ctx.shadowOffsetY = 8 * u
      }
      roundRectPath(ctx, bx, by, bw, bh, tx.radius * u)
      ctx.fillStyle = tx.background
      ctx.fill()
      ctx.restore()
    } else if (tx.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = 14 * u
      ctx.shadowOffsetY = 3 * u
    }
    ctx.fillStyle = tx.color
    lines.forEach((line, i) => {
      let lx = bx + pad
      if (tx.align === 'center') lx = bx + pad + (tw - widths[i]) / 2
      if (tx.align === 'right') lx = bx + pad + (tw - widths[i])
      ctx.fillText(line, lx, by + pad + i * lineH + fontSize * 0.08)
    })
    ctx.restore()
    if (selected) {
      ctx.save()
      ctx.strokeStyle = '#7c5cff'
      ctx.lineWidth = 2 * u
      ctx.setLineDash([6 * u, 4 * u])
      roundRectPath(ctx, bx - 4 * u, by - 4 * u, bw + 8 * u, bh + 8 * u, (tx.radius + 4) * u)
      ctx.stroke()
      ctx.restore()
    }
  }

  private drawCaptions(ctx: Ctx, layout: Layout, t: number): void {
    const cap = this.render.captions
    const seg = this.timeline.captions.find((c) => t >= c.start && t < c.end)
    if (!seg) return
    const u = layout.unit
    const fontSize = cap.fontSize * u
    ctx.save()
    ctx.font = `600 ${fontSize}px ${cap.fontFamily}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    const maxW = layout.width * 0.8
    const words = seg.text.split(/\s+/)
    const lines: string[] = []
    let cur = ''
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur)
        cur = w
      } else cur = test
    }
    if (cur) lines.push(cur)
    const shown = lines.slice(-cap.maxLines)
    const lineH = fontSize * 1.35
    const padX = 22 * u
    const padY = 10 * u
    const totalH = shown.length * lineH + padY * 2
    const y0 = cap.position === 'top' ? 48 * u : layout.height - 56 * u - totalH
    const alpha = Math.min(clamp((t - seg.start) / 120, 0, 1), clamp((seg.end - t) / 120, 0, 1))
    ctx.globalAlpha = alpha
    // word highlight (karaoke-ish): approximate progress through segment
    const prog = clamp((t - seg.start) / Math.max(1, seg.end - seg.start), 0, 1)
    const totalChars = seg.text.length
    const litChars = Math.floor(prog * totalChars)
    let consumed = seg.text.length - shown.join(' ').length
    shown.forEach((line, i) => {
      const w = ctx.measureText(line).width
      const x = layout.width / 2
      const y = y0 + padY + i * lineH + lineH / 2
      roundRectPath(ctx, x - w / 2 - padX, y - lineH / 2 - (i === 0 ? padY : 0), w + padX * 2, lineH + (i === 0 ? padY : 0) + (i === shown.length - 1 ? padY : 0), 10 * u)
      ctx.fillStyle = cap.background
      ctx.fill()
      // draw words with highlight
      const ws = line.split(' ')
      let cx = x - w / 2
      ctx.textAlign = 'left'
      for (const word of ws) {
        const ww = ctx.measureText(word + ' ').width
        const lit = consumed + word.length <= litChars
        ctx.fillStyle = lit ? cap.highlightColor : cap.color
        ctx.fillText(word, cx, y)
        cx += ww
        consumed += word.length + 1
      }
      ctx.textAlign = 'center'
    })
    ctx.restore()
  }

  private drawGuides(ctx: Ctx, layout: Layout): void {
    ctx.save()
    ctx.strokeStyle = 'rgba(124,92,255,0.5)'
    ctx.setLineDash([6, 6])
    ctx.lineWidth = 1
    const m = 0.05
    ctx.strokeRect(layout.width * m, layout.height * m, layout.width * (1 - 2 * m), layout.height * (1 - 2 * m))
    ctx.restore()
  }
}

// ── Keystroke grouping ──────────────────────────────────────────────────────

const SPECIAL = new Set(['Enter', 'Esc', 'Tab', 'Backspace', 'Del', 'Space', '↑', '↓', '←', '→', 'Caps'])
const MODS = new Set(['Ctrl', 'Shift', 'Alt', 'Win'])

interface KeyGroup {
  firstT: number
  lastT: number
  labels: string[]
}

function keyLabel(k: KeyEvent): string | null {
  if (MODS.has(k.key)) return null
  const mods = k.modifiers.map((m) => (m === 'ctrl' ? 'Ctrl' : m === 'shift' ? 'Shift' : m === 'alt' ? 'Alt' : 'Win'))
  const key = k.key.length === 1 ? k.key.toUpperCase() : k.key
  return [...mods, key].join(' + ')
}

export function groupKeys(keys: KeyEvent[], s: number, durationMs: number, modifiersOnly: boolean): KeyGroup[] {
  const recent = keys.filter((k) => k.t <= s && k.t >= s - durationMs)
  const groups: KeyGroup[] = []
  for (const k of recent) {
    const hasMod = k.modifiers.some((m) => m !== 'shift')
    if (modifiersOnly && !hasMod && !SPECIAL.has(k.key)) continue
    const label = keyLabel(k)
    if (!label) continue
    const last = groups[groups.length - 1]
    if (last && k.t - last.lastT < 700 && last.labels.length < 5 && !hasMod) {
      last.labels.push(label)
      last.lastT = k.t
    } else groups.push({ firstT: k.t, lastT: k.t, labels: [label] })
  }
  return groups
}

export { lerp }
