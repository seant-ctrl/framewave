import type { Rect, RenderSettings, AspectPreset } from '@shared/types'
import { ASPECT_RATIOS } from '@shared/types'

export interface Layout {
  width: number
  height: number
  /** Scale relative to a 1080p reference frame (1 at 1080p). */
  unit: number
  padding: number
  /** Frame rect where the (cropped) screen video is drawn, before zoom. */
  screen: Rect
  /** Normalized crop rect of the source video (0..1). */
  crop: Rect
  /** Source video pixel size */
  srcW: number
  srcH: number
}

export function aspectFor(preset: AspectPreset, srcAspect: number): number {
  if (preset === 'source') return srcAspect
  return ASPECT_RATIOS[preset]
}

export function outputSize(render: RenderSettings, srcW: number, srcH: number, heightOverride?: number): { width: number; height: number } {
  const crop = effectiveCrop(render, srcW, srcH)
  const srcAspect = (srcW * crop.width) / Math.max(1, srcH * crop.height)
  const aspect = aspectFor(render.aspect, srcAspect || 16 / 9)
  const height = heightOverride ?? render.outputHeight
  let width = Math.round((height * aspect) / 2) * 2
  // Cap width for extremely wide sources
  if (width > 7680) width = 7680
  return { width, height }
}

export function effectiveCrop(render: RenderSettings, _srcW: number, _srcH: number): Rect {
  const c = render.crop
  if (!c || c.width <= 0.01 || c.height <= 0.01) return { x: 0, y: 0, width: 1, height: 1 }
  return {
    x: Math.min(Math.max(0, c.x), 0.99),
    y: Math.min(Math.max(0, c.y), 0.99),
    width: Math.min(1 - c.x, c.width),
    height: Math.min(1 - c.y, c.height)
  }
}

export function computeLayout(render: RenderSettings, srcW: number, srcH: number, size?: { width: number; height: number }): Layout {
  const { width, height } = size ?? outputSize(render, srcW, srcH)
  const unit = height / 1080
  const crop = effectiveCrop(render, srcW, srcH)
  const contentAspect = (srcW * crop.width) / Math.max(1, srcH * crop.height) || 16 / 9
  const padding = render.padding * Math.min(width, height)
  const availW = Math.max(1, width - padding * 2)
  const availH = Math.max(1, height - padding * 2)
  let w = availW
  let h = w / contentAspect
  if (h > availH) {
    h = availH
    w = h * contentAspect
  }
  const screen = { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }
  return { width, height, unit, padding, screen, crop, srcW, srcH }
}

/** Convert a normalized point inside the *cropped* screen to output pixels (before zoom). */
export function screenToOutput(layout: Layout, nx: number, ny: number): { x: number; y: number } {
  return { x: layout.screen.x + nx * layout.screen.width, y: layout.screen.y + ny * layout.screen.height }
}

/** Convert a normalized point of the *full* source video into cropped-normalized space. */
export function fullToCropped(layout: Layout, x: number, y: number): { x: number; y: number } {
  const c = layout.crop
  return { x: (x - c.x) / c.width, y: (y - c.y) / c.height }
}

export function roundRectPath(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Squircle (superellipse) path */
export function squirclePath(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, n = 4): void {
  const a = w / 2
  const b = h / 2
  const cx = x + a
  const cy = y + b
  ctx.beginPath()
  const steps = 96
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t)
    const s = Math.sin(t)
    const px = cx + Math.sign(c) * a * Math.pow(Math.abs(c), 2 / n)
    const py = cy + Math.sign(s) * b * Math.pow(Math.abs(s), 2 / n)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}
