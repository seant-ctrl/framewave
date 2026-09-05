import React, { useEffect, useState } from 'react'
import { FolderOpen, Keyboard, Cpu, Palette, Info } from 'lucide-react'
import { useApp } from '@/store/appStore'
import { fw } from '@/lib/fw'
import { Toggle, Segmented } from './ui/ui'

export function SettingsScreen(): React.JSX.Element {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const loadSettings = useApp((s) => s.loadSettings)
  const [version, setVersion] = useState('')
  useEffect(() => {
    void fw.app.version().then(setVersion)
  }, [])
  if (!settings) return <div className="p-8 text-fg-3">Loading…</div>

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 py-8 flex flex-col gap-5">
        <h1 className="text-[18px] font-semibold tracking-tight">Settings</h1>

        <Card icon={<FolderOpen size={15} />} title="Storage">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[12.5px]">Recordings folder</div>
              <div className="text-[11.5px] text-fg-3 font-mono truncate">{settings.projectsDir}</div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button className="btn btn-sm" onClick={() => void fw.shell.openPath(settings.projectsDir)}>
                Open
              </button>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  await fw.settings.chooseProjectsDir()
                  await loadSettings()
                }}
              >
                Change…
              </button>
            </div>
          </div>
          <Toggle label="Open editor after recording" checked={settings.openEditorAfterRecord} onChange={(v) => void update({ openEditorAfterRecord: v })} />
        </Card>

        <Card icon={<Keyboard size={15} />} title="Global hotkeys">
          <HotkeyRow label="Start / stop recording" value={settings.hotkeys.toggleRecord} onChange={(v) => void update({ hotkeys: { ...settings.hotkeys, toggleRecord: v } })} />
          <HotkeyRow label="Pause / resume" value={settings.hotkeys.pauseResume} onChange={(v) => void update({ hotkeys: { ...settings.hotkeys, pauseResume: v } })} />
          <div className="text-[11.5px] text-fg-3">Use Electron accelerator syntax, e.g. <code className="font-mono">CommandOrControl+Shift+R</code>.</div>
        </Card>

        <Card icon={<Cpu size={15} />} title="Performance">
          <Toggle label="Hardware acceleration" hint="Restart required. Disable only if you see rendering glitches." checked={settings.hardwareAcceleration} onChange={(v) => void update({ hardwareAcceleration: v })} />
          <div className="flex items-center justify-between">
            <span className="text-[12.5px]">Default recording frame rate</span>
            <Segmented size="sm" value={String(settings.defaultRecording.fps ?? 60) as '30' | '60'} onChange={(v) => void update({ defaultRecording: { ...settings.defaultRecording, fps: Number(v) as 30 | 60 } })} options={[{ value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }]} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12.5px]">Default recording quality</span>
            <Segmented size="sm" value={settings.defaultRecording.quality ?? 'high'} onChange={(v) => void update({ defaultRecording: { ...settings.defaultRecording, quality: v } })} options={[{ value: 'good', label: 'Good' }, { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }]} />
          </div>
        </Card>

        <Card icon={<Palette size={15} />} title="Appearance">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px]">Theme</span>
            <Segmented size="sm" value={settings.theme} onChange={(v) => void update({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'midnight', label: 'Midnight' }, { value: 'graphite', label: 'Graphite' }]} />
          </div>
        </Card>

        <Card icon={<Info size={15} />} title="About">
          <div className="text-[12.5px] text-fg-2">
            Framewave {version} · Electron {navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1]} · Chromium {navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1]}
          </div>
          <div className="text-[11.5px] text-fg-3">Screen recorder & editor with automatic zoom, cursor effects, backgrounds, captions and studio-grade export. Everything stays on your computer.</div>
        </Card>
      </div>
    </div>
  )
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="card p-5 flex flex-col gap-3.5">
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-fg-3">{icon}</span> {title}
      </div>
      {children}
    </div>
  )
}

function HotkeyRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px]">{label}</span>
      <input
        className="input h-7 w-64 font-mono text-[11.5px]"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v !== value && onChange(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </div>
  )
}
