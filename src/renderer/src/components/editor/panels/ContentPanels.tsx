import React, { useRef, useState } from 'react'
import { Music, Plus, Trash2, Sparkles, Upload, Download, Scissors, Mic, Speaker, Type as TypeIcon } from 'lucide-react'
import { useProject } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { useApp } from '@/store/appStore'
import { Slider, Toggle, Segmented, ColorField, Section, Row, Select, NumberField, Progress } from '../../ui/ui'
import { fw, projectMediaUrl } from '@/lib/fw'
import { formatTime, cn, downloadTextFile } from '@/lib/utils'
import { timelineDuration, deleteRange, sourceToTimeline } from '@/engine/timeline'
import { detectSilence, computePeaks } from '@/engine/audio'
import { transcribeProject, type WhisperModel, type TranscribeProgress } from '@/engine/transcribe'
import { parseSrt, toSrt, toVtt } from '@/lib/srt'
import type { AudioTrackSettings, TextOverlay } from '@shared/types'

// ── Audio ───────────────────────────────────────────────────────────────────

function TrackControls({ label, icon, settings, onChange }: { label: string; icon: React.ReactNode; settings: AudioTrackSettings; onChange: (s: AudioTrackSettings, history?: boolean) => void }): React.JSX.Element {
  return (
    <Section title={label} right={<Toggle checked={!settings.muted} onChange={(v) => onChange({ ...settings, muted: !v })} />}>
      <div className={cn('flex flex-col gap-3', settings.muted && 'opacity-50')}>
        <Slider label="Volume" value={settings.volume} min={0} max={2} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ ...settings, volume: v }, false)} onCommit={(v) => onChange({ ...settings, volume: v })} />
        <Toggle label="Noise gate" hint="Silence the track between phrases (export)" checked={settings.gate != null} onChange={(v) => onChange({ ...settings, gate: v ? -45 : null })} />
        {settings.gate != null && <Slider label="Threshold" value={settings.gate} min={-70} max={-20} step={1} format={(v) => `${Math.round(v)} dB`} onChange={(v) => onChange({ ...settings, gate: v }, false)} onCommit={(v) => onChange({ ...settings, gate: v })} />}
        <div className="grid grid-cols-2 gap-3">
          <Slider label="Fade in" value={settings.fadeIn} min={0} max={5000} step={50} format={(v) => `${(v / 1000).toFixed(1)}s`} onChange={(v) => onChange({ ...settings, fadeIn: v }, false)} onCommit={(v) => onChange({ ...settings, fadeIn: v })} />
          <Slider label="Fade out" value={settings.fadeOut} min={0} max={5000} step={50} format={(v) => `${(v / 1000).toFixed(1)}s`} onChange={(v) => onChange({ ...settings, fadeOut: v }, false)} onCommit={(v) => onChange({ ...settings, fadeOut: v })} />
        </div>
      </div>
      <span className="hidden">{icon}</span>
    </Section>
  )
}

export function AudioPanel(): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const mutate = useProject((s) => s.mutate)
  const updateTimeline = useProject((s) => s.updateTimeline)
  const toast = useApp((s) => s.toast)
  const updateToast = useApp((s) => s.updateToast)
  const a = project.timeline.audio
  const rec = project.recording
  const [busy, setBusy] = useState(false)
  const setTrack = (name: 'mic' | 'system' | 'camera', s: AudioTrackSettings, history = true): void => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, [name]: s }), { history })

  const removeSilences = async (): Promise<void> => {
    const file = rec.mic ?? rec.system ?? (rec.screen?.hasAudio ? rec.screen : null)
    if (!file) return void toast({ kind: 'info', title: 'No audio track to analyse' })
    setBusy(true)
    const id = toast({ kind: 'progress', title: 'Detecting silences…', progress: 0.2 })
    try {
      const ranges = await detectSilence(projectMediaUrl(project.dir, file.file), -42, 700)
      const offset = file.offsetMs ?? 0
      // map source → timeline, delete from the end so earlier times stay valid
      const tlRanges = ranges
        .map((r) => {
          const s = sourceToTimeline(project.timeline, r.start + offset)
          const e = sourceToTimeline(project.timeline, r.end + offset)
          return s != null && e != null && e - s > 300 ? { start: s, end: e } : null
        })
        .filter((x): x is { start: number; end: number } => !!x)
        .sort((x, y) => y.start - x.start)
      if (tlRanges.length === 0) {
        updateToast(id, { kind: 'info', title: 'No silences long enough to remove' })
        return
      }
      let tl = project.timeline
      let removed = 0
      for (const r of tlRanges) {
        tl = deleteRange(tl, r.start, r.end)
        removed += r.end - r.start
      }
      updateTimeline(() => tl)
      updateToast(id, { kind: 'success', title: `Removed ${tlRanges.length} silent parts`, message: `${(removed / 1000).toFixed(1)}s shorter. Undo with Ctrl+Z.` })
    } catch (e) {
      updateToast(id, { kind: 'error', title: 'Silence detection failed', message: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const addMusic = async (): Promise<void> => {
    const r = await fw.projects.importAsset(project.id, 'audio')
    if (!r) return
    const info = await fw.ffmpeg.probe(r.path).catch(() => null)
    mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: { file: r.file, volume: 0.25, muted: false, offset: 0, loop: true, durationMs: info?.durationMs } }))
    const peaks = await computePeaks(fw.mediaUrl(r.path), 3000)
    if (peaks) mutate((p) => (p.peaks = { ...(p.peaks ?? {}), music: peaks }), { history: false })
  }

  return (
    <div>
      {rec.mic && <TrackControls label="Microphone" icon={<Mic size={13} />} settings={a.mic} onChange={(s, h) => setTrack('mic', s, h)} />}
      {(rec.system || rec.screen?.hasAudio) && <TrackControls label="System audio" icon={<Speaker size={13} />} settings={a.system} onChange={(s, h) => setTrack('system', s, h)} />}
      {!rec.mic && !rec.system && !rec.screen?.hasAudio && <div className="m-4 text-[12px] text-fg-3 bg-white/[0.03] border border-line rounded-lg p-3">This recording has no audio tracks. You can still add background music below.</div>}

      <Section title="Background music" right={a.music ? <Toggle checked={!a.music.muted} onChange={(v) => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: p.timeline.audio.music ? { ...p.timeline.audio.music, muted: !v } : null }))} /> : undefined}>
        {a.music ? (
          <>
            <div className="text-[12px] flex items-center gap-2 text-fg-2">
              <Music size={13} /> <span className="truncate">{a.music.file.replace(/^\d+-/, '')}</span>
            </div>
            <Slider label="Volume" value={a.music.volume} min={0} max={1.5} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: { ...p.timeline.audio.music!, volume: v } }), { history: false })} onCommit={(v) => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: { ...p.timeline.audio.music!, volume: v } }))} />
            <Row label="Start at">
              <NumberField value={Math.round(a.music.offset)} min={0} max={timelineDuration(project.timeline)} step={500} suffix="ms" width={96} onChange={(v) => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: { ...p.timeline.audio.music!, offset: v } }))} />
            </Row>
            <Toggle label="Loop" checked={a.music.loop} onChange={(v) => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: { ...p.timeline.audio.music!, loop: v } }))} />
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={() => void addMusic()}>
                <Upload size={13} /> Replace
              </button>
              <button className="btn btn-danger" onClick={() => mutate((p) => (p.timeline.audio = { ...p.timeline.audio, music: null }))}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
          </>
        ) : (
          <button className="btn self-start" onClick={() => void addMusic()}>
            <Plus size={13} /> Add music track…
          </button>
        )}
      </Section>

      <Section title="Smart tools">
        <div className="text-[11.5px] text-fg-3">Automatically cut out pauses and silent parts of your recording.</div>
        <button className="btn btn-primary self-start" disabled={busy} onClick={() => void removeSilences()}>
          <Scissors size={13} /> Remove silences
        </button>
      </Section>
    </div>
  )
}

// ── Text overlays ───────────────────────────────────────────────────────────

const FONTS = ['Inter, system-ui, sans-serif', 'Segoe UI, sans-serif', 'Georgia, serif', 'Cascadia Code, Consolas, monospace', 'Impact, sans-serif', 'Comic Sans MS, cursive', 'Trebuchet MS, sans-serif', 'Arial Black, sans-serif']

export function TextPanel(): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const selection = useProject((s) => s.selection)
  const setSelection = useProject((s) => s.setSelection)
  const addText = useProject((s) => s.addText)
  const updateText = useProject((s) => s.updateText)
  const removeText = useProject((s) => s.removeText)
  const time = usePlayer((s) => s.time)
  const duration = timelineDuration(project.timeline)
  const selected = selection.kind === 'text' ? project.timeline.texts.find((t) => t.id === selection.id) : null
  const set = (patch: Partial<TextOverlay>, history = true): void => {
    if (selected) updateText(selected.id, patch, history)
  }

  const add = (preset?: Partial<TextOverlay>): void => {
    const id = addText({ start: time, end: Math.min(duration, time + 3000), ...preset })
    setSelection({ kind: 'text', id })
  }

  return (
    <div>
      <Section title="Add text">
        <div className="grid grid-cols-2 gap-2">
          <button className="btn" onClick={() => add()}>
            <Plus size={13} /> Title
          </button>
          <button className="btn" onClick={() => add({ text: 'Subtitle text', fontSize: 34, fontWeight: 500, position: { x: 0.5, y: 0.88 }, background: 'rgba(0,0,0,0.6)', animation: 'fade' })}>
            <Plus size={13} /> Lower third
          </button>
          <button className="btn" onClick={() => add({ text: 'Step 1', fontSize: 40, fontWeight: 700, position: { x: 0.06, y: 0.08 }, anchor: 'top-left', background: '#7c5cff', color: '#fff', radius: 999, padding: 14, animation: 'slide-up' })}>
            <Plus size={13} /> Badge
          </button>
          <button className="btn" onClick={() => add({ text: 'Note: this is important', fontSize: 30, fontWeight: 500, position: { x: 0.5, y: 0.12 }, background: '#fef3c7', color: '#1c1917', radius: 10, padding: 14, animation: 'pop' })}>
            <Plus size={13} /> Note
          </button>
        </div>
      </Section>
      {selected ? (
        <>
          <Section title="Content">
            <textarea className="input h-20 py-2 resize-none" value={selected.text} onChange={(e) => set({ text: e.target.value }, false)} onBlur={(e) => set({ text: e.target.value })} />
            <Select label="Animation" value={selected.animation} onChange={(v) => set({ animation: v })} options={[{ value: 'pop', label: 'Pop' }, { value: 'fade', label: 'Fade' }, { value: 'slide-up', label: 'Slide up' }, { value: 'typewriter', label: 'Typewriter' }, { value: 'none', label: 'None' }]} />
            <Row label="Start">
              <NumberField value={Math.round(selected.start)} min={0} max={selected.end - 100} step={100} suffix="ms" width={92} onChange={(v) => set({ start: v })} />
            </Row>
            <Row label="End">
              <NumberField value={Math.round(selected.end)} min={selected.start + 100} max={duration} step={100} suffix="ms" width={92} onChange={(v) => set({ end: v })} />
            </Row>
          </Section>
          <Section title="Style">
            <Select label="Font" value={selected.fontFamily} onChange={(v) => set({ fontFamily: v })} options={FONTS.map((f) => ({ value: f, label: f.split(',')[0] }))} />
            <Slider label="Size" value={selected.fontSize} min={12} max={200} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => set({ fontSize: v }, false)} onCommit={(v) => set({ fontSize: v })} />
            <Row label="Weight">
              <Segmented size="sm" value={String(selected.fontWeight)} onChange={(v) => set({ fontWeight: Number(v) })} options={[{ value: '400', label: 'Regular' }, { value: '600', label: 'Semi' }, { value: '700', label: 'Bold' }, { value: '900', label: 'Black' }]} />
            </Row>
            <Row label="Align">
              <Segmented size="sm" value={selected.align} onChange={(v) => set({ align: v })} options={[{ value: 'left', label: 'L' }, { value: 'center', label: 'C' }, { value: 'right', label: 'R' }]} />
            </Row>
            <ColorField label="Text color" value={selected.color} onChange={(v) => set({ color: v })} />
            <Row label="Background">
              <div className="flex items-center gap-2">
                <Toggle checked={selected.background != null} onChange={(v) => set({ background: v ? 'rgba(0,0,0,0.55)' : null })} />
                {selected.background && <ColorField value={selected.background} onChange={(v) => set({ background: v })} allowAlpha />}
              </div>
            </Row>
            {selected.background && (
              <>
                <Slider label="Padding" value={selected.padding} min={0} max={60} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => set({ padding: v }, false)} onCommit={(v) => set({ padding: v })} />
                <Slider label="Corner radius" value={selected.radius} min={0} max={80} step={1} format={(v) => `${Math.round(v)}px`} onChange={(v) => set({ radius: v }, false)} onCommit={(v) => set({ radius: v })} />
              </>
            )}
            <Toggle label="Shadow" checked={selected.shadow} onChange={(v) => set({ shadow: v })} />
          </Section>
          <Section title="Position">
            <div className="text-[11.5px] text-fg-3">Drag the text directly on the preview, or fine-tune here.</div>
            <Slider label="X" value={selected.position.x} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ position: { ...selected.position, x: v } }, false)} onCommit={(v) => set({ position: { ...selected.position, x: v } })} />
            <Slider label="Y" value={selected.position.y} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set({ position: { ...selected.position, y: v } }, false)} onCommit={(v) => set({ position: { ...selected.position, y: v } })} />
            <Select label="Anchor" value={selected.anchor} onChange={(v) => set({ anchor: v })} options={(['center', 'top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const).map((a) => ({ value: a, label: a }))} />
            <button className="btn btn-danger self-start" onClick={() => removeText(selected.id)}>
              <Trash2 size={13} /> Delete text
            </button>
          </Section>
        </>
      ) : (
        <Section title="Text layers">
          {project.timeline.texts.length === 0 ? (
            <div className="text-[11.5px] text-fg-3">No text yet. Add a title, badge or note above — it appears at the playhead.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {project.timeline.texts.map((t) => (
                <button
                  key={t.id}
                  className="flex items-center gap-2 px-2.5 h-8 rounded-md hover:bg-white/[0.05] text-[12px] text-left"
                  onClick={() => {
                    setSelection({ kind: 'text', id: t.id })
                    usePlayer.getState().setTime(t.start + 400)
                  }}
                >
                  <TypeIcon size={12} className="text-warn shrink-0" />
                  <span className="truncate flex-1">{t.text.split('\n')[0]}</span>
                  <span className="font-mono text-fg-3 text-[10.5px]">{formatTime(t.start)}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  )
}

// ── Captions ────────────────────────────────────────────────────────────────

export function CaptionsPanel(): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const updateRender = useProject((s) => s.updateRender)
  const setCaptions = useProject((s) => s.setCaptions)
  const updateCaption = useProject((s) => s.updateCaption)
  const removeCaption = useProject((s) => s.removeCaption)
  const selection = useProject((s) => s.selection)
  const setSelection = useProject((s) => s.setSelection)
  const toast = useApp((s) => s.toast)
  const cap = project.render.captions
  const setCap = (patch: Partial<typeof cap>, history = true): void => updateRender({ captions: { ...cap, ...patch } }, { history })
  const [model, setModel] = useState<WhisperModel>('base')
  const [language, setLanguage] = useState<string>('auto')
  const [progress, setProgress] = useState<TranscribeProgress | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const hasAudio = !!(project.recording.mic || project.recording.system || project.recording.screen?.hasAudio)

  const generate = async (): Promise<void> => {
    abortRef.current = new AbortController()
    setProgress({ phase: 'audio', progress: 0 })
    try {
      const caps = await transcribeProject(project, model, language === 'auto' ? null : language, setProgress, abortRef.current.signal)
      setCaptions(caps)
      setCap({ enabled: true })
      toast({ kind: 'success', title: `Generated ${caps.length} captions` })
    } catch (e) {
      if ((e as Error).message !== 'cancelled') toast({ kind: 'error', title: 'Transcription failed', message: (e as Error).message })
    } finally {
      setProgress(null)
    }
  }

  const importSrt = async (): Promise<void> => {
    const files = await fw.dialog.open({ filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] })
    if (!files[0]) return
    const text = new TextDecoder().decode(await fw.file.read(files[0]))
    const caps = parseSrt(text)
    setCaptions(caps)
    setCap({ enabled: true })
    toast({ kind: 'success', title: `Imported ${caps.length} captions` })
  }

  return (
    <div>
      <Section title="Generate with AI" defaultOpen>
        <div className="text-[11.5px] text-fg-3">Transcribes your voice locally with Whisper — nothing leaves your computer. The model is downloaded once.</div>
        <Row label="Model">
          <Segmented size="sm" value={model} onChange={setModel} options={[{ value: 'tiny', label: 'Fast' }, { value: 'base', label: 'Balanced' }, { value: 'small', label: 'Accurate' }]} />
        </Row>
        <Select
          label="Language"
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'auto', label: 'Auto-detect' },
            { value: 'en', label: 'English' },
            { value: 'fr', label: 'French' },
            { value: 'es', label: 'Spanish' },
            { value: 'de', label: 'German' },
            { value: 'it', label: 'Italian' },
            { value: 'pt', label: 'Portuguese' },
            { value: 'nl', label: 'Dutch' },
            { value: 'ja', label: 'Japanese' },
            { value: 'zh', label: 'Chinese' },
            { value: 'ko', label: 'Korean' },
            { value: 'ru', label: 'Russian' },
            { value: 'ar', label: 'Arabic' },
            { value: 'hi', label: 'Hindi' }
          ]}
        />
        {progress ? (
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-fg-2">{progress.message ?? progress.phase}</div>
            <Progress value={progress.progress} />
            <button className="btn btn-sm self-start" onClick={() => abortRef.current?.abort()}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button className="btn btn-primary flex-1" disabled={!hasAudio} onClick={() => void generate()}>
              <Sparkles size={13} /> Generate captions
            </button>
            <button className="btn" onClick={() => void importSrt()} title="Import SRT / VTT">
              <Upload size={13} />
            </button>
          </div>
        )}
        {!hasAudio && <div className="text-[11.5px] text-warn">No audio in this project.</div>}
      </Section>

      <Section title="Style" right={<Toggle checked={cap.enabled} onChange={(v) => setCap({ enabled: v })} />}>
        <Slider label="Size" value={cap.fontSize} min={18} max={90} step={1} format={(v) => `${Math.round(v)}`} onChange={(v) => setCap({ fontSize: v }, false)} onCommit={(v) => setCap({ fontSize: v })} />
        <Row label="Position">
          <Segmented size="sm" value={cap.position} onChange={(v) => setCap({ position: v })} options={[{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }]} />
        </Row>
        <Select label="Font" value={cap.fontFamily} onChange={(v) => setCap({ fontFamily: v })} options={FONTS.map((f) => ({ value: f, label: f.split(',')[0] }))} />
        <ColorField label="Text" value={cap.color} onChange={(v) => setCap({ color: v })} />
        <ColorField label="Highlight" value={cap.highlightColor} onChange={(v) => setCap({ highlightColor: v })} />
        <ColorField label="Background" value={cap.background} onChange={(v) => setCap({ background: v })} allowAlpha />
        <Row label="Max lines">
          <Segmented size="sm" value={String(cap.maxLines)} onChange={(v) => setCap({ maxLines: Number(v) })} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]} />
        </Row>
      </Section>

      <Section
        title={`Captions (${project.timeline.captions.length})`}
        right={
          project.timeline.captions.length > 0 ? (
            <div className="flex gap-1">
              <button className="btn btn-sm btn-ghost" title="Export SRT" onClick={() => downloadTextFile(`${project.name}.srt`, toSrt(project.timeline.captions))}>
                <Download size={12} /> SRT
              </button>
              <button className="btn btn-sm btn-ghost" title="Export VTT" onClick={() => downloadTextFile(`${project.name}.vtt`, toVtt(project.timeline.captions))}>
                <Download size={12} /> VTT
              </button>
              <button className="btn btn-sm btn-ghost text-danger" onClick={() => setCaptions([])}>
                <Trash2 size={12} />
              </button>
            </div>
          ) : undefined
        }
      >
        {project.timeline.captions.length === 0 ? (
          <div className="text-[11.5px] text-fg-3">No captions yet.</div>
        ) : (
          <div className="flex flex-col gap-1 max-h-[360px] overflow-y-auto -mx-1 px-1">
            {project.timeline.captions.map((c) => (
              <div key={c.id} className={cn('rounded-md p-2 flex flex-col gap-1 border', selection.kind === 'caption' && selection.id === c.id ? 'border-accent bg-accent-soft/40' : 'border-transparent hover:bg-white/[0.04]')} onClick={() => setSelection({ kind: 'caption', id: c.id })}>
                <div className="flex items-center justify-between text-[10.5px] font-mono text-fg-3">
                  <button className="hover:text-fg" onClick={() => usePlayer.getState().setTime(c.start + 10)}>
                    {formatTime(c.start)} → {formatTime(c.end)}
                  </button>
                  <button className="hover:text-danger" onClick={() => removeCaption(c.id)}>
                    <Trash2 size={11} />
                  </button>
                </div>
                <textarea className="input h-auto py-1 text-[12px] resize-none bg-transparent border-transparent focus:border-line-2" rows={2} value={c.text} onChange={(e) => updateCaption(c.id, { text: e.target.value })} />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
