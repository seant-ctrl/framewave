import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { fw } from './lib/fw'
import type { HudState } from '@shared/types'
import { Pause, Play, Square, Trash2, RotateCcw, Mic, MicOff, Video, VideoOff } from 'lucide-react'

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

function Hud(): React.JSX.Element {
  const [state, setState] = useState<HudState>({ status: 'countdown', countdown: 3, elapsedMs: 0, micLevel: 0, micEnabled: true, cameraEnabled: false })
  useEffect(() => fw.hud.onState(setState), [])

  const bars = 12
  return (
    <div className="w-screen h-screen flex items-center justify-center">
      <div
        className="drag flex items-center gap-2 h-[56px] pl-3 pr-2 rounded-2xl fade-in"
        style={{
          background: 'rgba(14,15,24,0.92)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 16px 50px -16px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.06)',
          backdropFilter: 'blur(20px)'
        }}
      >
        {state.status === 'countdown' ? (
          <div className="flex items-center gap-3 pr-2">
            <div className="w-9 h-9 rounded-full grid place-items-center font-bold text-[18px]" style={{ background: 'rgba(124,92,255,0.25)', color: '#c4b5fd' }}>
              {state.countdown}
            </div>
            <div className="text-[13px] text-fg-2">Recording starts in…</div>
            <button className="btn btn-sm btn-ghost no-drag" onClick={() => fw.hud.sendCommand('cancel')}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 w-[92px]">
              <span className={'w-2.5 h-2.5 rounded-full ' + (state.status === 'recording' ? 'rec-dot' : '')} style={{ background: state.status === 'recording' ? '#ff4d6d' : '#fbbf24' }} />
              <span className="font-mono text-[15px] tabular-nums tracking-tight">{fmt(state.elapsedMs)}</span>
            </div>

            {/* Mic level */}
            <div className="flex items-end gap-[2px] h-5 w-[52px] mx-1" title="Microphone level">
              {Array.from({ length: bars }).map((_, i) => {
                const on = state.micEnabled && state.micLevel * bars > i
                return <span key={i} className="w-[3px] rounded-sm transition-all" style={{ height: `${30 + (i / bars) * 70}%`, background: on ? (i > bars * 0.8 ? '#ff5c7a' : '#7c5cff') : 'rgba(255,255,255,0.12)' }} />
              })}
            </div>

            <div className="w-px h-6 bg-white/10 mx-1" />

            <button className="btn btn-icon btn-ghost no-drag" title={state.micEnabled ? 'Mute mic' : 'Unmute mic'} onClick={() => fw.hud.sendCommand('toggle-mic')}>
              {state.micEnabled ? <Mic size={16} /> : <MicOff size={16} className="text-danger" />}
            </button>
            <button className="btn btn-icon btn-ghost no-drag" title={state.cameraEnabled ? 'Hide camera' : 'Show camera'} onClick={() => fw.hud.sendCommand('toggle-camera')}>
              {state.cameraEnabled ? <Video size={16} /> : <VideoOff size={16} className="text-fg-3" />}
            </button>
            <button className="btn btn-icon btn-ghost no-drag" title={state.status === 'paused' ? 'Resume' : 'Pause'} onClick={() => fw.hud.sendCommand(state.status === 'paused' ? 'resume' : 'pause')}>
              {state.status === 'paused' ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button className="btn btn-icon btn-ghost no-drag" title="Restart recording" onClick={() => fw.hud.sendCommand('restart')}>
              <RotateCcw size={15} />
            </button>
            <button className="btn btn-icon btn-ghost no-drag text-danger" title="Discard recording" onClick={() => fw.hud.sendCommand('cancel')}>
              <Trash2 size={15} />
            </button>
            <button
              className="no-drag h-9 px-3 rounded-xl flex items-center gap-2 font-semibold text-[13px] ml-1"
              style={{ background: 'linear-gradient(180deg,#ff5c7a,#e5395a)', boxShadow: '0 6px 18px -6px rgba(255,92,122,.8)' }}
              onClick={() => fw.hud.sendCommand('stop')}
              title="Stop & open editor"
            >
              <Square size={13} fill="currentColor" /> Stop
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Floating camera bubble (separate window using the same html) */
function CameraBubble({ deviceId }: { deviceId: string }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let stream: MediaStream | null = null
    let alive = true
    const start = async (id: string): Promise<void> => {
      stream?.getTracks().forEach((t) => t.stop())
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } })
        if (!alive) return
        if (videoRef.current) videoRef.current.srcObject = stream
        setErr(null)
      } catch (e) {
        setErr('Camera busy')
      }
    }
    void start(deviceId)
    const unsub = fw.hud.onCameraDevice((id) => void start(id))
    return () => {
      alive = false
      unsub()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [deviceId])
  return (
    <div className="drag w-screen h-screen p-2">
      <div className="w-full h-full rounded-full overflow-hidden relative" style={{ boxShadow: '0 12px 40px -10px rgba(0,0,0,.9), 0 0 0 3px rgba(255,255,255,0.9)' }}>
        <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)', background: '#111' }} />
        {err && <div className="absolute inset-0 grid place-items-center text-[12px] text-fg-2 bg-bg-1/80">{err}</div>}
      </div>
    </div>
  )
}

const params = new URLSearchParams(location.hash.slice(1))
const cam = params.get('camera')
createRoot(document.getElementById('root')!).render(cam ? <CameraBubble deviceId={cam} /> : <Hud />)
