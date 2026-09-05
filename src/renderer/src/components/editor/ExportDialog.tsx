import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Download, FolderOpen, Play, X, CheckCircle2, AlertTriangle, Film, Image as ImageIcon, Music, Layers } from 'lucide-react'
import { useProject } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'
import { useApp } from '@/store/appStore'
import { Modal, Segmented, Toggle, Select, Progress } from '../ui/ui'
import { exportProject, ExportCancelled } from '@/export/exporter'
import { outputSize } from '@/engine/layout'
import { timelineDuration } from '@/engine/timeline'
import { fw } from '@/lib/fw'
import { formatBytes, formatTime, cn } from '@/lib/utils'
import type { ExportOptions, ExportProgress } from '@shared/types'

type Fmt = ExportOptions['format']

export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const project = useProject((s) => s.project!)
  const events = useProject((s) => s.events)
  const save = useProject((s) => s.save)
  const inPoint = usePlayer((s) => s.inPoint)
  const outPoint = usePlayer((s) => s.outPoint)
  const setPlaying = usePlayer((s) => s.setPlaying)
  const toast = useApp((s) => s.toast)

  const [format, setFormat] = useState<Fmt>('mp4')
  const [height, setHeight] = useState<ExportOptions['height']>(project.render.outputHeight)
  const [fps, setFps] = useState<ExportOptions['fps']>(Math.min(60, project.recording.fps >= 50 ? 60 : 30) as 30 | 60)
  const [quality, setQuality] = useState<ExportOptions['quality']>('high')
  const [useRange, setUseRange] = useState(false)
  const [includeAudio, setIncludeAudio] = useState(true)
  const [codec, setCodec] = useState<NonNullable<ExportOptions['codec']>>('h264')
  const [hwAccel, setHwAccel] = useState(true)
  const [gifColors, setGifColors] = useState<64 | 128 | 256>(256)
  const [gifDither, setGifDither] = useState(true)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<{ path: string; size: number | null } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (open) {
      setProgress(null)
      setResult(null)
      setUseRange(inPoint != null && outPoint != null)
      setHeight(project.render.outputHeight)
    }
  }, [open, inPoint, outPoint, project.render.outputHeight])

  const hasRange = inPoint != null && outPoint != null && outPoint > inPoint
  const duration = timelineDuration(project.timeline)
  const rangeDur = useRange && hasRange ? outPoint! - inPoint! : duration
  const size = useMemo(() => outputSize(project.render, project.recording.width || 1920, project.recording.height || 1080, format === 'gif' ? Math.min(height, 720) : height), [project, height, format])

  const estimate = useMemo(() => {
    if (format === 'gif') return (size.width * size.height * Math.min(fps, 30) * (rangeDur / 1000) * 0.08) / 8
    if (format === 'png-sequence') return size.width * size.height * 1.2 * fps * (rangeDur / 1000)
    if (format === 'mp3') return (192000 / 8) * (rangeDur / 1000)
    const px = (size.width * size.height) / (1920 * 1080)
    const base = quality === 'draft' ? 3.5e6 : quality === 'good' ? 9e6 : quality === 'high' ? 18e6 : 45e6
    const br = base * Math.max(0.3, px) * (fps > 30 ? 1.3 : 1) + (includeAudio ? 192000 : 0)
    return (br / 8) * (rangeDur / 1000)
  }, [format, size, fps, rangeDur, quality, includeAudio])

  const start = async (): Promise<void> => {
    setPlaying(false)
    const ext = format === 'png-sequence' ? 'png' : format
    const safe = project.name.replace(/[<>:"/\\|?*]/g, '').trim() || 'export'
    const outPath = await fw.dialog.save({
      defaultName: `${safe}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }]
    })
    if (!outPath) return
    await save()
    const opts: ExportOptions = {
      format,
      fps,
      height: format === 'gif' ? (Math.min(height, 720) as ExportOptions['height']) : height,
      quality,
      range: useRange && hasRange ? { start: inPoint!, end: outPoint! } : null,
      outPath,
      includeAudio,
      gif: { loop: true, colors: gifColors, dither: gifDither },
      codec,
      hwAccel
    }
    abortRef.current = new AbortController()
    setResult(null)
    setProgress({ phase: 'preparing', progress: 0 })
    try {
      const path = await exportProject(project, events, opts, setProgress, abortRef.current.signal)
      const st = await fw.file.stat(path).catch(() => null)
      setResult({ path, size: st?.size ?? null })
      setProgress(null)
      toast({ kind: 'success', title: 'Export complete', message: path, action: { label: 'Show in folder', onClick: () => void fw.shell.showItem(path) } })
    } catch (e) {
      setProgress(null)
      if (e instanceof ExportCancelled) toast({ kind: 'info', title: 'Export cancelled' })
      else {
        console.error(e)
        toast({ kind: 'error', title: 'Export failed', message: (e as Error).message })
      }
    }
  }

  const busy = !!progress
  const formats: Array<{ value: Fmt; label: React.ReactNode; hint: string }> = [
    { value: 'mp4', label: <><Film size={13} /> MP4</>, hint: 'Best compatibility · H.264/H.265' },
    { value: 'webm', label: <><Film size={13} /> WebM</>, hint: 'VP9 · supports transparency' },
    { value: 'gif', label: <><ImageIcon size={13} /> GIF</>, hint: 'Animated, no audio' },
    { value: 'png-sequence', label: <><Layers size={13} /> PNG</>, hint: 'Frame sequence for compositing' },
    { value: 'mp3', label: <><Music size={13} /> MP3</>, hint: 'Audio only' }
  ]

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return
        onClose()
      }}
      title={
        <span className="flex items-center gap-2">
          <Download size={15} /> Export
        </span>
      }
      width={560}
      footer={
        result ? (
          <>
            <button className="btn" onClick={onClose}>
              Close
            </button>
            <button className="btn" onClick={() => void fw.shell.showItem(result.path)}>
              <FolderOpen size={14} /> Show in folder
            </button>
            <button className="btn btn-primary" onClick={() => void fw.shell.openPath(result.path)}>
              <Play size={14} /> Open
            </button>
          </>
        ) : busy ? (
          <button className="btn btn-danger" onClick={() => abortRef.current?.abort()}>
            <X size={14} /> Cancel export
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={() => void start()}>
              <Download size={14} /> Export {format === 'png-sequence' ? 'frames' : format.toUpperCase()}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="w-14 h-14 rounded-full grid place-items-center bg-ok/15 text-ok">
            <CheckCircle2 size={26} />
          </div>
          <div className="text-[15px] font-semibold">Export finished</div>
          <div className="text-[12px] text-fg-3 font-mono break-all max-w-[420px]">{result.path}</div>
          {result.size != null && <div className="text-[12px] text-fg-2">{formatBytes(result.size)}</div>}
        </div>
      ) : busy && progress ? (
        <div className="flex flex-col gap-4 py-2">
          <div className="flex items-center justify-between text-[13px]">
            <span className="font-medium">
              {progress.phase === 'preparing' && 'Preparing…'}
              {progress.phase === 'encoding-audio' && (progress.message ?? 'Mixing audio…')}
              {progress.phase === 'rendering' && `Rendering frame ${progress.frame} / ${progress.totalFrames}`}
              {progress.phase === 'muxing' && 'Writing file…'}
              {progress.phase === 'finalizing' && (progress.message ?? 'Finalizing…')}
            </span>
            <span className="font-mono text-fg-3 text-[12px]">{Math.round(progress.progress * 100)}%</span>
          </div>
          <Progress value={progress.progress} />
          <div className="flex items-center justify-between text-[11.5px] text-fg-3 font-mono">
            <span>{progress.fps ? `${progress.fps.toFixed(0)} fps` : ''}</span>
            <span>{progress.etaMs != null && progress.phase === 'rendering' ? `~${formatTime(progress.etaMs).replace(/\.\d\d$/, '')} left` : ''}</span>
          </div>
          <div className="text-[11.5px] text-fg-3">Rendering uses your GPU via WebCodecs. You can keep using other apps meanwhile.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <div className="label mb-2">Format</div>
            <div className="grid grid-cols-5 gap-2">
              {formats.map((f) => (
                <button key={f.value} onClick={() => setFormat(f.value)} className={cn('rounded-xl border p-2.5 text-left flex flex-col gap-1 transition-colors', format === f.value ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-2')}>
                  <span className="text-[12.5px] font-semibold flex items-center gap-1.5">{f.label}</span>
                  <span className="text-[10.5px] text-fg-3 leading-tight">{f.hint}</span>
                </button>
              ))}
            </div>
          </div>

          {format !== 'mp3' && (
            <div className="grid grid-cols-2 gap-4">
              <Select label="Resolution" value={String(height) as '480' | '720' | '1080' | '1440' | '2160'} onChange={(v) => setHeight(Number(v) as ExportOptions['height'])} options={[{ value: '480', label: '480p' }, { value: '720', label: '720p' }, { value: '1080', label: '1080p' }, { value: '1440', label: '1440p' }, { value: '2160', label: '2160p (4K)' }]} />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-fg-2">Frame rate</span>
                <Segmented size="sm" value={String(fps) as '24' | '30' | '60'} onChange={(v) => setFps(Number(v) as ExportOptions['fps'])} options={[{ value: '24', label: '24' }, { value: '30', label: '30' }, { value: '60', label: '60' }]} />
              </div>
            </div>
          )}

          {(format === 'mp4' || format === 'webm') && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-fg-2">Quality</span>
                <Segmented size="sm" value={quality} onChange={setQuality} options={[{ value: 'draft', label: 'Draft' }, { value: 'good', label: 'Good' }, { value: 'high', label: 'High' }, { value: 'lossless', label: 'Max' }]} />
              </div>
              {format === 'mp4' && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-fg-2">Codec</span>
                  <Segmented size="sm" value={codec} onChange={setCodec} options={[{ value: 'h264', label: 'H.264', title: 'Plays everywhere' }, { value: 'h265', label: 'H.265', title: 'Smaller files, needs hardware support' }, { value: 'av1', label: 'AV1', title: 'Best compression, newer devices' }]} />
                </div>
              )}
              <Toggle label="Include audio" checked={includeAudio} onChange={setIncludeAudio} />
              <Toggle label="Hardware encoding" hint="Uses your GPU's encoder when available" checked={hwAccel} onChange={setHwAccel} />
            </>
          )}

          {format === 'gif' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-fg-2">Colors</span>
                <Segmented size="sm" value={String(gifColors) as '64' | '128' | '256'} onChange={(v) => setGifColors(Number(v) as 64 | 128 | 256)} options={[{ value: '64', label: '64' }, { value: '128', label: '128' }, { value: '256', label: '256' }]} />
              </div>
              <Toggle label="Dithering" checked={gifDither} onChange={setGifDither} />
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-fg-2">Range</span>
            <Segmented size="sm" value={useRange && hasRange ? 'range' : 'full'} onChange={(v) => setUseRange(v === 'range')} options={[{ value: 'full', label: `Full · ${formatTime(duration).replace(/\.\d\d$/, '')}` }, ...(hasRange ? [{ value: 'range', label: `In → Out · ${formatTime(outPoint! - inPoint!).replace(/\.\d\d$/, '')}` }] : [])]} />
          </div>

          <div className="rounded-xl bg-white/[0.03] border border-line p-3 flex items-center justify-between text-[12px]">
            <div className="flex flex-col gap-0.5">
              <span className="text-fg-2">
                {format === 'mp3' ? 'Audio only' : `${size.width} × ${size.height}`} {format !== 'mp3' && `· ${fps} fps`} · {formatTime(rangeDur).replace(/\.\d\d$/, '')}
              </span>
              <span className="text-fg-3">Estimated size ≈ {formatBytes(estimate)}</span>
            </div>
            {format === 'webm' && project.render.background.type === 'transparent' && (
              <span className="text-[11px] text-accent-2 flex items-center gap-1">
                <AlertTriangle size={12} /> Alpha channel
              </span>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
