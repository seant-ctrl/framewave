import React from 'react'
import { Sparkles, Trash2, Plus, Crosshair, EyeOff, Eye, Maximize } from 'lucide-react'
import { useProject } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { Slider, Toggle, Segmented, ColorField, Section, Row, Select, NumberField } from '../../ui/ui'
import { generateAutoZooms } from '@/engine/zoom'
import { timelineDuration } from '@/engine/timeline'
import { formatTime, cn } from '@/lib/utils'
import { useApp } from '@/store/appStore'
import type { EditorContext } from '../Editor'
import type { CameraPosition } from '@shared/types'

export function ZoomPanel({ ctx }: { ctx: EditorContext }): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const events = useProject((s) => s.events)
  const updateRender = useProject((s) => s.updateRender)
  const updateTimeline = useProject((s) => s.updateTimeline)
  const selection = useProject((s) => s.selection)
  const updateZoom = useProject((s) => s.updateZoom)
  const removeZoom = useProject((s) => s.removeZoom)
  const addZoom = useProject((s) => s.addZoom)
  const setSelection = useProject((s) => s.setSelection)
  const time = usePlayer((s) => s.time)
  const toast = useApp((s) => s.toast)
  const z = project.render.zoom
  const setZ = (patch: Partial<typeof z>, history = true): void => updateRender({ zoom: { ...z, ...patch } }, { history })
  const selected = selection.kind === 'zoom' ? project.timeline.zooms.find((x) => x.id === selection.id) : null
  const duration = timelineDuration(project.timeline)

  const regenerate = (): void => {
    if (!events) return
    const zooms = generateAutoZooms(events, project.timeline, project.render, (p) => ctx.compositor.cropOf(p))
    updateTimeline((t) => ({ ...t, zooms: [...t.zooms.filter((x) => x.origin === 'manual'), ...zooms].sort((a, b) => a.start - b.start) }))
    toast({ kind: 'success', title: `Generated ${zooms.length} zoom segments` })
  }

  return (
    <div>
      <Section title="Automatic zoom" right={<Toggle checked={z.autoEnabled} onChange={(v) => setZ({ autoEnabled: v })} />}>
        <div className="text-[11.5px] text-fg-3">Zooms are generated from your clicks and typing. Adjust the feel here, then regenerate.</div>
        <Row label="Sensitivity">
          <Segmented size="sm" value={z.sensitivity} onChange={(v) => setZ({ sensitivity: v })} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
        </Row>
        <Slider label="Default zoom level" value={z.defaultScale} min={1.2} max={4} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => setZ({ defaultScale: v }, false)} onCommit={(v) => setZ({ defaultScale: v })} />
        <Slider label="Hold after click" value={z.holdMs} min={500} max={5000} step={50} format={(v) => `${(v / 1000).toFixed(1)}s`} onChange={(v) => setZ({ holdMs: v }, false)} onCommit={(v) => setZ({ holdMs: v })} />
        <div className="flex gap-2">
          <button className="btn btn-primary flex-1" disabled={!events} onClick={regenerate}>
            <Sparkles size={13} /> Regenerate
          </button>
          <button className="btn" disabled={project.timeline.zooms.length === 0} onClick={() => updateTimeline((t) => ({ ...t, zooms: [] }))}>
            <Trash2 size={13} /> Clear
          </button>
        </div>
        {!events && <div className="text-[11.5px] text-warn">No cursor data in this project — add zooms manually on the timeline.</div>}
      </Section>

      <Section title="Motion">
        <Slider label="Transition" value={z.transitionMs} min={150} max={1500} step={10} format={(v) => `${Math.round(v)}ms`} onChange={(v) => setZ({ transitionMs: v }, false)} onCommit={(v) => setZ({ transitionMs: v })} />
        <Select label="Easing" value={z.easing} onChange={(v) => setZ({ easing: v })} options={[{ value: 'spring', label: 'Spring (natural)' }, { value: 'ease-in-out', label: 'Ease in-out' }, { value: 'ease-out-expo', label: 'Snappy' }, { value: 'linear', label: 'Linear' }]} />
        <Toggle label="Follow cursor while zoomed" hint="Camera pans smoothly to keep the cursor in view" checked={z.followCursor} onChange={(v) => setZ({ followCursor: v })} />
        <Slider label="Follow smoothness" value={z.followSmoothing} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} disabled={!z.followCursor} onChange={(v) => setZ({ followSmoothing: v }, false)} onCommit={(v) => setZ({ followSmoothing: v })} />
      </Section>

      <Section
        title={selected ? 'Selected zoom' : 'Zoom segments'}
        right={
          <button
            className="btn btn-sm"
            onClick={() => {
              const id = addZoom({ start: time, end: Math.min(duration, time + 2500), focus: { x: 0.5, y: 0.5 }, scale: z.defaultScale, origin: 'manual', followCursor: z.followCursor })
              setSelection({ kind: 'zoom', id })
            }}
          >
            <Plus size={12} /> Add at playhead
          </button>
        }
      >
        {selected ? (
          <>
            <div className="text-[11.5px] text-fg-3 flex items-center gap-1.5">
              <Crosshair size={12} /> Click on the preview to set the focus point.
            </div>
            <Slider label="Zoom level" value={selected.scale} min={1.1} max={5} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => updateZoom(selected.id, { scale: v }, false)} onCommit={(v) => updateZoom(selected.id, { scale: v })} />
            <Slider label="Focus X" value={selected.focus.x} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateZoom(selected.id, { focus: { ...selected.focus, x: v } }, false)} onCommit={(v) => updateZoom(selected.id, { focus: { ...selected.focus, x: v } })} />
            <Slider label="Focus Y" value={selected.focus.y} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateZoom(selected.id, { focus: { ...selected.focus, y: v } }, false)} onCommit={(v) => updateZoom(selected.id, { focus: { ...selected.focus, y: v } })} />
            <Row label="Start">
              <NumberField value={Math.round(selected.start)} min={0} max={selected.end - 100} step={100} suffix="ms" width={92} onChange={(v) => updateZoom(selected.id, { start: v })} />
            </Row>
            <Row label="End">
              <NumberField value={Math.round(selected.end)} min={selected.start + 100} max={duration} step={100} suffix="ms" width={92} onChange={(v) => updateZoom(selected.id, { end: v })} />
            </Row>
            <Toggle label="Follow cursor" checked={selected.followCursor} onChange={(v) => updateZoom(selected.id, { followCursor: v })} />
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={() => usePlayer.getState().setTime(selected.start)}>
                Go to start
              </button>
              <button className="btn btn-danger" onClick={() => removeZoom(selected.id)}>
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </>
        ) : project.timeline.zooms.length === 0 ? (
          <div className="text-[11.5px] text-fg-3">No zoom segments yet. Double-click the Zoom track or use the button above.</div>
        ) : (
          <div className="flex flex-col gap-1 max-h-[260px] overflow-y-auto -mx-1 px-1">
            {project.timeline.zooms.map((s, i) => (
              <button
                key={s.id}
                className="flex items-center justify-between px-2.5 h-8 rounded-md hover:bg-white/[0.05] text-[12px]"
                onClick={() => {
                  setSelection({ kind: 'zoom', id: s.id })
                  usePlayer.getState().setTime(s.start + 50)
                }}
              >
                <span className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded grid place-items-center text-[10px] bg-accent-soft text-accent-2">{i + 1}</span>
                  <span className="font-mono text-fg-2">
                    {formatTime(s.start)} → {formatTime(s.end)}
                  </span>
                </span>
                <span className="text-fg-3">
                  {s.scale.toFixed(1)}× {s.origin === 'auto' ? '· auto' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

export function CursorPanel(): React.JSX.Element {
  const render = useProject((s) => s.project!.render)
  const events = useProject((s) => s.events)
  const updateRender = useProject((s) => s.updateRender)
  const c = render.cursor
  const setC = (patch: Partial<typeof c>, history = true): void => updateRender({ cursor: { ...c, ...patch } }, { history })
  return (
    <div>
      {!events && <div className="m-4 text-[12px] text-warn bg-warn/10 border border-warn/20 rounded-lg p-3">This project has no cursor tracking data (imported video). Cursor settings won't have any effect.</div>}
      <Section title="Cursor" right={<Toggle checked={c.mode === 'custom'} onChange={(v) => setC({ mode: v ? 'custom' : 'hidden' })} />}>
        <div className="text-[11.5px] text-fg-3">The recorded cursor is replaced with a crisp, smoothed cursor rendered on top of your video.</div>
        <Row label="Style">
          <Segmented size="sm" value={c.style} onChange={(v) => setC({ style: v })} options={[{ value: 'arrow', label: 'Arrow' }, { value: 'arrow-dark', label: 'Dark' }, { value: 'hand', label: 'Hand' }, { value: 'dot', label: 'Dot' }, { value: 'ring', label: 'Ring' }]} />
        </Row>
        <Slider label="Size" value={c.size} min={0.5} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setC({ size: v }, false)} onCommit={(v) => setC({ size: v })} />
        <Toggle label="Adaptive shape" hint="Show I-beam over text, hand over links, resize arrows…" checked={c.adaptiveShape !== false} onChange={(v) => setC({ adaptiveShape: v })} />
        <Slider label="Smoothing" value={c.smoothing} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setC({ smoothing: v }, false)} onCommit={(v) => setC({ smoothing: v })} />
        <Row label="Tint">
          <div className="flex items-center gap-2">
            <Toggle checked={c.tint != null} onChange={(v) => setC({ tint: v ? '#7c5cff' : null })} />
            {c.tint && <ColorField value={c.tint} onChange={(v) => setC({ tint: v })} />}
          </div>
        </Row>
        <Toggle label="Hide when idle" hint="Fade the cursor out when it hasn't moved for a while" checked={c.hideWhenIdle} onChange={(v) => setC({ hideWhenIdle: v })} />
        {c.hideWhenIdle && <Slider label="Idle delay" value={c.idleAfterMs} min={500} max={8000} step={100} format={(v) => `${(v / 1000).toFixed(1)}s`} onChange={(v) => setC({ idleAfterMs: v }, false)} onCommit={(v) => setC({ idleAfterMs: v })} />}
      </Section>
      <Section title="Click effects">
        <Row label="Effect">
          <Segmented size="sm" value={c.clickEffect} onChange={(v) => setC({ clickEffect: v })} options={[{ value: 'none', label: 'None' }, { value: 'ripple', label: 'Ripple' }, { value: 'pulse', label: 'Pulse' }, { value: 'spotlight', label: 'Spot' }]} />
        </Row>
        <ColorField label="Color" value={c.clickColor} onChange={(v) => setC({ clickColor: v })} />
        <Toggle label="Motion trail" hint="Streak behind fast movements (export only)" checked={c.motionBlur} onChange={(v) => setC({ motionBlur: v })} />
      </Section>
    </div>
  )
}

const POSITIONS: Array<{ v: CameraPosition; label: string }> = [
  { v: 'top-left', label: '↖' },
  { v: 'top-right', label: '↗' },
  { v: 'custom', label: '✥' },
  { v: 'bottom-left', label: '↙' },
  { v: 'bottom-right', label: '↘' }
]

export function CameraPanel(): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const updateRender = useProject((s) => s.updateRender)
  const selection = useProject((s) => s.selection)
  const updateCameraSegment = useProject((s) => s.updateCameraSegment)
  const removeCameraSegment = useProject((s) => s.removeCameraSegment)
  const addCameraSegment = useProject((s) => s.addCameraSegment)
  const setSelection = useProject((s) => s.setSelection)
  const time = usePlayer((s) => s.time)
  const cam = project.render.camera
  const setCam = (patch: Partial<typeof cam>, history = true): void => updateRender({ camera: { ...cam, ...patch } }, { history })
  const hasCamera = !!project.recording.camera
  const selected = selection.kind === 'camera' ? project.timeline.camera.find((x) => x.id === selection.id) : null
  const duration = timelineDuration(project.timeline)

  if (!hasCamera) return <div className="m-4 text-[12px] text-fg-3 bg-white/[0.03] border border-line rounded-lg p-3">No camera was recorded with this project. Enable a camera in the recorder to get a webcam overlay.</div>

  return (
    <div>
      <Section title="Camera overlay" right={<Toggle checked={cam.enabled} onChange={(v) => setCam({ enabled: v })} />}>
        <Row label="Shape">
          <Segmented size="sm" value={cam.shape} onChange={(v) => setCam({ shape: v })} options={[{ value: 'circle', label: 'Circle' }, { value: 'squircle', label: 'Squircle' }, { value: 'rounded', label: 'Rounded' }, { value: 'square', label: 'Square' }]} />
        </Row>
        <Slider label="Size" value={cam.size} min={0.1} max={0.7} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCam({ size: v }, false)} onCommit={(v) => setCam({ size: v })} />
        <Row label="Position">
          <div className="grid grid-cols-5 gap-1">
            {POSITIONS.map((p) => (
              <button key={p.v} className={cn('w-8 h-8 rounded-md text-[13px] border', cam.position === p.v ? 'bg-accent-soft border-accent text-accent-2' : 'border-line hover:bg-white/[0.05]')} onClick={() => setCam({ position: p.v })} title={p.v}>
                {p.label}
              </button>
            ))}
          </div>
        </Row>
        {cam.position === 'custom' && <div className="text-[11.5px] text-fg-3">Drag the camera on the preview to position it.</div>}
        <Slider label="Margin" value={cam.margin} min={0} max={120} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => setCam({ margin: v }, false)} onCommit={(v) => setCam({ margin: v })} />
        <Slider label="Zoom in" value={cam.zoom} min={1} max={2.5} step={0.01} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setCam({ zoom: v }, false)} onCommit={(v) => setCam({ zoom: v })} />
        {cam.shape === 'rounded' && <Slider label="Corner radius" value={cam.radius} min={0} max={120} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => setCam({ radius: v }, false)} onCommit={(v) => setCam({ radius: v })} />}
        <Toggle label="Mirror" checked={cam.mirror} onChange={(v) => setCam({ mirror: v })} />
        <Toggle label="Shadow" checked={cam.shadow} onChange={(v) => setCam({ shadow: v })} />
        <Toggle label="Border" checked={cam.border.enabled} onChange={(v) => setCam({ border: { ...cam.border, enabled: v } })} />
        {cam.border.enabled && (
          <>
            <Slider label="Border width" value={cam.border.width} min={1} max={16} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => setCam({ border: { ...cam.border, width: v } }, false)} onCommit={(v) => setCam({ border: { ...cam.border, width: v } })} />
            <ColorField label="Border color" value={cam.border.color} onChange={(v) => setCam({ border: { ...cam.border, color: v } })} />
          </>
        )}
      </Section>
      <Section title={selected ? 'Selected segment' : 'Timeline segments'}>
        {selected ? (
          <>
            <Row label="Mode">
              <Segmented
                size="sm"
                value={selected.fullscreen ? 'full' : selected.visible ? 'show' : 'hide'}
                onChange={(v) => updateCameraSegment(selected.id, v === 'full' ? { visible: true, fullscreen: true } : v === 'show' ? { visible: true, fullscreen: false } : { visible: false, fullscreen: false })}
                options={[
                  { value: 'hide', label: <><EyeOff size={12} /> Hide</> },
                  { value: 'show', label: <><Eye size={12} /> Show</> },
                  { value: 'full', label: <><Maximize size={12} /> Full</> }
                ]}
              />
            </Row>
            <Row label="Start">
              <NumberField value={Math.round(selected.start)} min={0} max={selected.end - 100} step={100} suffix="ms" width={92} onChange={(v) => updateCameraSegment(selected.id, { start: v })} />
            </Row>
            <Row label="End">
              <NumberField value={Math.round(selected.end)} min={selected.start + 100} max={duration} step={100} suffix="ms" width={92} onChange={(v) => updateCameraSegment(selected.id, { end: v })} />
            </Row>
            <button className="btn btn-danger self-start" onClick={() => removeCameraSegment(selected.id)}>
              <Trash2 size={13} /> Delete segment
            </button>
          </>
        ) : (
          <>
            <div className="text-[11.5px] text-fg-3">Hide the camera or make it fullscreen for parts of the video (great for intros).</div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={() => setSelection({ kind: 'camera', id: addCameraSegment({ start: time, end: Math.min(duration, time + 3000), visible: false }) })}>
                <EyeOff size={13} /> Hide here
              </button>
              <button className="btn flex-1" onClick={() => setSelection({ kind: 'camera', id: addCameraSegment({ start: time, end: Math.min(duration, time + 3000), visible: true, fullscreen: true }) })}>
                <Maximize size={13} /> Fullscreen here
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  )
}

export function KeysPanel(): React.JSX.Element {
  const render = useProject((s) => s.project!.render)
  const events = useProject((s) => s.events)
  const updateRender = useProject((s) => s.updateRender)
  const k = render.keystrokes
  const setK = (patch: Partial<typeof k>, history = true): void => updateRender({ keystrokes: { ...k, ...patch } }, { history })
  const count = events?.keys.length ?? 0
  return (
    <div>
      <Section title="Keystroke overlay" right={<Toggle checked={k.enabled} onChange={(v) => setK({ enabled: v })} />}>
        <div className="text-[11.5px] text-fg-3">{events ? `${count} key events recorded. ` : 'No keyboard data in this project. '}Shortcuts you press appear as pills on the video.</div>
        <Toggle label="Shortcuts & special keys only" hint="Hide plain typing to protect what you write" checked={k.showModifiersOnly} onChange={(v) => setK({ showModifiersOnly: v })} />
        <Row label="Style">
          <Segmented size="sm" value={k.style} onChange={(v) => setK({ style: v })} options={[{ value: 'pill', label: 'Pill' }, { value: 'keycaps', label: 'Keycaps' }]} />
        </Row>
        <Row label="Position">
          <Segmented size="sm" value={k.position} onChange={(v) => setK({ position: v })} options={[{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }, { value: 'bottom-left', label: 'B-L' }, { value: 'bottom-right', label: 'B-R' }]} />
        </Row>
        <Slider label="Size" value={k.size} min={0.6} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => setK({ size: v }, false)} onCommit={(v) => setK({ size: v })} />
        <Slider label="Show for" value={k.durationMs} min={500} max={4000} step={50} format={(v) => `${(v / 1000).toFixed(1)}s`} onChange={(v) => setK({ durationMs: v }, false)} onCommit={(v) => setK({ durationMs: v })} />
      </Section>
    </div>
  )
}
