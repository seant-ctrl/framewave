import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Undo2, Redo2, Download, Scissors, Trash2, Magnet, ZoomIn, ZoomOut, Ratio, Flag } from 'lucide-react'
import { useProject, useDuration } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { useApp } from '@/store/appStore'
import { MediaPlayer } from '@/engine/player'
import { Compositor } from '@/engine/compositor'
import { generateAutoZooms } from '@/engine/zoom'
import { splitAt, deleteRange, removeClip, timelineDuration, placeClips } from '@/engine/timeline'
import { computePeaks } from '@/engine/audio'
import { renderThumbnail } from '@/export/exporter'
import { fw, projectMediaUrl } from '@/lib/fw'
import { cn, uid } from '@/lib/utils'
import { Preview } from './Preview'
import { Timeline } from './Timeline'
import { Inspector } from './Inspector'
import { ExportDialog } from './ExportDialog'
import { IconButton, Segmented, Spinner } from '../ui/ui'
import type { AspectPreset } from '@shared/types'

export interface EditorContext {
  player: MediaPlayer
  compositor: Compositor
}

export function Editor({ projectId }: { projectId: string }): React.JSX.Element {
  const load = useProject((s) => s.load)
  const project = useProject((s) => s.project)
  const events = useProject((s) => s.events)
  const loading = useProject((s) => s.loading)
  const mutate = useProject((s) => s.mutate)
  const undo = useProject((s) => s.undo)
  const redo = useProject((s) => s.redo)
  const canUndo = useProject((s) => s.history.length > 0)
  const canRedo = useProject((s) => s.future.length > 0)
  const selection = useProject((s) => s.selection)
  const setSelection = useProject((s) => s.setSelection)
  const updateTimeline = useProject((s) => s.updateTimeline)
  const updateRender = useProject((s) => s.updateRender)
  const removeZoom = useProject((s) => s.removeZoom)
  const removeText = useProject((s) => s.removeText)
  const removeCameraSegment = useProject((s) => s.removeCameraSegment)
  const removeCaption = useProject((s) => s.removeCaption)
  const toast = useApp((s) => s.toast)

  const time = usePlayer((s) => s.time)
  const setTime = usePlayer((s) => s.setTime)
  const playing = usePlayer((s) => s.playing)
  const setPlaying = usePlayer((s) => s.setPlaying)
  const pxPerSec = usePlayer((s) => s.pxPerSec)
  const setPxPerSec = usePlayer((s) => s.setPxPerSec)
  const inPoint = usePlayer((s) => s.inPoint)
  const outPoint = usePlayer((s) => s.outPoint)
  const setInOut = usePlayer((s) => s.setInOut)
  const duration = useDuration()

  const [ctx, setCtx] = useState<EditorContext | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [snapping, setSnapping] = useState(true)
  const [tlHeight, setTlHeight] = useState(250)
  const ctxRef = useRef<EditorContext | null>(null)

  useEffect(() => {
    void load(projectId)
    setTime(0)
    setPlaying(false)
    setInOut(null, null)
  }, [projectId, load, setTime, setPlaying, setInOut])

  // Create player/compositor when project is loaded
  useEffect(() => {
    if (!project || loading) return
    if (ctxRef.current) {
      ctxRef.current.player.update(project)
      ctxRef.current.compositor.update(project, events)
      return
    }
    const player = new MediaPlayer(project)
    const compositor = new Compositor(project, events)
    player.onEnded = () => {
      if (usePlayer.getState().loop) {
        player.seek(usePlayer.getState().inPoint ?? 0)
        void player.play()
      } else setPlaying(false)
    }
    const c = { player, compositor }
    ctxRef.current = c
    setCtx(c)
    if (import.meta.env.DEV) (window as unknown as { __fwCtx: unknown }).__fwCtx = c
  }, [project, events, loading, setPlaying])

  useEffect(
    () => () => {
      ctxRef.current?.player.destroy()
      ctxRef.current = null
    },
    []
  )

  // Auto-zoom generation on first open + peaks + thumbnail
  const bootstrapped = useRef<string | null>(null)
  useEffect(() => {
    if (!project || loading || bootstrapped.current === project.id) return
    bootstrapped.current = project.id
    const p = project
    const flags = p.flags ?? {}
    if (!flags.autoZoom && events && p.render.zoom.autoEnabled && p.timeline.zooms.length === 0) {
      const comp = new Compositor(p, events)
      const zooms = generateAutoZooms(events, p.timeline, p.render, (pt) => comp.cropOf(pt))
      mutate(
        (np) => {
          np.timeline = { ...np.timeline, zooms }
          np.flags = { ...flags, autoZoom: true }
        },
        { history: false }
      )
      if (zooms.length) toast({ kind: 'info', title: `Added ${zooms.length} automatic zoom${zooms.length > 1 ? 's' : ''}`, message: 'Tweak or regenerate them in the Zoom panel.' })
    }
    // Peaks
    void (async () => {
      const r = p.recording
      const want: Array<[string, string]> = []
      if (r.mic && !p.peaks?.mic) want.push(['mic', r.mic.file])
      if (r.system && !p.peaks?.system) want.push(['system', r.system.file])
      if (r.screen?.hasAudio && !p.peaks?.screen) want.push(['screen', r.screen.file])
      for (const [name, file] of want) {
        const peaks = await computePeaks(projectMediaUrl(p.dir, file), 3000)
        if (peaks) mutate((np) => (np.peaks = { ...(np.peaks ?? {}), [name]: peaks }), { history: false })
      }
    })()
    // Thumbnail
    void (async () => {
      try {
        const t = Math.min(timelineDuration(p.timeline) * 0.15, 5000)
        const blob = await renderThumbnail(p, events, t, 640)
        if (blob) await fw.projects.writeFile(p.id, 'thumb.jpg', new Uint8Array(await blob.arrayBuffer()))
      } catch (e) {
        console.warn('thumbnail failed', e)
      }
    })()
  }, [project, loading, events, mutate, toast])

  // ── Commands ────────────────────────────────────────────────────────────
  const splitAtPlayhead = useCallback(() => {
    if (!project) return
    updateTimeline((t) => splitAt(t, time))
  }, [project, time, updateTimeline])

  const deleteSelected = useCallback(() => {
    if (!project) return
    switch (selection.kind) {
      case 'clip':
        if (project.timeline.clips.length > 1) updateTimeline((t) => removeClip(t, (selection as { id: string }).id))
        else toast({ kind: 'info', title: 'Cannot delete the only clip' })
        break
      case 'zoom':
        removeZoom(selection.id)
        break
      case 'text':
        removeText(selection.id)
        break
      case 'camera':
        removeCameraSegment(selection.id)
        break
      case 'caption':
        removeCaption(selection.id)
        break
      case 'range':
        updateTimeline((t) => deleteRange(t, selection.start, selection.end))
        setSelection({ kind: 'none' })
        setInOut(null, null)
        setTime(selection.start)
        break
    }
  }, [project, selection, updateTimeline, removeZoom, removeText, removeCameraSegment, removeCaption, setSelection, setInOut, setTime, toast])

  const deleteInOut = useCallback(() => {
    if (inPoint == null || outPoint == null || outPoint <= inPoint) return
    updateTimeline((t) => deleteRange(t, inPoint, outPoint))
    setInOut(null, null)
    setTime(inPoint)
    toast({ kind: 'success', title: 'Range removed' })
  }, [inPoint, outPoint, updateTimeline, setInOut, setTime, toast])

  // ── Keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return
      const mod = e.ctrlKey || e.metaKey
      const player = ctxRef.current?.player
      const step = 1000 / 60
      const d = duration
      switch (e.key) {
        case ' ':
          e.preventDefault()
          setPlaying(!usePlayer.getState().playing)
          break
        case 'k':
          setPlaying(false)
          break
        case 'ArrowLeft':
          e.preventDefault()
          setTime(Math.max(0, time - (e.shiftKey ? 1000 : step)))
          break
        case 'ArrowRight':
          e.preventDefault()
          setTime(Math.min(d, time + (e.shiftKey ? 1000 : step)))
          break
        case 'Home':
          setTime(0)
          break
        case 'End':
          setTime(d)
          break
        case 's':
        case 'S':
          if (!mod) splitAtPlayhead()
          break
        case 'Delete':
        case 'Backspace':
          if (selection.kind !== 'none') deleteSelected()
          else if (inPoint != null && outPoint != null) deleteInOut()
          break
        case 'i':
        case 'I':
          setInOut(time, outPoint != null && outPoint > time ? outPoint : null)
          break
        case 'o':
        case 'O':
          setInOut(inPoint != null && inPoint < time ? inPoint : null, time)
          break
        case 'x':
        case 'X':
          setInOut(null, null)
          break
        case 'z':
        case 'Z':
          if (mod) {
            e.preventDefault()
            e.shiftKey ? redo() : undo()
          }
          break
        case 'y':
        case 'Y':
          if (mod) {
            e.preventDefault()
            redo()
          }
          break
        case 'e':
        case 'E':
          if (mod) {
            e.preventDefault()
            setExportOpen(true)
          }
          break
        case 'm':
        case 'M':
          updateTimeline((t) => ({ ...t, markers: [...t.markers, { id: uid('m'), t: time, label: '' }] }))
          break
        case '=':
        case '+':
          if (mod) {
            e.preventDefault()
            setPxPerSec(pxPerSec * 1.3)
          }
          break
        case '-':
          if (mod) {
            e.preventDefault()
            setPxPerSec(pxPerSec / 1.3)
          }
          break
        case 'Escape':
          setSelection({ kind: 'none' })
          break
        case 'j':
          setTime(Math.max(0, time - 5000))
          break
        case 'l':
          setTime(Math.min(d, time + 5000))
          break
      }
      void player
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [time, duration, selection, inPoint, outPoint, pxPerSec, setPlaying, setTime, setInOut, setPxPerSec, splitAtPlayhead, deleteSelected, deleteInOut, undo, redo, updateTimeline, setSelection])

  // Timeline height drag
  const onResizeStart = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = tlHeight
    const move = (ev: PointerEvent): void => setTlHeight(Math.max(140, Math.min(window.innerHeight * 0.6, startH - (ev.clientY - startY))))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const aspectOptions = useMemo(
    () =>
      (['source', '16:9', '9:16', '1:1', '4:3', '4:5', '21:9'] as AspectPreset[]).map((a) => ({
        value: a,
        label: a === 'source' ? 'Auto' : a
      })),
    []
  )

  if (loading || !project || !ctx) {
    return (
      <div className="h-full grid place-items-center text-fg-3">
        <div className="flex flex-col items-center gap-3">
          <Spinner size={22} className="text-accent-2" />
          <div className="text-[12.5px]">Opening project…</div>
        </div>
      </div>
    )
  }

  const clipCount = placeClips(project.timeline).length

  return (
    <div className="h-full flex min-h-0">
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Toolbar */}
        <div className="h-11 shrink-0 flex items-center justify-between px-3 border-b border-line bg-bg-1">
          <div className="flex items-center gap-1">
            <IconButton icon={<Undo2 size={15} />} label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo} />
            <IconButton icon={<Redo2 size={15} />} label="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo} />
            <div className="w-px h-5 bg-line mx-1" />
            <IconButton icon={<Scissors size={15} />} label="Split at playhead (S)" onClick={splitAtPlayhead} />
            <IconButton icon={<Trash2 size={15} />} label={inPoint != null && outPoint != null && selection.kind === 'none' ? 'Delete in/out range (Del)' : 'Delete selection (Del)'} onClick={() => (selection.kind !== 'none' ? deleteSelected() : deleteInOut())} disabled={selection.kind === 'none' && !(inPoint != null && outPoint != null)} />
            <IconButton icon={<Flag size={15} />} label="Add marker (M)" onClick={() => updateTimeline((t) => ({ ...t, markers: [...t.markers, { id: uid('m'), t: time, label: '' }] }))} />
            <div className="w-px h-5 bg-line mx-1" />
            <IconButton icon={<Magnet size={15} />} label="Snapping" active={snapping} onClick={() => setSnapping(!snapping)} />
            <IconButton icon={<ZoomOut size={15} />} label="Zoom out timeline (Ctrl -)" onClick={() => setPxPerSec(pxPerSec / 1.3)} />
            <IconButton icon={<ZoomIn size={15} />} label="Zoom in timeline (Ctrl +)" onClick={() => setPxPerSec(pxPerSec * 1.3)} />
            <span className="text-[11px] text-fg-3 ml-2">
              {clipCount} clip{clipCount === 1 ? '' : 's'} · {project.timeline.zooms.length} zooms
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Ratio size={14} className="text-fg-3" />
              <Segmented size="sm" value={project.render.aspect} onChange={(a) => updateRender({ aspect: a })} options={aspectOptions} />
            </div>
            <button className="btn btn-primary gap-1.5" onClick={() => setExportOpen(true)}>
              <Download size={14} /> Export
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0 relative">
          <Preview ctx={ctx} />
        </div>

        {/* Resize handle */}
        <div className={cn('h-1.5 shrink-0 cursor-row-resize hover:bg-accent/40 transition-colors bg-line')} onPointerDown={onResizeStart} />

        {/* Timeline */}
        <div className="shrink-0" style={{ height: tlHeight }}>
          <Timeline ctx={ctx} snapping={snapping} />
        </div>
      </div>

      <Inspector ctx={ctx} />

      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      {playing && null}
    </div>
  )
}
