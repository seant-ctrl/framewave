import React from 'react'
import { Image, Frame, MousePointer2, ZoomIn, Camera, Volume2, Type, Subtitles, Palette, Keyboard } from 'lucide-react'
import { useProject, type PanelId } from '@/store/projectStore'
import { cn } from '@/lib/utils'
import { Tip } from '../ui/ui'
import type { EditorContext } from './Editor'
import { BackgroundPanel, FramePanel, ColorPanel } from './panels/LookPanels'
import { CursorPanel, ZoomPanel, CameraPanel, KeysPanel } from './panels/MotionPanels'
import { AudioPanel, TextPanel, CaptionsPanel } from './panels/ContentPanels'

const TABS: Array<{ id: PanelId; icon: React.ReactNode; label: string }> = [
  { id: 'background', icon: <Image size={16} />, label: 'Background' },
  { id: 'screen', icon: <Frame size={16} />, label: 'Frame & crop' },
  { id: 'zoom', icon: <ZoomIn size={16} />, label: 'Zoom' },
  { id: 'cursor', icon: <MousePointer2 size={16} />, label: 'Cursor' },
  { id: 'camera', icon: <Camera size={16} />, label: 'Camera' },
  { id: 'audio', icon: <Volume2 size={16} />, label: 'Audio' },
  { id: 'text', icon: <Type size={16} />, label: 'Text' },
  { id: 'captions', icon: <Subtitles size={16} />, label: 'Captions' },
  { id: 'keys', icon: <Keyboard size={16} />, label: 'Keystrokes' },
  { id: 'color', icon: <Palette size={16} />, label: 'Color & effects' }
]

export function Inspector({ ctx }: { ctx: EditorContext }): React.JSX.Element {
  const active = useProject((s) => s.activePanel)
  const setActive = useProject((s) => s.setActivePanel)
  const hasCamera = useProject((s) => !!s.project?.recording.camera)
  const hasEvents = useProject((s) => !!s.events)
  const tab = TABS.find((t) => t.id === active) ?? TABS[0]

  return (
    <div className="w-[356px] shrink-0 flex border-l border-line bg-bg-1">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-11 shrink-0 flex items-center px-4 border-b border-line">
          <span className="text-fg-3 mr-2">{tab.icon}</span>
          <span className="text-[13px] font-semibold">{tab.label}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {active === 'background' && <BackgroundPanel />}
          {active === 'screen' && <FramePanel />}
          {active === 'zoom' && <ZoomPanel ctx={ctx} />}
          {active === 'cursor' && <CursorPanel />}
          {active === 'camera' && <CameraPanel />}
          {active === 'audio' && <AudioPanel />}
          {active === 'text' && <TextPanel />}
          {active === 'captions' && <CaptionsPanel />}
          {active === 'keys' && <KeysPanel />}
          {active === 'color' && <ColorPanel />}
        </div>
      </div>
      <div className="w-12 shrink-0 border-l border-line flex flex-col items-center py-2 gap-1 bg-bg">
        {TABS.map((t) => {
          const dim = (t.id === 'camera' && !hasCamera) || ((t.id === 'cursor' || t.id === 'keys') && !hasEvents)
          return (
            <Tip key={t.id} label={t.label + (dim ? ' (not available for this recording)' : '')} side="left">
              <button aria-label={t.label} onClick={() => setActive(t.id)} className={cn('w-9 h-9 rounded-lg grid place-items-center transition-colors', active === t.id ? 'bg-accent-soft text-accent-2' : 'text-fg-3 hover:text-fg hover:bg-white/[0.05]', dim && 'opacity-40')}>
                {t.icon}
              </button>
            </Tip>
          )
        })}
      </div>
    </div>
  )
}
