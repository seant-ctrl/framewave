import React, { useState } from 'react'
import { Film, Image as ImageIcon, Trash2, Copy, ArrowLeft, ArrowRight, FilePlus, Scissors, Sparkles } from 'lucide-react'
import { useProject } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { useApp } from '@/store/appStore'
import { Slider, Toggle, Segmented, Section, Row, Select, NumberField } from '../../ui/ui'
import { placeClips, updateClip, moveClip, duplicateClip, removeClip, assetFor, splitAt, clipDuration } from '@/engine/timeline'
import { formatTime, cn } from '@/lib/utils'
import type { TransitionType, Clip } from '@shared/types'
import { addMediaToProject } from '../mediaImport'

export const TRANSITIONS: Array<{ value: TransitionType; label: string }> = [
  { value: 'cut', label: 'Cut (none)' },
  { value: 'fade', label: 'Cross fade' },
  { value: 'dip-black', label: 'Dip to black' },
  { value: 'dip-white', label: 'Dip to white' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'blur', label: 'Blur' }
]

export function ClipPanel(): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const selection = useProject((s) => s.selection)
  const setSelection = useProject((s) => s.setSelection)
  const updateTimeline = useProject((s) => s.updateTimeline)
  const time = usePlayer((s) => s.time)
  const setTime = usePlayer((s) => s.setTime)
  const toast = useApp((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const places = placeClips(project.timeline)
  const sel = selection.kind === 'clip' ? places.find((p) => p.clip.id === selection.id) : null

  const addMedia = async (): Promise<void> => {
    setBusy(true)
    try {
      const n = await addMediaToProject(project.id, undefined, sel ? sel.index + 1 : undefined)
      if (n > 0) toast({ kind: 'success', title: `Added ${n} clip${n > 1 ? 's' : ''}` })
    } catch (e) {
      toast({ kind: 'error', title: 'Import failed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const applyAllTransitions = (t: TransitionType, ms: number): void => {
    updateTimeline((tl) => ({ ...tl, clips: tl.clips.map((c, i) => (i === 0 ? c : { ...c, transitionIn: t === 'cut' ? undefined : { type: t, durationMs: ms } })) }))
  }

  return (
    <div>
      <Section title="Media">
        <div className="text-[11.5px] text-fg-3">Add videos or images as clips. Drag clips on the timeline to reorder them; drop files anywhere in the editor to import.</div>
        <button className="btn btn-primary self-start" disabled={busy} onClick={() => void addMedia()}>
          <FilePlus size={13} /> Add media…
        </button>
        <div className="flex flex-col gap-1 max-h-[220px] overflow-y-auto -mx-1 px-1">
          {places.map((p, i) => {
            const a = assetFor(project, p.clip.sourceId)
            const active = sel?.clip.id === p.clip.id
            return (
              <button
                key={p.clip.id}
                className={cn('flex items-center gap-2 px-2 h-8 rounded-md text-[12px] text-left hover:bg-white/[0.05]', active && 'bg-accent-soft')}
                onClick={() => {
                  setSelection({ kind: 'clip', id: p.clip.id })
                  setTime(p.start + Math.min(300, (p.end - p.start) / 2))
                }}
              >
                <span className="w-5 h-5 rounded grid place-items-center text-[10px] bg-white/[0.06] text-fg-2 shrink-0">{i + 1}</span>
                {a?.kind === 'image' ? <ImageIcon size={12} className="text-fg-3 shrink-0" /> : <Film size={12} className="text-fg-3 shrink-0" />}
                <span className="truncate flex-1">{a?.name ?? (p.clip.sourceId ? 'Media' : 'Recording')}</span>
                <span className="font-mono text-[10.5px] text-fg-3">{formatTime(clipDuration(p.clip)).replace(/\.\d\d$/, '')}</span>
              </button>
            )
          })}
        </div>
      </Section>

      {sel ? (
        <SelectedClip clip={sel.clip} index={sel.index} count={places.length} start={sel.start} end={sel.end} />
      ) : (
        <Section title="Transitions for all clips">
          <div className="text-[11.5px] text-fg-3">Apply the same transition between every clip.</div>
          <div className="grid grid-cols-2 gap-2">
            {(['fade', 'dip-black', 'slide-left', 'zoom', 'wipe', 'cut'] as TransitionType[]).map((t) => (
              <button key={t} className="btn btn-sm" onClick={() => applyAllTransitions(t, 500)}>
                <Sparkles size={12} /> {TRANSITIONS.find((x) => x.value === t)?.label}
              </button>
            ))}
          </div>
          <div className="text-[11.5px] text-fg-3 mt-1">Select a clip on the timeline to edit its speed, volume, framing and transition. Press <kbd>S</kbd> to split at the playhead ({formatTime(time).replace(/\.\d\d$/, '')}).</div>
        </Section>
      )}
    </div>
  )
}

function SelectedClip({ clip, index, count, start, end }: { clip: Clip; index: number; count: number; start: number; end: number }): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const updateTimeline = useProject((s) => s.updateTimeline)
  const setSelection = useProject((s) => s.setSelection)
  const time = usePlayer((s) => s.time)
  const asset = assetFor(project, clip.sourceId)
  const isImage = asset?.kind === 'image'
  const set = (patch: Partial<Clip>, history = true): void => updateTimeline((tl) => updateClip(tl, clip.id, patch), { history })
  const tr = clip.transitionIn
  const srcDur = asset?.durationMs ?? clip.sourceEnd

  return (
    <>
      <Section title={`Clip ${index + 1}`} right={<span className="text-[11px] text-fg-3 truncate max-w-[150px]">{asset?.name}</span>}>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn btn-sm" disabled={index === 0} onClick={() => updateTimeline((tl) => moveClip(tl, clip.id, index - 1))}>
            <ArrowLeft size={12} /> Move left
          </button>
          <button className="btn btn-sm" disabled={index >= count - 1} onClick={() => updateTimeline((tl) => moveClip(tl, clip.id, index + 1))}>
            Move right <ArrowRight size={12} />
          </button>
          <button className="btn btn-sm" onClick={() => updateTimeline((tl) => duplicateClip(tl, clip.id))}>
            <Copy size={12} /> Duplicate
          </button>
          <button className="btn btn-sm" disabled={time <= start + 50 || time >= end - 50} onClick={() => updateTimeline((tl) => splitAt(tl, time))}>
            <Scissors size={12} /> Split here
          </button>
        </div>
        {isImage ? (
          <Row label="Duration">
            <NumberField value={Math.round(clip.sourceEnd - clip.sourceStart)} min={200} max={600000} step={500} suffix="ms" width={96} onChange={(v) => set({ sourceStart: 0, sourceEnd: v })} />
          </Row>
        ) : (
          <>
            <Row label="Speed">
              <Segmented size="sm" value={String(clip.speed)} onChange={(v) => set({ speed: Number(v) })} options={[{ value: '0.5', label: '0.5×' }, { value: '1', label: '1×' }, { value: '1.5', label: '1.5×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
            </Row>
            <div className="grid grid-cols-2 gap-3">
              <Row label="In">
                <NumberField value={Math.round(clip.sourceStart)} min={0} max={clip.sourceEnd - 100} step={100} suffix="ms" width={92} onChange={(v) => set({ sourceStart: v })} />
              </Row>
              <Row label="Out">
                <NumberField value={Math.round(clip.sourceEnd)} min={clip.sourceStart + 100} max={Math.max(clip.sourceStart + 100, srcDur)} step={100} suffix="ms" width={92} onChange={(v) => set({ sourceEnd: v })} />
              </Row>
            </div>
          </>
        )}
        <Row label="Framing">
          <Segmented size="sm" value={clip.fit ?? (clip.sourceId ? 'cover' : 'contain')} onChange={(v) => set({ fit: v })} options={[{ value: 'cover', label: 'Fill' }, { value: 'contain', label: 'Fit' }]} />
        </Row>
        {asset?.hasAudio && (
          <>
            <Slider label="Clip volume" value={clip.volume ?? 1} min={0} max={2} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ volume: v }, false)} onCommit={(v) => set({ volume: v })} />
            <Toggle label="Mute clip audio" checked={!!clip.muted} onChange={(v) => set({ muted: v })} />
          </>
        )}
      </Section>

      <Section title="Transition in" defaultOpen>
        {index === 0 ? (
          <div className="text-[11.5px] text-fg-3">The first clip has no incoming transition. Use a text or a fade from black via the Audio/Look panels.</div>
        ) : (
          <>
            <Select label="Type" value={tr?.type ?? 'cut'} onChange={(v) => set({ transitionIn: v === 'cut' ? undefined : { type: v, durationMs: tr?.durationMs ?? 500 } })} options={TRANSITIONS} />
            {tr && <Slider label="Duration" value={tr.durationMs} min={100} max={3000} step={50} format={(v) => `${(v / 1000).toFixed(2)}s`} onChange={(v) => set({ transitionIn: { ...tr, durationMs: v } }, false)} onCommit={(v) => set({ transitionIn: { ...tr, durationMs: v } })} />}
            <button className="btn btn-sm self-start" onClick={() => usePlayer.getState().setTime(Math.max(0, start - 200))}>
              Preview transition
            </button>
          </>
        )}
      </Section>

      <Section title="Danger zone" defaultOpen={false}>
        <button
          className="btn btn-danger self-start"
          disabled={count <= 1}
          onClick={() => {
            updateTimeline((tl) => removeClip(tl, clip.id))
            setSelection({ kind: 'none' })
          }}
        >
          <Trash2 size={13} /> Remove clip from timeline
        </button>
      </Section>
    </>
  )
}
