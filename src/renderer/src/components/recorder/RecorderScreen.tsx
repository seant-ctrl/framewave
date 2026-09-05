import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Monitor, AppWindow, Crop, RefreshCw, Camera, Mic, MicOff, Volume2, MousePointer2, Circle, CameraOff, Check, Info, Square, Pause, Play, Trash2 } from 'lucide-react'
import type { CaptureSource, DisplayInfo, RecordingOptions, Rect } from '@shared/types'
import { fw } from '@/lib/fw'
import { useApp } from '@/store/appStore'
import { cn, formatTime } from '@/lib/utils'
import { Segmented, Toggle, Select, Progress } from '../ui/ui'
import { recorder, type RecorderSnapshot } from '@/recorder/recorder'

type Mode = RecordingOptions['mode']

export function RecorderScreen(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const toast = useApp((s) => s.toast)

  const [mode, setMode] = useState<Mode>((settings?.defaultRecording.mode as Mode) ?? 'display')
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [region, setRegion] = useState<Rect | null>(null)
  const [regionDisplayId, setRegionDisplayId] = useState<number | null>(null)
  const [loadingSources, setLoadingSources] = useState(false)

  const [cams, setCams] = useState<MediaDeviceInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [cameraId, setCameraId] = useState<string | null>(settings?.defaultRecording.cameraDeviceId ?? null)
  const [micId, setMicId] = useState<string | null>(settings?.defaultRecording.micDeviceId ?? 'default')
  const [systemAudio, setSystemAudio] = useState(settings?.defaultRecording.systemAudio ?? true)
  const [fps, setFps] = useState<30 | 60>(settings?.defaultRecording.fps ?? 60)
  const [quality, setQuality] = useState<RecordingOptions['quality']>(settings?.defaultRecording.quality ?? 'high')
  const [countdown, setCountdown] = useState<0 | 3 | 5>(settings?.defaultRecording.countdown ?? 3)
  const [cursorCapture, setCursorCapture] = useState(settings?.defaultRecording.cursorCapture ?? true)
  const [hideSystemCursor, setHideSystemCursor] = useState(settings?.defaultRecording.hideSystemCursor ?? true)
  const [snap, setSnap] = useState<RecorderSnapshot>(recorder.snapshot)

  useEffect(() => recorder.subscribe(setSnap), [])

  // Sync from settings when they load
  useEffect(() => {
    if (!settings) return
    const d = settings.defaultRecording
    if (d.mode) setMode(d.mode)
    if (d.cameraDeviceId !== undefined) setCameraId(d.cameraDeviceId)
    if (d.micDeviceId !== undefined) setMicId(d.micDeviceId)
    if (d.systemAudio !== undefined) setSystemAudio(d.systemAudio)
    if (d.fps) setFps(d.fps)
    if (d.quality) setQuality(d.quality)
    if (d.countdown !== undefined) setCountdown(d.countdown)
    if (d.cursorCapture !== undefined) setCursorCapture(d.cursorCapture)
    if (d.hideSystemCursor !== undefined) setHideSystemCursor(d.hideSystemCursor)
  }, [settings])

  const refreshSources = useCallback(async () => {
    setLoadingSources(true)
    try {
      const [d, s] = await Promise.all([fw.capture.displays(), fw.capture.sources(mode === 'window' ? ['window'] : ['screen'])])
      setDisplays(d)
      setSources(s)
      setSourceId((cur) => (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null))
    } finally {
      setLoadingSources(false)
    }
  }, [mode])

  useEffect(() => {
    void refreshSources()
    const iv = setInterval(() => void refreshSources(), mode === 'window' ? 4000 : 10000)
    return () => clearInterval(iv)
  }, [refreshSources, mode])

  // Devices
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        // Unlock device labels
        const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
        s?.getTracks().forEach((t) => t.stop())
      } catch {
        /* ignore */
      }
      const devs = await navigator.mediaDevices.enumerateDevices()
      if (!alive) return
      setCams(devs.filter((d) => d.kind === 'videoinput'))
      setMics(devs.filter((d) => d.kind === 'audioinput'))
    }
    void load()
    navigator.mediaDevices.addEventListener('devicechange', load)
    return () => {
      alive = false
      navigator.mediaDevices.removeEventListener('devicechange', load)
    }
  }, [])

  const selectedSource = useMemo(() => sources.find((s) => s.id === sourceId) ?? null, [sources, sourceId])
  const selectedDisplay = useMemo(() => {
    if (!selectedSource) return displays.find((d) => d.isPrimary) ?? null
    if (selectedSource.kind === 'screen') return displays.find((d) => String(d.id) === selectedSource.displayId) ?? displays.find((d) => d.isPrimary) ?? null
    // window → display containing its center
    const b = selectedSource.bounds
    if (b) {
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      return displays.find((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height) ?? displays[0] ?? null
    }
    return displays.find((d) => d.isPrimary) ?? null
  }, [selectedSource, displays])

  const pickArea = async (): Promise<void> => {
    const d = selectedDisplay
    const r = await fw.capture.pickRegion(d?.id)
    if (r) {
      setRegion(r)
      setRegionDisplayId(d?.id ?? null)
    }
  }

  const persist = (): void => {
    void updateSettings({ defaultRecording: { mode, cameraDeviceId: cameraId, micDeviceId: micId, systemAudio, fps, quality, countdown, cursorCapture, hideSystemCursor } })
  }

  const canStart = !!selectedSource && (mode !== 'region' || !!region) && snap.status === 'idle'

  const start = async (): Promise<void> => {
    if (!selectedSource) return
    if (mode === 'region' && !region) return void toast({ kind: 'info', title: 'Select an area first' })
    persist()
    const opts: RecordingOptions = {
      mode,
      sourceId: selectedSource.id,
      displayId: selectedDisplay?.id,
      region: mode === 'region' ? region! : undefined,
      fps,
      quality,
      cameraDeviceId: cameraId,
      micDeviceId: micId,
      systemAudio,
      countdown,
      cursorCapture,
      hideSystemCursor: cursorCapture && hideSystemCursor
    }
    await recorder.start(opts, selectedSource, selectedDisplay)
  }

  if (snap.status !== 'idle' && snap.status !== 'error') return <RecordingStatus snap={snap} />

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-8 py-7 grid grid-cols-[1fr_360px] gap-6">
        {/* ── Source ── */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight">What do you want to record?</h1>
              <p className="text-fg-3 text-[12.5px] mt-0.5">Pick a display, a single window, or draw a custom area.</p>
            </div>
            <Segmented
              value={mode}
              onChange={(m) => {
                setMode(m)
                setRegion(null)
              }}
              options={[
                { value: 'display', label: <><Monitor size={13} /> Display</> },
                { value: 'window', label: <><AppWindow size={13} /> Window</> },
                { value: 'region', label: <><Crop size={13} /> Area</> }
              ]}
            />
          </div>

          <div className="card p-4 min-h-[380px]">
            <div className="flex items-center justify-between mb-3">
              <span className="label">{mode === 'window' ? `${sources.length} windows` : `${sources.length} display${sources.length === 1 ? '' : 's'}`}</span>
              <button className="btn btn-ghost btn-sm" onClick={() => void refreshSources()}>
                <RefreshCw size={12} className={cn(loadingSources && 'animate-spin')} /> Refresh
              </button>
            </div>
            {mode === 'window' ? (
              <div className="grid grid-cols-3 gap-3 max-h-[520px] overflow-y-auto pr-1">
                {sources.map((s) => (
                  <SourceCard key={s.id} source={s} selected={s.id === sourceId} onClick={() => setSourceId(s.id)} />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {sources.map((s) => {
                  const d = displays.find((x) => String(x.id) === s.displayId)
                  return <SourceCard key={s.id} source={s} selected={s.id === sourceId} onClick={() => setSourceId(s.id)} subtitle={d ? `${Math.round(d.bounds.width * d.scaleFactor)}×${Math.round(d.bounds.height * d.scaleFactor)}${d.isPrimary ? ' · Primary' : ''}` : undefined} />
                })}
              </div>
            )}
            {mode === 'region' && (
              <div className="mt-4 p-4 rounded-xl border border-dashed border-line-2 flex items-center justify-between gap-4" style={{ background: 'rgba(124,92,255,0.05)' }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg grid place-items-center bg-accent-soft text-accent-2">
                    <Crop size={18} />
                  </div>
                  <div>
                    <div className="text-[13px] font-medium">{region ? `Area: ${Math.round(region.width * (selectedDisplay?.scaleFactor ?? 1))} × ${Math.round(region.height * (selectedDisplay?.scaleFactor ?? 1))} px` : 'No area selected'}</div>
                    <div className="text-[11.5px] text-fg-3">The full display is captured; the area becomes the default crop so you can adjust it later.</div>
                  </div>
                </div>
                <button className="btn btn-primary" onClick={() => void pickArea()}>
                  {region ? 'Change area' : 'Select area'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Options ── */}
        <div className="flex flex-col gap-4">
          <CameraPicker cams={cams} value={cameraId} onChange={setCameraId} />
          <MicPicker mics={mics} value={micId} onChange={setMicId} />

          <div className="card p-4 flex flex-col gap-3.5">
            <Toggle
              checked={systemAudio}
              onChange={setSystemAudio}
              label={
                <span className="flex items-center gap-2">
                  <Volume2 size={14} className="text-fg-2" /> System audio
                </span>
              }
              hint="Capture what you hear (apps, browser, music)"
            />
            <Toggle
              checked={cursorCapture}
              onChange={setCursorCapture}
              label={
                <span className="flex items-center gap-2">
                  <MousePointer2 size={14} className="text-fg-2" /> Track cursor & clicks
                </span>
              }
              hint="Enables auto-zoom, smooth cursor and keystroke overlays"
            />
            {cursorCapture && (
              <Toggle
                checked={hideSystemCursor}
                onChange={setHideSystemCursor}
                label={<span className="flex items-center gap-2 pl-6">Hide real cursor while recording</span>}
                hint="The cursor is re-drawn in the editor, so it stays crisp and smooth"
              />
            )}
            <div className="h-px bg-line" />
            <div className="flex items-center justify-between">
              <span className="text-[12.5px]">Frame rate</span>
              <Segmented size="sm" value={String(fps) as '30' | '60'} onChange={(v) => setFps(Number(v) as 30 | 60)} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px]">Quality</span>
              <Segmented size="sm" value={quality} onChange={setQuality} options={[{ value: 'good', label: 'Good' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }]} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[12.5px]">Countdown</span>
              <Segmented size="sm" value={String(countdown) as '0' | '3' | '5'} onChange={(v) => setCountdown(Number(v) as 0 | 3 | 5)} options={[{ value: '0', label: 'Off' }, { value: '3', label: '3s' }, { value: '5', label: '5s' }]} />
            </div>
          </div>

          <button className={cn('btn btn-primary btn-lg w-full !h-12 !text-[15px] gap-2', !canStart && 'opacity-50')} disabled={!canStart} onClick={() => void start()}>
            <Circle size={14} fill="currentColor" className="text-white" /> Start recording
          </button>
          <div className="text-[11.5px] text-fg-3 flex items-start gap-1.5 px-1">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>
              Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> anywhere to stop. The control bar and camera bubble are hidden from the recording.
            </span>
          </div>
          {snap.error && <div className="text-[12px] text-danger bg-danger/10 border border-danger/20 rounded-lg p-3">{snap.error}</div>}
        </div>
      </div>
    </div>
  )
}

function SourceCard({ source, selected, onClick, subtitle }: { source: CaptureSource; selected: boolean; onClick: () => void; subtitle?: string }): React.JSX.Element {
  return (
    <button onClick={onClick} className={cn('group text-left rounded-xl overflow-hidden border transition-all', selected ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-line-2')} style={{ background: '#0d0e16' }}>
      <div className="aspect-video bg-black/40 relative overflow-hidden grid place-items-center">
        {source.thumbnail && source.thumbnail.length > 50 ? <img src={source.thumbnail} className="max-w-full max-h-full object-contain" alt="" draggable={false} /> : <AppWindow size={20} className="text-fg-3" />}
        {selected && (
          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent grid place-items-center">
            <Check size={12} strokeWidth={3} />
          </div>
        )}
      </div>
      <div className="p-2.5 flex items-center gap-2">
        {source.appIcon && <img src={source.appIcon} className="w-4 h-4" alt="" />}
        <div className="min-w-0">
          <div className="text-[12px] font-medium truncate">{source.name}</div>
          {subtitle && <div className="text-[11px] text-fg-3">{subtitle}</div>}
        </div>
      </div>
    </button>
  )
}

function CameraPicker({ cams, value, onChange }: { cams: MediaDeviceInfo[]; value: string | null; onChange: (v: string | null) => void }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let stream: MediaStream | null = null
    let alive = true
    if (!value) return
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: value }, width: { ideal: 640 } } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop())
        stream = s
        if (videoRef.current) videoRef.current.srcObject = s
        setError(false)
      })
      .catch(() => setError(true))
    return () => {
      alive = false
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [value])
  const options = [{ value: '', label: 'No camera' }, ...cams.map((c) => ({ value: c.deviceId, label: c.label || 'Camera' }))]
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          {value ? <Camera size={14} className="text-fg-2" /> : <CameraOff size={14} className="text-fg-3" />} Camera
        </span>
        <Select value={value ?? ''} options={options} onChange={(v) => onChange(v || null)} />
      </div>
      {value && (
        <div className="aspect-video rounded-lg overflow-hidden bg-black/50 relative">
          <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover -scale-x-100" />
          {error && <div className="absolute inset-0 grid place-items-center text-[12px] text-fg-3">Camera unavailable</div>}
        </div>
      )}
    </div>
  )
}

function MicPicker({ mics, value, onChange }: { mics: MediaDeviceInfo[]; value: string | null; onChange: (v: string | null) => void }): React.JSX.Element {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!value) return setLevel(0)
    let alive = true
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: value === 'default' ? undefined : { exact: value } } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop())
        stream = s
        ctx = new AudioContext()
        const an = ctx.createAnalyser()
        an.fftSize = 512
        ctx.createMediaStreamSource(s).connect(an)
        const buf = new Uint8Array(an.fftSize)
        const loop = (): void => {
          an.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3.2))
          raf = requestAnimationFrame(loop)
        }
        loop()
      })
      .catch(() => setLevel(0))
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
    }
  }, [value])
  const options = [{ value: '', label: 'No microphone' }, { value: 'default', label: 'System default' }, ...mics.filter((m) => m.deviceId !== 'default' && m.deviceId !== 'communications').map((m) => ({ value: m.deviceId, label: m.label || 'Microphone' }))]
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          {value ? <Mic size={14} className="text-fg-2" /> : <MicOff size={14} className="text-fg-3" />} Microphone
        </span>
        <Select value={value ?? ''} options={options} onChange={(v) => onChange(v || null)} />
      </div>
      {value && (
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full rounded-full transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%`, background: level > 0.85 ? '#ff5c7a' : 'linear-gradient(90deg,#34d399,#7c5cff)' }} />
        </div>
      )}
    </div>
  )
}

function RecordingStatus({ snap }: { snap: RecorderSnapshot }): React.JSX.Element {
  const processing = snap.status === 'processing'
  return (
    <div className="h-full grid place-items-center">
      <div className="card w-[460px] p-8 flex flex-col items-center gap-4 text-center" style={{ boxShadow: 'var(--shadow-pop)' }}>
        {processing ? (
          <>
            <div className="w-14 h-14 rounded-2xl grid place-items-center bg-accent-soft text-accent-2">
              <RefreshCw size={22} className="animate-spin" />
            </div>
            <div className="text-[16px] font-semibold">Processing recording</div>
            <div className="text-[12.5px] text-fg-2">{snap.processing?.label ?? 'Finishing up'}…</div>
            <Progress value={snap.processing?.progress ?? 0} className="mt-1" />
          </>
        ) : (
          <>
            <div className="w-14 h-14 rounded-full grid place-items-center" style={{ background: 'rgba(255,92,122,0.15)' }}>
              <Circle size={18} fill="#ff4d6d" className={cn('text-[#ff4d6d]', snap.status === 'recording' && 'rec-dot')} />
            </div>
            <div className="text-[16px] font-semibold">{snap.status === 'countdown' ? `Starting in ${snap.countdown}…` : snap.status === 'paused' ? 'Paused' : snap.status === 'stopping' ? 'Stopping…' : 'Recording'}</div>
            <div className="font-mono text-[28px] tabular-nums tracking-tight">{formatTime(snap.elapsedMs, { long: true })}</div>
            <div className="flex items-center gap-2 mt-1">
              <button className="btn" onClick={() => recorder.togglePause()} disabled={snap.status !== 'recording' && snap.status !== 'paused'}>
                {snap.status === 'paused' ? <Play size={14} /> : <Pause size={14} />} {snap.status === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button className="btn btn-danger" onClick={() => void recorder.cancel()}>
                <Trash2 size={14} /> Discard
              </button>
              <button className="btn btn-primary" onClick={() => void recorder.stop()} disabled={snap.status === 'stopping'}>
                <Square size={13} fill="currentColor" /> Stop & edit
              </button>
            </div>
            <div className="text-[11.5px] text-fg-3">Use the floating control bar or the global hotkey to stop.</div>
          </>
        )}
      </div>
    </div>
  )
}
