import React, { useEffect, useRef, useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Repeat, Maximize2 } from 'lucide-react'
import { useProject } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { onBackgroundImageLoaded } from '@/engine/background'
import { formatTime, clamp } from '@/lib/utils'
import { timelineDuration } from '@/engine/timeline'
import type { EditorContext } from './Editor'
import type { Vec2 } from '@shared/types'
import { IconButton } from '../ui/ui'

export function Preview({ ctx }: { ctx: EditorContext }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [fpsDisplay, setFps] = useState(0)
  const project = useProject((s) => s.project)!
  const selection = useProject((s) => s.selection)
  const setSelection = useProject((s) => s.setSelection)
  const updateText = useProject((s) => s.updateText)
  const updateZoom = useProject((s) => s.updateZoom)
  const updateRender = useProject((s) => s.updateRender)
  const playing = usePlayer((s) => s.playing)
  const setPlaying = usePlayer((s) => s.setPlaying)
  const time = usePlayer((s) => s.time)
  const setTime = usePlayer((s) => s.setTime)
  const muted = usePlayer((s) => s.muted)
  const setMuted = usePlayer((s) => s.setMuted)
  const loop = usePlayer((s) => s.loop)
  const setLoop = usePlayer((s) => s.setLoop)
  const inPoint = usePlayer((s) => s.inPoint)
  const outPoint = usePlayer((s) => s.outPoint)
  const [fullscreen, setFullscreen] = useState(false)
  const dragRef = useRef<{ kind: 'text' | 'zoom' | 'camera'; id?: string; start: Vec2; orig: Vec2 } | null>(null)
  const [hover, setHover] = useState<'text' | 'camera' | 'zoom' | null>(null)

  // Sync play state to player
  useEffect(() => {
    const p = ctx.player
    if (playing) {
      if (outPoint != null && inPoint != null && (p.time < inPoint || p.time >= outPoint)) p.seek(inPoint)
      void p.play()
    } else p.pause()
  }, [playing, ctx, inPoint, outPoint])

  // Seek when store time changes externally (scrub) while paused
  const lastStoreTime = useRef(time)
  useEffect(() => {
    if (Math.abs(time - lastStoreTime.current) < 0.001) return
    lastStoreTime.current = time
    if (!ctx.player.playing || Math.abs(ctx.player.time - time) > 200) {
      ctx.player.seek(time)
      ctx.compositor.resetMotion()
    }
  }, [time, ctx])

  useEffect(() => {
    ctx.player.muted = muted
    ctx.player.applyVolumes()
  }, [muted, ctx])

  // Render loop
  useEffect(() => {
    let raf = 0
    let frames = 0
    let lastFpsT = performance.now()
    const dirty = { v: true }
    const unsubBg = onBackgroundImageLoaded(() => (dirty.v = true))
    const unsubProj = useProject.subscribe(() => (dirty.v = true))
    const unsubPlayer = usePlayer.subscribe(() => (dirty.v = true))
    ctx.player.onReady = () => (dirty.v = true)
    // Safety net: repaint occasionally while paused (fonts/images/video frames arriving late)
    const safety = setInterval(() => (dirty.v = true), 500)
    const ro = new ResizeObserver(() => (dirty.v = true))
    if (wrapRef.current) ro.observe(wrapRef.current)

    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      const wrap = wrapRef.current
      if (!canvas || !wrap) return
      const p = ctx.player
      const st = usePlayer.getState()
      if (p.playing) {
        const t = p.tick()
        if (st.outPoint != null && t >= st.outPoint) {
          if (st.loop) {
            p.seek(st.inPoint ?? 0)
            ctx.compositor.resetMotion()
          } else {
            p.pause()
            setPlaying(false)
          }
        }
        lastStoreTime.current = t
        if (Math.abs(st.time - t) > 8) setTime(t)
        dirty.v = true
      }
      if (!dirty.v && !p.playing) return
      dirty.v = false

      // Fit canvas to wrapper
      const comp = ctx.compositor
      const layout = comp.layout()
      const aspect = layout.width / layout.height
      const W = wrap.clientWidth - 32
      const H = wrap.clientHeight - 32
      let cw = W
      let ch = cw / aspect
      if (ch > H) {
        ch = H
        cw = ch * aspect
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const pw = Math.round(cw * dpr)
      const ph = Math.round(ch * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      canvas.style.width = `${cw}px`
      canvas.style.height = `${ch}px`
      const g = canvas.getContext('2d')
      if (!g) return
      const sel = useProject.getState().selection
      comp.renderFrame(g, p.time, p.frameSources(), { preview: true, selectedTextId: sel.kind === 'text' ? sel.id : null })

      // Overlays for selection (zoom focus)
      if (sel.kind === 'zoom') {
        const z = comp.timeline.zooms.find((x) => x.id === sel.id)
        if (z && p.time >= z.start - 1 && p.time <= z.end + 1) {
          const l = comp.layout({ width: pw, height: ph })
          const zs = comp.zoomAt(p.time)
          const tr = comp.transformFor(l, zs)
          const o = comp.toOutput(l, tr, z.focus)
          g.save()
          g.strokeStyle = '#7c5cff'
          g.lineWidth = 2 * dpr
          g.beginPath()
          g.arc(o.x, o.y, 14 * dpr, 0, Math.PI * 2)
          g.stroke()
          g.beginPath()
          g.moveTo(o.x - 22 * dpr, o.y)
          g.lineTo(o.x + 22 * dpr, o.y)
          g.moveTo(o.x, o.y - 22 * dpr)
          g.lineTo(o.x, o.y + 22 * dpr)
          g.stroke()
          g.restore()
        }
      }
      if (sel.kind === 'camera' || useProject.getState().activePanel === 'camera') {
        const l = comp.layout({ width: pw, height: ph })
        const cr = comp.cameraRect(l, p.time)
        if (cr && !cr.fullscreen) {
          g.save()
          g.strokeStyle = 'rgba(124,92,255,0.9)'
          g.setLineDash([6 * dpr, 4 * dpr])
          g.lineWidth = 1.5 * dpr
          g.strokeRect(cr.rect.x, cr.rect.y, cr.rect.width, cr.rect.height)
          g.restore()
        }
      }

      frames++
      const now = performance.now()
      if (now - lastFpsT > 1000) {
        setFps(p.playing ? frames : 0)
        frames = 0
        lastFpsT = now
      }
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(safety)
      ctx.player.onReady = null
      unsubBg()
      unsubProj()
      unsubPlayer()
      ro.disconnect()
    }
  }, [ctx, setTime, setPlaying])

  // ── Pointer interactions on the canvas ─────────────────────────────────
  const canvasPoint = (e: React.PointerEvent): { px: number; py: number; nx: number; ny: number } => {
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    const nx = (e.clientX - r.left) / r.width
    const ny = (e.clientY - r.top) / r.height
    return { px: nx * c.width, py: ny * c.height, nx, ny }
  }

  const hitTest = (px: number, py: number): { kind: 'text' | 'camera' | 'zoom'; id?: string } | null => {
    const comp = ctx.compositor
    const canvas = canvasRef.current!
    const l = comp.layout({ width: canvas.width, height: canvas.height })
    const t = ctx.player.time
    // text overlays (approximate box)
    for (const tx of comp.timeline.texts) {
      if (t < tx.start || t >= tx.end) continue
      const ax = tx.position.x * l.width
      const ay = tx.position.y * l.height
      const approxW = Math.max(80, tx.text.length * tx.fontSize * 0.55 * l.unit + tx.padding * 2 * l.unit)
      const approxH = (tx.fontSize * 1.3 * tx.text.split('\n').length + tx.padding * 2) * l.unit
      let bx = ax - approxW / 2
      let by = ay - approxH / 2
      if (tx.anchor.includes('left')) bx = ax
      if (tx.anchor.includes('right')) bx = ax - approxW
      if (tx.anchor.startsWith('top')) by = ay
      if (tx.anchor.startsWith('bottom')) by = ay - approxH
      if (px >= bx && px <= bx + approxW && py >= by && py <= by + approxH) return { kind: 'text', id: tx.id }
    }
    const cr = comp.cameraRect(l, t)
    if (cr && !cr.fullscreen && px >= cr.rect.x && px <= cr.rect.x + cr.rect.width && py >= cr.rect.y && py <= cr.rect.y + cr.rect.height) return { kind: 'camera' }
    if (selection.kind === 'zoom') return { kind: 'zoom', id: selection.id }
    return null
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    const { px, py, nx, ny } = canvasPoint(e)
    const hit = hitTest(px, py)
    if (!hit) {
      if (selection.kind === 'text' || selection.kind === 'camera') setSelection({ kind: 'none' })
      return
    }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    if (hit.kind === 'text') {
      const tx = project.timeline.texts.find((x) => x.id === hit.id)!
      setSelection({ kind: 'text', id: tx.id })
      dragRef.current = { kind: 'text', id: tx.id, start: { x: nx, y: ny }, orig: { ...tx.position } }
    } else if (hit.kind === 'camera') {
      useProject.getState().setActivePanel('camera')
      const cam = project.render.camera
      const canvas = canvasRef.current!
      const l = ctx.compositor.layout({ width: canvas.width, height: canvas.height })
      const cr = ctx.compositor.cameraRect(l, ctx.player.time)!
      const center = { x: (cr.rect.x + cr.rect.width / 2) / l.width, y: (cr.rect.y + cr.rect.height / 2) / l.height }
      if (cam.position !== 'custom') updateRender({ camera: { ...cam, position: 'custom', custom: center } })
      dragRef.current = { kind: 'camera', start: { x: nx, y: ny }, orig: center }
    } else if (hit.kind === 'zoom' && hit.id) {
      const canvas = canvasRef.current!
      const l = ctx.compositor.layout({ width: canvas.width, height: canvas.height })
      const zs = ctx.compositor.zoomAt(ctx.player.time)
      const tr = ctx.compositor.transformFor(l, zs)
      const f = ctx.compositor.fromOutput(l, tr, { x: px, y: py })
      updateZoom(hit.id, { focus: { x: clamp(f.x, 0, 1), y: clamp(f.y, 0, 1) } })
      dragRef.current = { kind: 'zoom', id: hit.id, start: { x: nx, y: ny }, orig: f }
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const { px, py, nx, ny } = canvasPoint(e)
    const d = dragRef.current
    if (!d) {
      const h = hitTest(px, py)
      setHover(h?.kind ?? null)
      return
    }
    const dx = nx - d.start.x
    const dy = ny - d.start.y
    if (d.kind === 'text' && d.id) updateText(d.id, { position: { x: clamp(d.orig.x + dx, 0, 1), y: clamp(d.orig.y + dy, 0, 1) } }, false)
    else if (d.kind === 'camera') updateRender((r) => ({ camera: { ...r.camera, position: 'custom', custom: { x: clamp(d.orig.x + dx, 0.05, 0.95), y: clamp(d.orig.y + dy, 0.05, 0.95) } } }), { history: false })
    else if (d.kind === 'zoom' && d.id) {
      const canvas = canvasRef.current!
      const l = ctx.compositor.layout({ width: canvas.width, height: canvas.height })
      const zs = ctx.compositor.zoomAt(ctx.player.time)
      const tr = ctx.compositor.transformFor(l, zs)
      const f = ctx.compositor.fromOutput(l, tr, { x: px, y: py })
      updateZoom(d.id, { focus: { x: clamp(f.x, 0, 1), y: clamp(f.y, 0, 1) } }, false)
    }
  }
  const onPointerUp = (): void => {
    dragRef.current = null
  }

  const dur = timelineDuration(project.timeline)

  return (
    <div className={fullscreen ? 'fixed inset-0 z-[90] bg-black flex flex-col' : 'absolute inset-0 flex flex-col'}>
      <div ref={wrapRef} className="flex-1 min-h-0 grid place-items-center overflow-hidden checker" style={{ backgroundColor: '#07070b', backgroundImage: 'radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)', backgroundSize: '18px 18px' }}>
        <canvas
          ref={canvasRef}
          className="rounded-md"
          style={{ boxShadow: '0 30px 80px -30px rgba(0,0,0,0.9)', cursor: dragRef.current ? 'grabbing' : hover === 'zoom' ? 'crosshair' : hover ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={() => setPlaying(!playing)}
        />
      </div>
      {/* Transport */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-t border-line bg-bg-1">
        <IconButton icon={<SkipBack size={15} />} label="Go to start (Home)" onClick={() => setTime(inPoint ?? 0)} />
        <button className="btn btn-icon !w-9 !h-9 !rounded-full btn-primary" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </button>
        <IconButton icon={<SkipForward size={15} />} label="Go to end (End)" onClick={() => setTime(outPoint ?? dur)} />
        <div className="font-mono text-[12.5px] tabular-nums ml-2">
          <span>{formatTime(time, { frames: 60 })}</span>
          <span className="text-fg-3"> / {formatTime(dur, { frames: 60 })}</span>
        </div>
        {inPoint != null && outPoint != null && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-soft text-accent-2 font-mono">
            {formatTime(inPoint)} → {formatTime(outPoint)}
          </span>
        )}
        <div className="flex-1" />
        {fpsDisplay > 0 && <span className="text-[10.5px] font-mono text-fg-3">{fpsDisplay} fps</span>}
        <span className="text-[10.5px] font-mono text-fg-3">
          {ctx.compositor.layout().width}×{ctx.compositor.layout().height}
        </span>
        <IconButton icon={<Repeat size={15} />} label="Loop" active={loop} onClick={() => setLoop(!loop)} />
        <IconButton icon={muted ? <VolumeX size={15} /> : <Volume2 size={15} />} label={muted ? 'Unmute' : 'Mute preview'} onClick={() => setMuted(!muted)} />
        <IconButton icon={<Maximize2 size={15} />} label="Fullscreen preview" active={fullscreen} onClick={() => setFullscreen(!fullscreen)} />
      </div>
    </div>
  )
}
