import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Volume2, VolumeX, Video, ZoomIn, Camera, Type, Subtitles, Music, Mic, Speaker, Flag, FilePlus, Image as ImageIcon, AudioLines } from 'lucide-react'
import type { EditorContext } from './Editor'
import { useProject, type Selection } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { placeClips, timelineDuration, snapPoints, trimClip, splitAt, removeClip, setClipSpeed, moveClip, assetFor, updateClip, detachAudio, reattachAudio, audioClipEnd, type ClipPlacement } from '@/engine/timeline'
import { addMediaToProject } from './mediaImport'
import { TRANSITIONS } from './panels/ClipPanel'
import { cn, formatTime, clamp, uid } from '@/lib/utils'
import type { ZoomSegment, CameraSegment, TextOverlay, CaptionSegment, AudioClip } from '@shared/types'

const HEADER_W = 128
const RULER_H = 24

type SegKind = 'zoom' | 'camera' | 'text' | 'caption'

export function Timeline({ ctx, snapping }: { ctx: EditorContext; snapping: boolean }): React.JSX.Element {
  const project = useProject((s) => s.project)!
  const selection = useProject((s) => s.selection)
  const setSelection = useProject((s) => s.setSelection)
  const updateTimeline = useProject((s) => s.updateTimeline)
  const updateZoom = useProject((s) => s.updateZoom)
  const updateCameraSegment = useProject((s) => s.updateCameraSegment)
  const updateText = useProject((s) => s.updateText)
  const updateCaption = useProject((s) => s.updateCaption)
  const addZoom = useProject((s) => s.addZoom)
  const addText = useProject((s) => s.addText)
  const addCameraSegment = useProject((s) => s.addCameraSegment)
  const updateAudioClip = useProject((s) => s.updateAudioClip)
  const removeAudioClip = useProject((s) => s.removeAudioClip)
  const mutate = useProject((s) => s.mutate)

  const time = usePlayer((s) => s.time)
  const setTime = usePlayer((s) => s.setTime)
  const playing = usePlayer((s) => s.playing)
  const pxPerSec = usePlayer((s) => s.pxPerSec)
  const setPxPerSec = usePlayer((s) => s.setPxPerSec)
  const inPoint = usePlayer((s) => s.inPoint)
  const outPoint = usePlayer((s) => s.outPoint)
  const setInOut = usePlayer((s) => s.setInOut)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: Array<{ label: string; onClick: () => void; danger?: boolean }> } | null>(null)
  const [viewW, setViewW] = useState(800)
  const [dragClip, setDragClip] = useState<{ id: string; dx: number; toIndex: number } | null>(null)
  const dragClipRef = useRef<{ id: string; dx: number; toIndex: number } | null>(null)

  const tl = project.timeline
  const duration = timelineDuration(tl)
  const places = useMemo(() => placeClips(tl), [tl])
  const toX = useCallback((t: number) => (t / 1000) * pxPerSec, [pxPerSec])
  const toT = useCallback((x: number) => (x / pxPerSec) * 1000, [pxPerSec])
  const contentW = Math.max(viewW - HEADER_W, toX(duration) + 240)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Fit to view initially
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || duration <= 0 || viewW <= 0) return
    fitted.current = true
    setPxPerSec(Math.max(4, ((viewW - HEADER_W - 80) / duration) * 1000))
  }, [duration, viewW, setPxPerSec])

  // Auto-scroll while playing
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const x = toX(time)
    const vis = el.clientWidth - HEADER_W
    if (x < el.scrollLeft || x > el.scrollLeft + vis - 40) el.scrollLeft = Math.max(0, x - vis * 0.2)
  }, [time, playing, toX])

  useEffect(() => {
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const onWheel = (e: React.WheelEvent): void => {
    const el = scrollRef.current
    if (!el) return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mouseX = e.clientX - rect.left - HEADER_W + el.scrollLeft
      const tAtMouse = toT(mouseX)
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const np = clamp(pxPerSec * factor, 4, 2000)
      setPxPerSec(np)
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, (tAtMouse / 1000) * np - (e.clientX - rect.left - HEADER_W))
      })
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY
    }
  }

  // Snapping helper
  const snaps = useMemo(() => snapPoints(tl, [time, ...(inPoint != null ? [inPoint] : []), ...(outPoint != null ? [outPoint] : [])]), [tl, time, inPoint, outPoint])
  const snapT = useCallback(
    (t: number, exclude: number[] = []): number => {
      if (!snapping) return t
      const thr = toT(7)
      let best = t
      let bd = thr
      for (const s of snaps) {
        if (exclude.some((x) => Math.abs(x - s) < 1)) continue
        const d = Math.abs(s - t)
        if (d < bd) {
          bd = d
          best = s
        }
      }
      return best
    },
    [snapping, snaps, toT]
  )

  const contentX = (clientX: number): number => {
    const el = scrollRef.current!
    const rect = el.getBoundingClientRect()
    return clientX - rect.left - HEADER_W + el.scrollLeft
  }

  // ── Scrub / seek ────────────────────────────────────────────────────────
  const startScrub = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const wasPlaying = usePlayer.getState().playing
    if (wasPlaying) usePlayer.getState().setPlaying(false)
    const move = (ev: PointerEvent): void => setTime(clamp(toT(contentX(ev.clientX)), 0, duration))
    move(e.nativeEvent)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (wasPlaying) usePlayer.getState().setPlaying(true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Generic segment drag ────────────────────────────────────────────────
  const dragSeg = (e: React.PointerEvent, kind: SegKind, seg: { id: string; start: number; end: number }, mode: 'move' | 'start' | 'end'): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const x0 = contentX(e.clientX)
    const orig = { start: seg.start, end: seg.end }
    const minLen = 80
    let last = orig
    const apply = (s: number, en: number, commit: boolean): void => {
      const patch = { start: s, end: en }
      last = patch
      if (kind === 'zoom') updateZoom(seg.id, patch, commit)
      if (kind === 'camera') updateCameraSegment(seg.id, patch, commit)
      if (kind === 'text') updateText(seg.id, patch, commit)
      if (kind === 'caption') updateCaption(seg.id, patch)
    }
    // push a single history entry at start
    if (kind !== 'caption') apply(orig.start, orig.end, true)
    const move = (ev: PointerEvent): void => {
      const dt = toT(contentX(ev.clientX) - x0)
      let s = orig.start
      let en = orig.end
      if (mode === 'move') {
        const len = orig.end - orig.start
        s = clamp(orig.start + dt, 0, duration - len)
        const snapped = snapT(s, [orig.start, orig.end])
        const snappedEnd = snapT(s + len, [orig.start, orig.end])
        if (Math.abs(snapped - s) < Math.abs(snappedEnd - (s + len))) s = snapped
        else s = snappedEnd - len
        en = s + len
      } else if (mode === 'start') {
        s = clamp(snapT(orig.start + dt, [orig.start]), 0, orig.end - minLen)
      } else {
        en = clamp(snapT(orig.end + dt, [orig.end]), orig.start + minLen, duration)
      }
      apply(s, en, false)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      void last
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Clip trim drag ──────────────────────────────────────────────────────
  const dragClipEdge = (e: React.PointerEvent, clipId: string, edge: 'start' | 'end'): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    let first = true
    const move = (ev: PointerEvent): void => {
      const t = snapT(toT(contentX(ev.clientX)))
      updateTimeline((tl2) => trimClip(tl2, clipId, edge, t), { history: first })
      first = false
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── In/Out markers drag ────────────────────────────────────────────────
  const dragInOut = (e: React.PointerEvent, which: 'in' | 'out'): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const move = (ev: PointerEvent): void => {
      const t = clamp(snapT(toT(contentX(ev.clientX))), 0, duration)
      const st = usePlayer.getState()
      if (which === 'in') setInOut(Math.min(t, (st.outPoint ?? duration) - 50), st.outPoint)
      else setInOut(st.inPoint, Math.max(t, (st.inPoint ?? 0) + 50))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── Ruler ticks ─────────────────────────────────────────────────────────
  const ticks = useMemo(() => {
    const candidates = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]
    const stepMs = candidates.find((c) => toX(c) >= 70) ?? 600000
    const out: Array<{ t: number; major: boolean }> = []
    const minor = stepMs / (stepMs >= 5000 ? 5 : 4)
    for (let t = 0; t <= duration + stepMs; t += minor) out.push({ t, major: Math.abs((t / stepMs) % 1) < 1e-6 })
    return out
  }, [toX, duration])

  const isSel = (kind: Selection['kind'], id: string): boolean => selection.kind === kind && 'id' in selection && selection.id === id

  const openMenu = (e: React.MouseEvent, items: Array<{ label: string; onClick: () => void; danger?: boolean }>): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const hasMic = !!project.recording.mic
  const hasSystem = !!project.recording.system || !!project.recording.screen?.hasAudio
  const music = tl.audio.music

  const trackRows: Array<{ key: string; icon: React.ReactNode; label: string; h: number; right?: React.ReactNode; body: React.ReactNode }> = []

  // Video track (clips are draggable to reorder; transitions overlap the previous clip)
  const startClipDrag = (e: React.PointerEvent, p: ClipPlacement): void => {
    if (e.button !== 0) return
    const x0 = e.clientX
    let moved = false
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 6) return
      moved = true
      const tPointer = toT(contentX(ev.clientX))
      let idx = places.length
      for (let i = 0; i < places.length; i++) {
        const mid = (places[i].start + places[i].end) / 2
        if (tPointer < mid) {
          idx = i
          break
        }
      }
      const d = { id: p.clip.id, dx, toIndex: idx }
      dragClipRef.current = d
      setDragClip(d)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const d = dragClipRef.current
      dragClipRef.current = null
      setDragClip(null)
      if (d && moved) {
        let to = d.toIndex
        if (to > p.index) to -= 1
        if (to !== p.index) updateTimeline((tl2) => moveClip(tl2, p.clip.id, to))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const dropX = dragClip ? (dragClip.toIndex < places.length ? toX(places[dragClip.toIndex].start) : toX(places[places.length - 1]?.end ?? 0)) : null

  trackRows.push({
    key: 'video',
    icon: <Video size={13} />,
    label: 'Video',
    h: 48,
    right: (
      <button className="text-fg-3 hover:text-fg" title="Add media (videos / images)" onClick={() => void addMediaToProject(project.id)}>
        <FilePlus size={13} />
      </button>
    ),
    body: (
      <>
        {places.map((p, i) => {
          const sel = isSel('clip', p.clip.id)
          const asset = assetFor(project, p.clip.sourceId)
          const isImage = asset?.kind === 'image'
          const label = asset?.name ?? (p.clip.sourceId ? 'Media' : `Clip ${i + 1}`)
          const dragging = dragClip?.id === p.clip.id
          return (
            <div
              key={p.clip.id}
              className={cn('absolute top-1.5 bottom-1.5 rounded-md overflow-hidden group select-none cursor-grab active:cursor-grabbing', sel ? 'ring-2 ring-accent' : 'ring-1 ring-white/10', dragging && 'z-20 opacity-90')}
              style={{ left: toX(p.start) + (dragging ? dragClip!.dx : 0), width: Math.max(4, toX(p.end) - toX(p.start)), background: isImage ? 'linear-gradient(180deg,#3b2f52,#2b2340)' : 'linear-gradient(180deg,#2a2d4a,#22243c)' }}
              onPointerDown={(e) => {
                if (e.button === 0) {
                  setSelection({ kind: 'clip', id: p.clip.id })
                  e.stopPropagation()
                  startClipDrag(e, p)
                }
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Split at playhead', onClick: () => updateTimeline((t) => splitAt(t, time)) },
                  ...(isImage ? [] : [
                    { label: 'Speed 0.5×', onClick: () => updateTimeline((t) => setClipSpeed(t, p.clip.id, 0.5)) },
                    { label: 'Speed 1×', onClick: () => updateTimeline((t) => setClipSpeed(t, p.clip.id, 1)) },
                    { label: 'Speed 1.5×', onClick: () => updateTimeline((t) => setClipSpeed(t, p.clip.id, 1.5)) },
                    { label: 'Speed 2×', onClick: () => updateTimeline((t) => setClipSpeed(t, p.clip.id, 2)) }
                  ]),
                  ...(asset?.hasAudio && !p.clip.muted ? [{ label: 'Detach audio', onClick: () => updateTimeline((t) => detachAudio(t, p.clip.id)) }] : []),
                  { label: p.clip.muted ? 'Unmute clip audio' : 'Mute clip audio', onClick: () => updateTimeline((t) => updateClip(t, p.clip.id, { muted: !p.clip.muted })) },
                  ...(places.length > 1 ? [{ label: 'Delete clip', danger: true, onClick: () => updateTimeline((t) => removeClip(t, p.clip.id)) }] : [])
                ])
              }
            >
              <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.08) 0 1px, transparent 1px 24px)' }} />
              {p.overlapIn > 0 && <div className="absolute left-0 top-0 bottom-0 bg-white/10 pointer-events-none" style={{ width: toX(p.overlapIn) }} />}
              <div className="absolute left-2 top-1 text-[11px] font-medium truncate right-2 flex items-center gap-1.5">
                {isImage ? <ImageIcon size={11} className="text-fg-3 shrink-0" /> : null}
                <span className="text-fg-2 truncate">{label}</span>
                {p.clip.speed !== 1 && <span className="px-1 rounded bg-accent/30 text-accent-2 text-[10px]">{p.clip.speed}×</span>}
                {p.clip.muted && <VolumeX size={10} className="text-fg-3" />}
                <span className="text-fg-3 font-mono text-[10px] ml-auto">{formatTime(p.end - p.start)}</span>
              </div>
              <div className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-accent/60" onPointerDown={(e) => dragClipEdge(e, p.clip.id, 'start')} />
              <div className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-accent/60" onPointerDown={(e) => dragClipEdge(e, p.clip.id, 'end')} />
            </div>
          )
        })}
        {places.slice(1).map((p) => (
          <button
            key={'tr-' + p.clip.id}
            className={cn('absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full grid place-items-center z-10 text-[10px] leading-none', p.clip.transitionIn ? 'bg-accent text-white shadow' : 'bg-bg-3 text-fg-3 border border-line-2 hover:text-fg')}
            style={{ left: toX(p.start + p.overlapIn / 2) }}
            title={p.clip.transitionIn ? `${TRANSITIONS.find((t) => t.value === p.clip.transitionIn!.type)?.label} · ${p.clip.transitionIn.durationMs}ms` : 'Add a transition'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              setSelection({ kind: 'clip', id: p.clip.id })
            }}
            onContextMenu={(e) =>
              openMenu(
                e,
                TRANSITIONS.map((t) => ({
                  label: t.label,
                  onClick: () => updateTimeline((tl2) => updateClip(tl2, p.clip.id, { transitionIn: t.value === 'cut' ? undefined : { type: t.value, durationMs: p.clip.transitionIn?.durationMs ?? 500 } }))
                }))
              )
            }
          >
            ◐
          </button>
        ))}
        {dropX != null && <div className="absolute top-0 bottom-0 w-[3px] bg-accent-2 z-30 pointer-events-none rounded" style={{ left: dropX - 1 }} />}
      </>
    )
  })

  const segTrack = <T extends { id: string; start: number; end: number }>(kind: SegKind, items: T[], color: string, label: (s: T) => string, onAdd: (t: number) => void, extraMenu?: (s: T) => Array<{ label: string; onClick: () => void; danger?: boolean }>): React.ReactNode => (
    <div className="absolute inset-0" onDoubleClick={(e) => onAdd(clamp(toT(contentX(e.clientX)), 0, duration))}>
      {items.map((s) => {
        const sel = isSel(kind, s.id)
        return (
          <div
            key={s.id}
            className={cn('absolute top-1 bottom-1 rounded-[5px] cursor-grab active:cursor-grabbing select-none overflow-hidden', sel ? 'ring-2 ring-white/80 z-10' : 'ring-1 ring-black/30')}
            style={{ left: toX(s.start), width: Math.max(6, toX(s.end) - toX(s.start)), background: color }}
            onPointerDown={(e) => {
              setSelection({ kind, id: s.id } as Selection)
              dragSeg(e, kind, s, 'move')
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) =>
              openMenu(e, [
                ...(extraMenu ? extraMenu(s) : []),
                {
                  label: 'Delete',
                  danger: true,
                  onClick: () => {
                    if (kind === 'zoom') useProject.getState().removeZoom(s.id)
                    if (kind === 'camera') useProject.getState().removeCameraSegment(s.id)
                    if (kind === 'text') useProject.getState().removeText(s.id)
                    if (kind === 'caption') useProject.getState().removeCaption(s.id)
                  }
                }
              ])
            }
          >
            <div className="px-1.5 text-[10.5px] leading-[20px] truncate text-white/90 font-medium">{label(s)}</div>
            <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={(e) => dragSeg(e, kind, s, 'start')} />
            <div className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/40" onPointerDown={(e) => dragSeg(e, kind, s, 'end')} />
          </div>
        )
      })}
      {items.length === 0 && <div className="absolute left-2 top-1/2 -translate-y-1/2 text-[10.5px] text-fg-3 pointer-events-none">Double-click to add</div>}
    </div>
  )

  trackRows.push({
    key: 'zoom',
    icon: <ZoomIn size={13} />,
    label: 'Zoom',
    h: 30,
    body: segTrack<ZoomSegment>(
      'zoom',
      tl.zooms,
      'linear-gradient(180deg,#8b6cff,#6a4ee0)',
      (z) => `${z.scale.toFixed(1)}×${z.origin === 'auto' ? '' : ' ✎'}`,
      (t) => {
        const cursor = ctx.compositor.events ? null : null
        void cursor
        const id = addZoom({ start: t, end: Math.min(duration, t + 2500), focus: { x: 0.5, y: 0.5 }, scale: project.render.zoom.defaultScale, origin: 'manual', followCursor: project.render.zoom.followCursor })
        setSelection({ kind: 'zoom', id })
      }
    )
  })

  if (project.recording.camera) {
    trackRows.push({
      key: 'camera',
      icon: <Camera size={13} />,
      label: 'Camera',
      h: 26,
      body: segTrack<CameraSegment>(
        'camera',
        tl.camera,
        'linear-gradient(180deg,#22c1a3,#149c82)',
        (s) => (s.fullscreen ? 'Fullscreen' : s.visible ? 'Show' : 'Hidden'),
        (t) => {
          const id = addCameraSegment({ start: t, end: Math.min(duration, t + 3000), visible: false })
          setSelection({ kind: 'camera', id })
        },
        (s) => [
          { label: 'Hidden', onClick: () => updateCameraSegment(s.id, { visible: false, fullscreen: false }) },
          { label: 'Visible (override)', onClick: () => updateCameraSegment(s.id, { visible: true, fullscreen: false }) },
          { label: 'Fullscreen camera', onClick: () => updateCameraSegment(s.id, { visible: true, fullscreen: true }) }
        ]
      )
    })
  }

  trackRows.push({
    key: 'text',
    icon: <Type size={13} />,
    label: 'Text',
    h: 26,
    body: segTrack<TextOverlay>('text', tl.texts, 'linear-gradient(180deg,#f59e0b,#d97706)', (s) => s.text.split('\n')[0], (t) => {
      const id = addText({ start: t, end: Math.min(duration, t + 3000) })
      setSelection({ kind: 'text', id })
    })
  })

  trackRows.push({
    key: 'captions',
    icon: <Subtitles size={13} />,
    label: 'Captions',
    h: 24,
    body:
      tl.captions.length > 0 ? (
        segTrack<CaptionSegment>('caption', tl.captions, 'linear-gradient(180deg,#3b82f6,#2563eb)', (s) => s.text, () => {})
      ) : (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 text-[10.5px] text-fg-3 pointer-events-none">Generate captions in the Captions panel</div>
      )
  })

  // ── Audio track: free-positioned blocks (detached clip audio, imported sounds) ──
  const audioClips = tl.audioClips ?? []
  // Overlapping blocks stack into sub-lanes so none hides another
  const audioLane = new Map<string, number>()
  const laneEnds: number[] = []
  for (const a of [...audioClips].sort((x, y) => x.start - y.start)) {
    let lane = laneEnds.findIndex((end) => end <= a.start)
    if (lane < 0) lane = laneEnds.push(0) - 1
    laneEnds[lane] = audioClipEnd(a)
    audioLane.set(a.id, lane)
  }
  const AUDIO_LANE_H = 42
  const audioLanes = Math.max(1, laneEnds.length)
  const assetOf = (sourceId: string) => assetFor(project, sourceId === 'screen' ? undefined : sourceId)
  const peaksOf = (sourceId: string): number[] | undefined => project.peaks?.[sourceId]
  const dragAudio = (e: React.PointerEvent, a: AudioClip, mode: 'move' | 'start' | 'end'): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const x0 = contentX(e.clientX)
    const orig = { ...a }
    const len = orig.sourceEnd - orig.sourceStart
    const srcDur = assetOf(a.sourceId)?.durationMs ?? Infinity
    let first = true
    const move = (ev: PointerEvent): void => {
      const dt = toT(contentX(ev.clientX) - x0)
      let patch: Partial<AudioClip> = {}
      if (mode === 'move') {
        let s = Math.max(0, orig.start + dt)
        const sn = snapT(s, [orig.start, orig.start + len])
        const en = snapT(s + len, [orig.start, orig.start + len])
        s = Math.abs(sn - s) <= Math.abs(en - (s + len)) ? sn : en - len
        patch = { start: Math.max(0, s) }
      } else if (mode === 'start') {
        const ns = clamp(orig.sourceStart + dt, 0, orig.sourceEnd - 100)
        patch = { sourceStart: ns, start: Math.max(0, orig.start + (ns - orig.sourceStart)) }
      } else {
        patch = { sourceEnd: clamp(orig.sourceEnd + dt, orig.sourceStart + 100, srcDur) }
      }
      updateAudioClip(a.id, patch, first)
      first = false
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  trackRows.push({
    key: 'audioclips',
    icon: <AudioLines size={13} />,
    label: 'Audio',
    h: 4 + AUDIO_LANE_H * audioLanes,
    right: (
      <button className="text-fg-3 hover:text-fg" title="Add audio file" onClick={() => void addMediaToProject(project.id)}>
        <FilePlus size={13} />
      </button>
    ),
    body: (
      <div className="absolute inset-0" onDoubleClick={() => void addMediaToProject(project.id)}>
        {audioClips.map((a) => {
          const sel = isSel('audioClip', a.id)
          const asset = assetOf(a.sourceId)
          const w = Math.max(6, toX(audioClipEnd(a)) - toX(a.start))
          const label = a.name ?? asset?.name ?? (a.sourceId === 'screen' ? 'Recording audio' : a.sourceId)
          return (
            <div
              key={a.id}
              className={cn('absolute rounded-md overflow-hidden select-none cursor-grab active:cursor-grabbing', sel ? 'ring-2 ring-accent z-10' : 'ring-1 ring-white/10', a.muted && 'opacity-50')}
              style={{ left: toX(a.start), width: w, top: 4 + (audioLane.get(a.id) ?? 0) * AUDIO_LANE_H, height: AUDIO_LANE_H - 4, background: 'linear-gradient(180deg,#1f3a3a,#183030)' }}
              onPointerDown={(e) => {
                setSelection({ kind: 'audioClip', id: a.id })
                dragAudio(e, a, 'move')
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: a.muted ? 'Unmute' : 'Mute', onClick: () => updateAudioClip(a.id, { muted: !a.muted }) },
                  ...(a.fromClipId ? [{ label: 'Re-attach to video clip', onClick: () => updateTimeline((t) => reattachAudio(t, a.id)) }] : []),
                  { label: 'Delete', danger: true, onClick: () => removeAudioClip(a.id) }
                ])
              }
            >
              <ClipWave peaks={peaksOf(a.sourceId)} sourceStart={a.sourceStart} sourceEnd={a.sourceEnd} sourceDur={asset?.durationMs ?? a.sourceEnd} width={w} height={38} muted={a.muted} volume={a.volume} />
              <div className="absolute left-2 top-0.5 right-2 text-[10.5px] font-medium truncate text-teal-100/90 flex items-center gap-1 pointer-events-none">
                {a.muted && <VolumeX size={10} />}
                <span className="truncate">{label}</span>
                <span className="ml-auto font-mono text-[10px] text-fg-3">{formatTime(a.sourceEnd - a.sourceStart)}</span>
              </div>
              <div className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-accent/60" onPointerDown={(e) => dragAudio(e, a, 'start')} />
              <div className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize hover:bg-accent/60" onPointerDown={(e) => dragAudio(e, a, 'end')} />
            </div>
          )
        })}
        {audioClips.length === 0 && <div className="absolute left-2 top-1/2 -translate-y-1/2 text-[10.5px] text-fg-3 pointer-events-none">Right-click a video clip → "Detach audio", or double-click to add an audio file</div>}
      </div>
    )
  })

  const audioRow = (key: 'mic' | 'system' | 'music' | 'screen', icon: React.ReactNode, label: string, settings: { volume: number; muted: boolean }, toggle: () => void, peaks?: number[]): void => {
    trackRows.push({
      key,
      icon,
      label,
      h: 40,
      right: (
        <button className="text-fg-3 hover:text-fg" onClick={toggle} title={settings.muted ? 'Unmute' : 'Mute'}>
          {settings.muted ? <VolumeX size={13} className="text-danger" /> : <Volume2 size={13} />}
        </button>
      ),
      body: <Waveform peaks={peaks} places={places} toX={toX} width={contentW} muted={settings.muted} volume={settings.volume} basis={key === 'music' ? 'timeline' : 'source'} offset={key === 'music' ? music?.offset ?? 0 : 0} musicDur={music?.durationMs} sourceDur={project.recording.durationMs} />
    })
  }
  if (hasMic) audioRow('mic', <Mic size={13} />, 'Microphone', tl.audio.mic, () => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, mic: { ...p.timeline.audio.mic, muted: !p.timeline.audio.mic.muted } })), project.peaks?.mic)
  if (hasSystem) audioRow('system', <Speaker size={13} />, 'System audio', tl.audio.system, () => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, system: { ...p.timeline.audio.system, muted: !p.timeline.audio.system.muted } })), project.peaks?.system ?? project.peaks?.screen)
  if (music) audioRow('music', <Music size={13} />, 'Music', music, () => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: p.timeline.audio.music ? { ...p.timeline.audio.music, muted: !p.timeline.audio.music.muted } : null })), project.peaks?.music)

  const totalH = RULER_H + trackRows.reduce((a, r) => a + r.h, 0)

  return (
    <div className="h-full flex flex-col bg-bg-1 border-t border-line select-none">
      <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-auto relative" onWheel={onWheel}>
        <div className="relative" style={{ width: HEADER_W + contentW, minHeight: '100%', height: totalH }}>
          {/* Headers */}
          <div className="sticky left-0 z-20 absolute top-0 bottom-0" style={{ width: HEADER_W, position: 'sticky' }}>
            <div className="absolute left-0 top-0 bottom-0 bg-bg-1 border-r border-line" style={{ width: HEADER_W }}>
              <div className="h-[24px] border-b border-line flex items-center px-3 text-[10.5px] font-mono text-fg-3">{formatTime(time, { frames: 60 })}</div>
              {trackRows.map((r) => (
                <div key={r.key} className="border-b border-line flex items-center justify-between px-3 text-[11.5px] text-fg-2" style={{ height: r.h }}>
                  <span className="flex items-center gap-1.5 truncate">
                    <span className="text-fg-3">{r.icon}</span>
                    {r.label}
                  </span>
                  {r.right}
                </div>
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="absolute top-0 bottom-0" style={{ left: HEADER_W, width: contentW }}>
            {/* Ruler */}
            <div className="h-[24px] border-b border-line relative cursor-pointer bg-bg-1" onPointerDown={startScrub} onDoubleClick={(e) => e.stopPropagation()}>
              {ticks.map((tk) => (
                <div key={tk.t} className="absolute bottom-0" style={{ left: toX(tk.t) }}>
                  <div className={cn('w-px bg-white/25', tk.major ? 'h-3' : 'h-1.5')} />
                  {tk.major && <div className="absolute bottom-3 left-1 text-[9.5px] font-mono text-fg-3 whitespace-nowrap">{formatTime(tk.t, { long: false }).replace(/\.\d\d$/, '')}</div>}
                </div>
              ))}
              {tl.markers.map((m) => (
                <div
                  key={m.id}
                  className="absolute top-0 text-warn cursor-pointer"
                  style={{ left: toX(m.t) - 6 }}
                  title={m.label || 'Marker (right-click to remove)'}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    setTime(m.t)
                  }}
                  onContextMenu={(e) => openMenu(e, [{ label: 'Remove marker', danger: true, onClick: () => updateTimeline((t) => ({ ...t, markers: t.markers.filter((x) => x.id !== m.id) })) }])}
                >
                  <Flag size={11} fill="currentColor" />
                </div>
              ))}
            </div>

            {/* Tracks */}
            {trackRows.map((r) => (
              <div key={r.key} className="relative border-b border-line/60" style={{ height: r.h }} onPointerDown={(e) => e.target === e.currentTarget && setSelection({ kind: 'none' })}>
                {r.body}
              </div>
            ))}

            {/* Clip boundaries */}
            {places.slice(1).map((p) => (
              <div key={p.clip.id} className="absolute top-[24px] bottom-0 w-px bg-white/10 pointer-events-none" style={{ left: toX(p.start) }} />
            ))}

            {/* In/Out range */}
            {inPoint != null && outPoint != null && (
              <>
                <div className="absolute top-0 bottom-0 bg-accent/10 pointer-events-none" style={{ left: toX(inPoint), width: toX(outPoint) - toX(inPoint) }} />
                <div className="absolute top-0 bottom-0 w-[3px] bg-accent cursor-ew-resize z-20" style={{ left: toX(inPoint) - 1 }} onPointerDown={(e) => dragInOut(e, 'in')} />
                <div className="absolute top-0 bottom-0 w-[3px] bg-accent cursor-ew-resize z-20" style={{ left: toX(outPoint) - 1 }} onPointerDown={(e) => dragInOut(e, 'out')} />
              </>
            )}
            {inPoint != null && outPoint == null && <div className="absolute top-0 bottom-0 w-[2px] bg-accent/70 pointer-events-none" style={{ left: toX(inPoint) }} />}
            {outPoint != null && inPoint == null && <div className="absolute top-0 bottom-0 w-[2px] bg-accent/70 pointer-events-none" style={{ left: toX(outPoint) }} />}

            {/* End of timeline shade */}
            <div className="absolute top-0 bottom-0 right-0 pointer-events-none" style={{ left: toX(duration), background: 'repeating-linear-gradient(-45deg, rgba(255,255,255,0.025) 0 6px, transparent 6px 12px)' }} />

            {/* Playhead */}
            <div className="absolute top-0 bottom-0 z-30 pointer-events-none" style={{ left: toX(time) }}>
              <div className="absolute -top-0 -translate-x-1/2 w-3 h-3 bg-danger rotate-45 rounded-[2px]" style={{ top: 2 }} />
              <div className="absolute top-0 bottom-0 w-px bg-danger -translate-x-1/2" />
            </div>
          </div>
        </div>
      </div>

      {menu && (
        <div className="fixed z-[100] card p-1 w-44 fade-in" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - menu.items.length * 32 - 20), boxShadow: 'var(--shadow-pop)' }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) => (
            <button
              key={i}
              className={cn('w-full text-left px-2.5 h-7 rounded-md text-[12px] hover:bg-white/[0.06]', it.danger && 'text-danger')}
              onClick={() => {
                setMenu(null)
                it.onClick()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Waveform of one source range drawn into a block of `width` px. */
function ClipWave({ peaks, sourceStart, sourceEnd, sourceDur, width, height, muted, volume }: { peaks?: number[]; sourceStart: number; sourceEnd: number; sourceDur: number; width: number; height: number; muted: boolean; volume: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = Math.max(1, Math.ceil(width * dpr))
    c.height = Math.ceil(height * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, height)
    if (!peaks || peaks.length === 0 || sourceDur <= 0) return
    g.fillStyle = muted ? 'rgba(255,255,255,0.18)' : 'rgba(94,234,212,0.85)'
    const n = Math.max(1, Math.floor(width))
    const mid = height / 2 + 4
    for (let i = 0; i < n; i++) {
      const s = sourceStart + ((sourceEnd - sourceStart) * i) / n
      const idx = Math.floor((s / sourceDur) * peaks.length)
      const p = clamp((peaks[idx] ?? 0) * Math.min(1.5, volume), 0, 1)
      const bh = Math.max(1, p * (height - 14))
      g.fillRect(i, mid - bh / 2, 1, bh)
    }
  }, [peaks, sourceStart, sourceEnd, sourceDur, width, height, muted, volume])
  return <canvas ref={ref} className="absolute inset-0" style={{ width, height }} />
}

function Waveform({ peaks, places, toX, width, muted, volume, basis, offset, musicDur, sourceDur }: { peaks?: number[]; places: ReturnType<typeof placeClips>; toX: (t: number) => number; width: number; muted: boolean; volume: number; basis: 'source' | 'timeline'; offset: number; musicDur?: number; sourceDur: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const h = 40
    c.width = Math.ceil(width * dpr)
    c.height = h * dpr
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, h)
    const color = muted ? 'rgba(255,255,255,0.15)' : 'rgba(96,165,250,0.85)'
    const drawRange = (x0: number, x1: number, srcA: number, srcB: number, totalDur: number): void => {
      g.fillStyle = 'rgba(96,165,250,0.08)'
      g.fillRect(x0, 4, x1 - x0, h - 8)
      if (!peaks || peaks.length === 0 || totalDur <= 0) return
      g.fillStyle = color
      const n = Math.max(1, Math.floor(x1 - x0))
      for (let i = 0; i < n; i++) {
        const f = i / n
        const s = srcA + (srcB - srcA) * f
        const idx = Math.floor((s / totalDur) * peaks.length)
        const p = clamp((peaks[idx] ?? 0) * Math.min(1.5, volume), 0, 1)
        const bh = Math.max(1, p * (h - 10))
        g.fillRect(x0 + i, h / 2 - bh / 2, 1, bh)
      }
    }
    if (basis === 'source') {
      for (const p of places) drawRange(toX(p.start), toX(p.end), p.clip.sourceStart, p.clip.sourceEnd, sourceDur)
    } else {
      const dur = musicDur ?? 0
      const end = places.length ? places[places.length - 1].end : 0
      if (dur > 0) drawRange(toX(offset), toX(Math.min(end, offset + dur)), 0, Math.min(dur, end - offset), dur)
      else drawRange(toX(offset), toX(end), 0, 1, 1)
    }
  }, [peaks, places, toX, width, muted, volume, basis, offset, musicDur, sourceDur])
  return <canvas ref={ref} className="absolute inset-0" style={{ width, height: 40 }} />
}
