import type { CaptionSegment } from '@shared/types'
import { uid } from './utils'

function ts(ms: number, sep = ','): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const f = Math.floor(ms % 1000)
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`
}

export function toSrt(caps: CaptionSegment[]): string {
  return caps
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text.trim()}\n`)
    .join('\n')
}

export function toVtt(caps: CaptionSegment[]): string {
  return (
    'WEBVTT\n\n' +
    caps
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((c) => `${ts(c.start, '.')} --> ${ts(c.end, '.')}\n${c.text.trim()}\n`)
      .join('\n')
  )
}

function parseTs(s: string): number {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4].padEnd(3, '0').slice(0, 3))
}

export function parseSrt(text: string): CaptionSegment[] {
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/)
  const out: CaptionSegment[] = []
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '')
    const idx = lines.findIndex((l) => l.includes('-->'))
    if (idx < 0) continue
    const [a, c] = lines[idx].split('-->')
    const textLines = lines.slice(idx + 1)
    if (textLines.length === 0) continue
    out.push({ id: uid('cap'), start: parseTs(a), end: parseTs(c), text: textLines.join(' ').replace(/<[^>]+>/g, '') })
  }
  return out
}
