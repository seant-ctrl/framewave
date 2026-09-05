import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { fw } from './lib/fw'

type R = { x: number; y: number; width: number; height: number }

function RegionPicker(): React.JSX.Element {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<R | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const scale = Number(new URLSearchParams(location.hash.slice(1)).get('scale') ?? 1)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') fw.region.done(null)
      if (e.key === 'Enter' && rect && rect.width > 10) fw.region.done(rect)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rect])

  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    setStart({ x: e.clientX, y: e.clientY })
    setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
  }
  const onMove = (e: React.MouseEvent): void => {
    setPos({ x: e.clientX, y: e.clientY })
    if (!start) return
    const x = Math.min(start.x, e.clientX)
    const y = Math.min(start.y, e.clientY)
    setRect({ x, y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) })
  }
  const onUp = (): void => {
    if (!start) return
    setStart(null)
    if (rect && rect.width > 10 && rect.height > 10) {
      // Snap to even pixel dimensions (encoder friendly)
      const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width / 2) * 2, height: Math.round(rect.height / 2) * 2 }
      setRect(r)
      setTimeout(() => fw.region.done(r), 120)
    } else setRect(null)
  }

  const presets: Array<[string, number, number]> = [
    ['1920×1080', 1920, 1080],
    ['1280×720', 1280, 720],
    ['1080×1080', 1080, 1080],
    ['1080×1920', 1080, 1920]
  ]

  return (
    <div ref={ref} className="fixed inset-0 select-none" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} style={{ cursor: 'crosshair' }}>
      {/* Dim everything except the selection */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        <defs>
          <mask id="hole">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill="black" rx="2" />}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(6,6,12,0.55)" mask="url(#hole)" />
        {rect && (
          <>
            <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill="none" stroke="#7c5cff" strokeWidth="2" />
            {/* thirds */}
            <g stroke="rgba(255,255,255,0.25)" strokeDasharray="4 4">
              <line x1={rect.x + rect.width / 3} y1={rect.y} x2={rect.x + rect.width / 3} y2={rect.y + rect.height} />
              <line x1={rect.x + (2 * rect.width) / 3} y1={rect.y} x2={rect.x + (2 * rect.width) / 3} y2={rect.y + rect.height} />
              <line x1={rect.x} y1={rect.y + rect.height / 3} x2={rect.x + rect.width} y2={rect.y + rect.height / 3} />
              <line x1={rect.x} y1={rect.y + (2 * rect.height) / 3} x2={rect.x + rect.width} y2={rect.y + (2 * rect.height) / 3} />
            </g>
          </>
        )}
        {!rect && (
          <g stroke="rgba(124,92,255,0.6)">
            <line x1={pos.x} y1={0} x2={pos.x} y2="100%" />
            <line x1={0} y1={pos.y} x2="100%" y2={pos.y} />
          </g>
        )}
      </svg>

      {rect && rect.width > 0 && (
        <div
          className="absolute px-2 py-1 rounded-md text-[12px] font-mono pointer-events-none"
          style={{ left: rect.x, top: Math.max(8, rect.y - 30), background: '#1d1f33', border: '1px solid rgba(255,255,255,0.14)', color: '#eef0ff' }}
        >
          {Math.round(rect.width * scale)} × {Math.round(rect.height * scale)} px
        </div>
      )}

      {!start && (
        <div
          className="absolute left-1/2 top-8 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-xl fade-in"
          style={{ background: 'rgba(16,17,26,0.92)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 20px 60px -20px rgba(0,0,0,.8)' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className="text-[12.5px] text-fg-2 mr-1">Drag to select an area</span>
          {presets.map(([label, w, h]) => (
            <button
              key={label}
              className="btn btn-sm"
              onClick={() => {
                const cw = Math.min(w / scale, window.innerWidth)
                const ch = Math.min(h / scale, window.innerHeight)
                const r = { x: Math.round((window.innerWidth - cw) / 2), y: Math.round((window.innerHeight - ch) / 2), width: Math.round(cw), height: Math.round(ch) }
                setRect(r)
                setTimeout(() => fw.region.done(r), 150)
              }}
            >
              {label}
            </button>
          ))}
          <button className="btn btn-sm btn-ghost" onClick={() => fw.region.done(null)}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<RegionPicker />)
