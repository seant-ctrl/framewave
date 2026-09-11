import React from 'react'
import { Minus, Square, X, Copy, Home, Circle, Settings, ChevronLeft } from 'lucide-react'
import { useApp } from '@/store/appStore'
import { useProject } from '@/store/projectStore'
import { fw } from '@/lib/fw'
import { cn } from '@/lib/utils'
import { recorder } from '@/recorder/recorder'

const isMac = fw.platform === 'darwin'

export function TitleBar(): React.JSX.Element {
  const route = useApp((s) => s.route)
  const navigate = useApp((s) => s.navigate)
  const maximized = useApp((s) => s.maximized)
  const project = useProject((s) => s.project)
  const dirty = useProject((s) => s.dirty)
  const saving = useProject((s) => s.saving)
  const closeProject = useProject((s) => s.close)

  const goHome = (): void => {
    if (route.name === 'editor') closeProject()
    navigate({ name: 'home' })
  }

  return (
    <div className="drag h-10 flex items-center justify-between select-none shrink-0 border-b border-line" style={{ background: 'linear-gradient(180deg,#12131c,#0f1017)' }}>
      <div className={cn('flex items-center gap-1 h-full', isMac ? 'pl-[88px]' : 'pl-3')}>
        <div className="flex items-center gap-2 pr-3 mr-1 border-r border-line h-5">
          <Logo />
          <span className="text-[12.5px] font-semibold tracking-tight">Framewave</span>
        </div>
        {route.name !== 'home' && (
          <button className="no-drag btn btn-ghost btn-sm gap-1 text-fg-2" onClick={goHome}>
            <ChevronLeft size={14} /> Library
          </button>
        )}
        {route.name === 'editor' && project && (
          <div className="no-drag flex items-center gap-2 ml-1">
            <span className="text-fg-3">/</span>
            <ProjectName />
            <span className={cn('text-[10.5px] px-1.5 py-0.5 rounded-md', saving ? 'text-warn bg-warn/10' : dirty ? 'text-fg-3 bg-white/5' : 'text-ok bg-ok/10')}>{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
          </div>
        )}
      </div>
      <div className="flex items-center h-full">
        <div className="no-drag flex items-center gap-0.5 mr-2">
          <NavBtn icon={<Home size={14} />} label="Library" active={route.name === 'home'} onClick={goHome} />
          <NavBtn
            icon={<Circle size={14} className="text-danger" fill="currentColor" />}
            label={recorder.active ? 'Recording…' : 'Record'}
            active={route.name === 'record'}
            onClick={() => {
              if (route.name === 'editor') closeProject()
              navigate({ name: 'record' })
            }}
          />
          <NavBtn icon={<Settings size={14} />} label="Settings" active={route.name === 'settings'} onClick={() => navigate({ name: 'settings' })} />
        </div>
        {!isMac && (
        <div className="no-drag flex h-full">
          <WinBtn onClick={() => fw.window.minimize()} label="Minimize">
            <Minus size={14} />
          </WinBtn>
          <WinBtn onClick={() => fw.window.maximize()} label={maximized ? 'Restore' : 'Maximize'}>
            {maximized ? <Copy size={12} className="-scale-x-100" /> : <Square size={12} />}
          </WinBtn>
          <WinBtn onClick={() => fw.window.close()} label="Close" danger>
            <X size={15} />
          </WinBtn>
        </div>
        )}
      </div>
    </div>
  )
}

function ProjectName(): React.JSX.Element {
  const project = useProject((s) => s.project)!
  const rename = useProject((s) => s.rename)
  const [editing, setEditing] = React.useState(false)
  const [val, setVal] = React.useState(project.name)
  React.useEffect(() => setVal(project.name), [project.name])
  if (editing)
    return (
      <input
        autoFocus
        className="input h-6 w-56 text-[12.5px]"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (val.trim() && val !== project.name) void rename(val.trim())
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setVal(project.name)
            setEditing(false)
          }
        }}
      />
    )
  return (
    <button className="text-[12.5px] font-medium hover:bg-white/5 rounded px-1.5 py-0.5 max-w-[320px] truncate" onDoubleClick={() => setEditing(true)} onClick={() => setEditing(true)} title="Rename">
      {project.name}
    </button>
  )
}

function NavBtn({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button className={cn('btn btn-ghost btn-sm gap-1.5', active && '!bg-white/[0.07]')} onClick={onClick}>
      {icon}
      <span className="text-[12px]">{label}</span>
    </button>
  )
}

function WinBtn({ children, onClick, label, danger }: { children: React.ReactNode; onClick: () => void; label: string; danger?: boolean }): React.JSX.Element {
  return (
    <button aria-label={label} onClick={onClick} className={cn('w-11 h-full grid place-items-center text-fg-2 hover:text-fg transition-colors', danger ? 'hover:bg-[#e81123] hover:!text-white' : 'hover:bg-white/[0.07]')}>
      {children}
    </button>
  )
}

export function Logo({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6d4cf5" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#lg)" />
      <path d="M9 21c2.5-6 4.5-9 7-9s4.5 3 7 9" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.95" />
      <circle cx="16" cy="12" r="1.8" fill="white" />
    </svg>
  )
}
