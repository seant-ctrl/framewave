import React, { useState } from 'react'
import { Plus, Trash2, ImagePlus, RotateCcw, Check } from 'lucide-react'
import { useProject } from '@/store/projectStore'
import { Slider, Toggle, Segmented, ColorField, Section, Row, Select } from '../../ui/ui'
import { WALLPAPERS, type BackgroundSettings, type GradientStop } from '@shared/types'
import { backgroundCss } from '@/engine/background'
import { fw } from '@/lib/fw'
import { cn } from '@/lib/utils'

const GRADIENT_PRESETS: Array<{ angle: number; stops: GradientStop[] }> = [
  { angle: 135, stops: [{ color: '#4f46e5', pos: 0 }, { color: '#c026d3', pos: 0.55 }, { color: '#f97316', pos: 1 }] },
  { angle: 135, stops: [{ color: '#0ea5e9', pos: 0 }, { color: '#6366f1', pos: 1 }] },
  { angle: 160, stops: [{ color: '#f43f5e', pos: 0 }, { color: '#f59e0b', pos: 1 }] },
  { angle: 135, stops: [{ color: '#10b981', pos: 0 }, { color: '#3b82f6', pos: 1 }] },
  { angle: 180, stops: [{ color: '#1e1b4b', pos: 0 }, { color: '#0f172a', pos: 1 }] },
  { angle: 135, stops: [{ color: '#fbcfe8', pos: 0 }, { color: '#c4b5fd', pos: 0.5 }, { color: '#bae6fd', pos: 1 }] },
  { angle: 135, stops: [{ color: '#111827', pos: 0 }, { color: '#4b5563', pos: 1 }] },
  { angle: 135, stops: [{ color: '#f8fafc', pos: 0 }, { color: '#e2e8f0', pos: 1 }] }
]

export function BackgroundPanel(): React.JSX.Element {
  const bg = useProject((s) => s.project!.render.background)
  const project = useProject((s) => s.project!)
  const updateRender = useProject((s) => s.updateRender)
  const set = (b: BackgroundSettings, history = true): void => updateRender({ background: b }, { history })
  const type = bg.type

  return (
    <div>
      <Section title="Type">
        <Segmented
          value={type}
          onChange={(t) => {
            switch (t) {
              case 'wallpaper':
                set({ type: 'wallpaper', id: 'aurora' })
                break
              case 'gradient':
                set({ type: 'gradient', ...GRADIENT_PRESETS[0] })
                break
              case 'color':
                set({ type: 'color', color: '#0f1117' })
                break
              case 'image':
                set({ type: 'image', src: '', blur: 0, dim: 0.1 })
                break
              case 'blur':
                set({ type: 'blur', blur: 40, dim: 0.25, saturate: 1.4 })
                break
              case 'transparent':
                set({ type: 'transparent' })
                break
            }
          }}
          options={[
            { value: 'wallpaper', label: 'Wall' },
            { value: 'gradient', label: 'Grad' },
            { value: 'color', label: 'Color' },
            { value: 'image', label: 'Image' },
            { value: 'blur', label: 'Blur' },
            { value: 'transparent', label: 'None' }
          ]}
        />
        {type === 'wallpaper' && (
          <div className="grid grid-cols-4 gap-2">
            {WALLPAPERS.map((w) => (
              <button key={w.id} onClick={() => set({ type: 'wallpaper', id: w.id })} className={cn('aspect-[4/3] rounded-lg relative overflow-hidden ring-1 ring-white/10 hover:ring-white/30', bg.type === 'wallpaper' && bg.id === w.id && '!ring-2 !ring-accent')} style={{ background: w.css }} title={w.name}>
                {bg.type === 'wallpaper' && bg.id === w.id && (
                  <span className="absolute inset-0 grid place-items-center">
                    <Check size={14} className="drop-shadow" />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {type === 'gradient' && bg.type === 'gradient' && (
          <>
            <div className="grid grid-cols-4 gap-2">
              {GRADIENT_PRESETS.map((g, i) => (
                <button key={i} onClick={() => set({ type: 'gradient', ...g })} className="aspect-[4/3] rounded-lg ring-1 ring-white/10 hover:ring-white/30" style={{ background: backgroundCss({ type: 'gradient', ...g }) }} />
              ))}
            </div>
            <Slider label="Angle" value={bg.angle} min={0} max={360} step={1} format={(v) => `${Math.round(v)}°`} onChange={(v) => set({ ...bg, angle: v }, false)} onCommit={(v) => set({ ...bg, angle: v })} />
            <div className="flex flex-col gap-2">
              {bg.stops.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <ColorField compact value={s.color} onChange={(c) => set({ ...bg, stops: bg.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })} />
                  <input type="range" className="slider flex-1" min={0} max={1} step={0.01} value={s.pos} style={{ ['--pct' as string]: `${s.pos * 100}%` }} onChange={(e) => set({ ...bg, stops: bg.stops.map((x, j) => (j === i ? { ...x, pos: parseFloat(e.target.value) } : x)) }, false)} />
                  <button className="text-fg-3 hover:text-danger disabled:opacity-30" disabled={bg.stops.length <= 2} onClick={() => set({ ...bg, stops: bg.stops.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {bg.stops.length < 5 && (
                <button className="btn btn-sm self-start" onClick={() => set({ ...bg, stops: [...bg.stops, { color: '#ffffff', pos: 1 }].sort((a, b) => a.pos - b.pos) })}>
                  <Plus size={12} /> Add stop
                </button>
              )}
            </div>
          </>
        )}
        {type === 'color' && bg.type === 'color' && (
          <>
            <ColorField label="Color" value={bg.color} onChange={(c) => set({ type: 'color', color: c })} />
            <div className="grid grid-cols-8 gap-1.5">
              {['#000000', '#0f1117', '#1e293b', '#312e81', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#f59e0b', '#16a34a', '#0891b2', '#2563eb', '#e5e7eb', '#ffffff', '#fef3c7', '#fce7f3'].map((c) => (
                <button key={c} className={cn('aspect-square rounded-md ring-1 ring-white/10', bg.color === c && '!ring-2 !ring-accent')} style={{ background: c }} onClick={() => set({ type: 'color', color: c })} />
              ))}
            </div>
          </>
        )}
        {type === 'image' && bg.type === 'image' && (
          <>
            <div className="aspect-video rounded-lg ring-1 ring-white/10 overflow-hidden grid place-items-center bg-bg" style={bg.src ? { background: `url(${JSON.stringify(bg.src)}) center/cover` } : undefined}>
              {!bg.src && (
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await fw.projects.importAsset(project.id, 'image')
                    if (r) set({ ...bg, src: fw.mediaUrl(r.path) })
                  }}
                >
                  <ImagePlus size={14} /> Choose image…
                </button>
              )}
            </div>
            {bg.src && (
              <button
                className="btn btn-sm self-start"
                onClick={async () => {
                  const r = await fw.projects.importAsset(project.id, 'image')
                  if (r) set({ ...bg, src: fw.mediaUrl(r.path) })
                }}
              >
                <ImagePlus size={12} /> Replace image
              </button>
            )}
            <Slider label="Blur" value={bg.blur} min={0} max={80} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => set({ ...bg, blur: v }, false)} onCommit={(v) => set({ ...bg, blur: v })} />
            <Slider label="Darken" value={bg.dim} min={0} max={0.9} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ ...bg, dim: v }, false)} onCommit={(v) => set({ ...bg, dim: v })} />
          </>
        )}
        {type === 'blur' && bg.type === 'blur' && (
          <>
            <div className="text-[11.5px] text-fg-3">A blurred, enlarged copy of your screen fills the background — like a smart TV.</div>
            <Slider label="Blur" value={bg.blur} min={4} max={120} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => set({ ...bg, blur: v }, false)} onCommit={(v) => set({ ...bg, blur: v })} />
            <Slider label="Darken" value={bg.dim} min={0} max={0.9} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ ...bg, dim: v }, false)} onCommit={(v) => set({ ...bg, dim: v })} />
            <Slider label="Saturation" value={bg.saturate} min={0} max={3} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => set({ ...bg, saturate: v }, false)} onCommit={(v) => set({ ...bg, saturate: v })} />
          </>
        )}
        {type === 'transparent' && <div className="text-[11.5px] text-fg-3">Transparent background. Export as WebM to keep the alpha channel; MP4 will show black.</div>}
      </Section>
      <FrameQuick />
    </div>
  )
}

function FrameQuick(): React.JSX.Element {
  const render = useProject((s) => s.project!.render)
  const updateRender = useProject((s) => s.updateRender)
  return (
    <Section title="Layout">
      <Slider label="Padding" value={render.padding} min={0} max={0.3} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateRender({ padding: v }, { history: false })} onCommit={(v) => updateRender({ padding: v })} />
      <Slider label="Corner radius" value={render.cornerRadius} min={0} max={80} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => updateRender({ cornerRadius: v }, { history: false })} onCommit={(v) => updateRender({ cornerRadius: v })} />
      <Slider label="Shadow" value={render.shadow.enabled ? render.shadow.opacity : 0} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateRender({ shadow: { ...render.shadow, enabled: v > 0, opacity: v } }, { history: false })} onCommit={(v) => updateRender({ shadow: { ...render.shadow, enabled: v > 0, opacity: v } })} />
    </Section>
  )
}

export function FramePanel(): React.JSX.Element {
  const render = useProject((s) => s.project!.render)
  const rec = useProject((s) => s.project!.recording)
  const updateRender = useProject((s) => s.updateRender)
  const crop = render.crop ?? { x: 0, y: 0, width: 1, height: 1 }
  const setCrop = (c: typeof crop, history = true): void => updateRender({ crop: c.x === 0 && c.y === 0 && c.width === 1 && c.height === 1 ? null : c }, { history })
  const [aspectLock, setAspectLock] = useState<string>('free')

  const applyAspectCrop = (ratio: number | null): void => {
    if (ratio == null) return setCrop({ x: 0, y: 0, width: 1, height: 1 })
    const srcAspect = rec.width / rec.height
    let w = 1
    let h = 1
    if (ratio > srcAspect) h = srcAspect / ratio
    else w = ratio / srcAspect
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h })
  }

  return (
    <div>
      <Section title="Output">
        <Select
          label="Resolution"
          value={String(render.outputHeight) as '720' | '1080' | '1440' | '2160'}
          onChange={(v) => updateRender({ outputHeight: Number(v) as 720 | 1080 | 1440 | 2160 })}
          options={[
            { value: '720', label: '720p' },
            { value: '1080', label: '1080p (Full HD)' },
            { value: '1440', label: '1440p (2K)' },
            { value: '2160', label: '2160p (4K)' }
          ]}
        />
        <Select
          label="Aspect ratio"
          value={render.aspect}
          onChange={(v) => updateRender({ aspect: v })}
          options={[
            { value: 'source', label: 'Auto (match recording)' },
            { value: '16:9', label: '16:9 · YouTube' },
            { value: '9:16', label: '9:16 · Shorts / Reels' },
            { value: '1:1', label: '1:1 · Square' },
            { value: '4:5', label: '4:5 · Instagram' },
            { value: '4:3', label: '4:3' },
            { value: '3:4', label: '3:4' },
            { value: '21:9', label: '21:9 · Ultrawide' }
          ]}
        />
      </Section>
      <Section title="Padding & corners">
        <Slider label="Padding" value={render.padding} min={0} max={0.3} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateRender({ padding: v }, { history: false })} onCommit={(v) => updateRender({ padding: v })} />
        <Slider label="Corner radius" value={render.cornerRadius} min={0} max={80} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => updateRender({ cornerRadius: v }, { history: false })} onCommit={(v) => updateRender({ cornerRadius: v })} />
      </Section>
      <Section title="Shadow" right={<Toggle checked={render.shadow.enabled} onChange={(v) => updateRender({ shadow: { ...render.shadow, enabled: v } })} />}>
        <Slider label="Opacity" value={render.shadow.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateRender({ shadow: { ...render.shadow, opacity: v } }, { history: false })} onCommit={(v) => updateRender({ shadow: { ...render.shadow, opacity: v } })} />
        <Slider label="Blur" value={render.shadow.blur} min={0} max={200} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => updateRender({ shadow: { ...render.shadow, blur: v } }, { history: false })} onCommit={(v) => updateRender({ shadow: { ...render.shadow, blur: v } })} />
        <Slider label="Offset" value={render.shadow.offsetY} min={-60} max={120} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => updateRender({ shadow: { ...render.shadow, offsetY: v } }, { history: false })} onCommit={(v) => updateRender({ shadow: { ...render.shadow, offsetY: v } })} />
      </Section>
      <Section title="Border" defaultOpen={false} right={<Toggle checked={render.border.enabled} onChange={(v) => updateRender({ border: { ...render.border, enabled: v } })} />}>
        <Slider label="Width" value={render.border.width} min={1} max={16} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => updateRender({ border: { ...render.border, width: v } }, { history: false })} onCommit={(v) => updateRender({ border: { ...render.border, width: v } })} />
        <Slider label="Opacity" value={render.border.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => updateRender({ border: { ...render.border, opacity: v } }, { history: false })} onCommit={(v) => updateRender({ border: { ...render.border, opacity: v } })} />
        <ColorField label="Color" value={render.border.color} onChange={(c) => updateRender({ border: { ...render.border, color: c } })} />
      </Section>
      <Section title="Crop" right={render.crop && <button className="btn btn-sm btn-ghost" onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}><RotateCcw size={12} /> Reset</button>}>
        <div className="text-[11.5px] text-fg-3">Crop the recording to focus on part of the screen. Cursor & zoom automatically follow the crop.</div>
        <Row label="Preset">
          <Segmented
            size="sm"
            value={aspectLock}
            onChange={(v) => {
              setAspectLock(v)
              applyAspectCrop(v === 'free' ? null : v === '16:9' ? 16 / 9 : v === '9:16' ? 9 / 16 : v === '1:1' ? 1 : 4 / 3)
            }}
            options={[
              { value: 'free', label: 'Full' },
              { value: '16:9', label: '16:9' },
              { value: '9:16', label: '9:16' },
              { value: '1:1', label: '1:1' },
              { value: '4:3', label: '4:3' }
            ]}
          />
        </Row>
        <Slider label="Left" value={crop.x} min={0} max={0.9} format={(v) => `${Math.round(v * rec.width)}px`} onChange={(v) => setCrop({ ...crop, x: v, width: Math.min(crop.width, 1 - v) }, false)} onCommit={(v) => setCrop({ ...crop, x: v, width: Math.min(crop.width, 1 - v) })} />
        <Slider label="Top" value={crop.y} min={0} max={0.9} format={(v) => `${Math.round(v * rec.height)}px`} onChange={(v) => setCrop({ ...crop, y: v, height: Math.min(crop.height, 1 - v) }, false)} onCommit={(v) => setCrop({ ...crop, y: v, height: Math.min(crop.height, 1 - v) })} />
        <Slider label="Width" value={crop.width} min={0.1} max={1 - crop.x} format={(v) => `${Math.round(v * rec.width)}px`} onChange={(v) => setCrop({ ...crop, width: v }, false)} onCommit={(v) => setCrop({ ...crop, width: v })} />
        <Slider label="Height" value={crop.height} min={0.1} max={1 - crop.y} format={(v) => `${Math.round(v * rec.height)}px`} onChange={(v) => setCrop({ ...crop, height: v }, false)} onCommit={(v) => setCrop({ ...crop, height: v })} />
      </Section>
    </div>
  )
}

export function ColorPanel(): React.JSX.Element {
  const render = useProject((s) => s.project!.render)
  const updateRender = useProject((s) => s.updateRender)
  const c = render.color
  const setC = (patch: Partial<typeof c>, history = true): void => updateRender({ color: { ...c, ...patch } }, { history })
  return (
    <div>
      <Section title="Color grading" right={<button className="btn btn-sm btn-ghost" onClick={() => updateRender({ color: { brightness: 0, contrast: 0, saturation: 0, vignette: 0 } })}><RotateCcw size={12} /> Reset</button>}>
        <Slider label="Brightness" value={c.brightness} min={-0.5} max={0.5} format={(v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => setC({ brightness: v }, false)} onCommit={(v) => setC({ brightness: v })} />
        <Slider label="Contrast" value={c.contrast} min={-0.5} max={0.5} format={(v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => setC({ contrast: v }, false)} onCommit={(v) => setC({ contrast: v })} />
        <Slider label="Saturation" value={c.saturation} min={-1} max={1} format={(v) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}`} onChange={(v) => setC({ saturation: v }, false)} onCommit={(v) => setC({ saturation: v })} />
        <Slider label="Vignette" value={c.vignette} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setC({ vignette: v }, false)} onCommit={(v) => setC({ vignette: v })} />
      </Section>
      <Section title="Motion">
        <Toggle label="Cursor motion trail" hint="Subtle streak behind fast cursor moves (export only)" checked={render.cursor.motionBlur} onChange={(v) => updateRender({ cursor: { ...render.cursor, motionBlur: v } })} />
      </Section>
    </div>
  )
}
