import type { BackgroundSettings, GradientStop } from '@shared/types'
import { WALLPAPERS } from '@shared/types'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

const imageCache = new Map<string, HTMLImageElement | ImageBitmap | 'loading' | 'error'>()
const listeners = new Set<() => void>()

/** Subscribe to "an image finished loading" so previews can re-render. */
export function onBackgroundImageLoaded(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getImage(src: string): HTMLImageElement | ImageBitmap | null {
  const c = imageCache.get(src)
  if (c && c !== 'loading' && c !== 'error') return c
  if (!c) {
    imageCache.set(src, 'loading')
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imageCache.set(src, img)
      listeners.forEach((l) => l())
    }
    img.onerror = () => imageCache.set(src, 'error')
    img.src = src
  }
  return null
}

/** Wait until an image is loaded (for export). */
export function ensureImage(src: string): Promise<HTMLImageElement | ImageBitmap | null> {
  return new Promise((resolve) => {
    const got = getImage(src)
    if (got) return resolve(got)
    const state = imageCache.get(src)
    if (state === 'error') return resolve(null)
    const unsub = onBackgroundImageLoaded(() => {
      const g = getImage(src)
      if (g || imageCache.get(src) === 'error') {
        unsub()
        resolve(g)
      }
    })
    setTimeout(() => {
      unsub()
      resolve(getImage(src))
    }, 8000)
  })
}

export function parseCssGradient(css: string): { angle: number; stops: GradientStop[] } {
  const m = css.match(/linear-gradient\((\d+)deg,(.*)\)$/)
  if (!m) return { angle: 135, stops: [{ color: '#111', pos: 0 }, { color: '#333', pos: 1 }] }
  const angle = Number(m[1])
  const stops = m[2].split(/,(?![^(]*\))/).map((s) => {
    const [color, pos] = s.trim().split(/\s+/)
    return { color, pos: parseFloat(pos) / 100 }
  })
  return { angle, stops }
}

export function makeGradient(ctx: Ctx, w: number, h: number, angle: number, stops: GradientStop[]): CanvasGradient {
  const a = ((angle - 90) * Math.PI) / 180
  const cx = w / 2
  const cy = h / 2
  const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))
  const dx = (Math.cos(a) * len) / 2
  const dy = (Math.sin(a) * len) / 2
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  for (const s of stops) g.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color)
  return g
}

export function backgroundCss(bg: BackgroundSettings): string {
  switch (bg.type) {
    case 'color':
      return bg.color
    case 'gradient':
      return `linear-gradient(${bg.angle}deg, ${bg.stops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(', ')})`
    case 'wallpaper':
      return WALLPAPERS.find((w) => w.id === bg.id)?.css ?? '#111'
    case 'image':
      return `url(${JSON.stringify(bg.src)}) center/cover`
    case 'blur':
      return 'linear-gradient(135deg,#222,#444)'
    case 'transparent':
      return 'transparent'
  }
}

function drawCover(ctx: Ctx, img: CanvasImageSource, iw: number, ih: number, w: number, h: number, zoom = 1): void {
  const s = Math.max(w / iw, h / ih) * zoom
  const dw = iw * s
  const dh = ih * s
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
}

export interface BackgroundSourceFrame {
  image: CanvasImageSource
  width: number
  height: number
}

export function drawBackground(ctx: Ctx, w: number, h: number, bg: BackgroundSettings, screen?: BackgroundSourceFrame | null): void {
  ctx.save()
  switch (bg.type) {
    case 'transparent':
      ctx.clearRect(0, 0, w, h)
      break
    case 'color':
      ctx.fillStyle = bg.color
      ctx.fillRect(0, 0, w, h)
      break
    case 'gradient':
      ctx.fillStyle = makeGradient(ctx, w, h, bg.angle, bg.stops)
      ctx.fillRect(0, 0, w, h)
      break
    case 'wallpaper': {
      const wp = WALLPAPERS.find((x) => x.id === bg.id) ?? WALLPAPERS[0]
      const { angle, stops } = parseCssGradient(wp.css)
      ctx.fillStyle = makeGradient(ctx, w, h, angle, stops)
      ctx.fillRect(0, 0, w, h)
      // subtle vignette for depth
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, 'rgba(0,0,0,0.28)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      break
    }
    case 'image': {
      const img = getImage(bg.src)
      ctx.fillStyle = '#101018'
      ctx.fillRect(0, 0, w, h)
      if (img) {
        const iw = 'width' in img ? (img as HTMLImageElement).naturalWidth || img.width : 1
        const ih = 'height' in img ? (img as HTMLImageElement).naturalHeight || img.height : 1
        if (bg.blur > 0) ctx.filter = `blur(${bg.blur}px)`
        drawCover(ctx, img, iw, ih, w, h, bg.blur > 0 ? 1.08 : 1)
        ctx.filter = 'none'
      }
      if (bg.dim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${bg.dim})`
        ctx.fillRect(0, 0, w, h)
      }
      break
    }
    case 'blur': {
      ctx.fillStyle = '#0c0c14'
      ctx.fillRect(0, 0, w, h)
      if (screen) {
        ctx.filter = `blur(${Math.max(1, bg.blur)}px) saturate(${bg.saturate})`
        drawCover(ctx, screen.image, screen.width, screen.height, w, h, 1.15)
        ctx.filter = 'none'
      }
      if (bg.dim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${bg.dim})`
        ctx.fillRect(0, 0, w, h)
      }
      break
    }
  }
  ctx.restore()
}
