export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a))
export const remap = (v: number, a: number, b: number, c: number, d: number): number => lerp(c, d, invLerp(a, b, v))

let counter = 0
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** mm:ss.cc or hh:mm:ss */
export function formatTime(ms: number, opts: { frames?: number; long?: boolean } = {}): string {
  if (!isFinite(ms) || ms < 0) ms = 0
  const totalSec = ms / 1000
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = Math.floor(totalSec % 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  let out = h > 0 || opts.long ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  if (opts.frames) {
    const f = Math.floor(((totalSec % 1) * opts.frames) % opts.frames)
    out += `.${pad(f)}`
  } else if (!opts.long) {
    const cs = Math.floor((totalSec % 1) * 100)
    out += `.${pad(cs)}`
  }
  return out
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return `${m}m ${pad2(r)}s`
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`
}
const pad2 = (n: number): string => String(n).padStart(2, '0')

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`
  return `${(b / 1024 ** 3).toFixed(2)} GB`
}

export function relativeDate(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null
  return ((...args: unknown[]) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }) as T
}

export function throttle<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let last = 0
  let pending: unknown[] | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: unknown[]) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    } else {
      pending = args
      if (!timer)
        timer = setTimeout(() => {
          timer = null
          last = Date.now()
          if (pending) fn(...pending)
          pending = null
        }, ms - (now - last))
    }
  }) as T
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

export function isLightColor(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150
}

export function deepClone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))
}

export const isMac = navigator.platform.toLowerCase().includes('mac')
export const modKey = isMac ? '⌘' : 'Ctrl'

export function downloadTextFile(name: string, text: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function nextFrame(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r))
}
