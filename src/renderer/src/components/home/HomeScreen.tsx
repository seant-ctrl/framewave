import React, { useEffect, useState } from 'react'
import { Circle, Import, MoreHorizontal, Trash2, FolderOpen, Copy, Pencil, Search, Film, Clock } from 'lucide-react'
import type { ProjectSummary } from '@shared/types'
import { fw } from '@/lib/fw'
import { useApp } from '@/store/appStore'
import { cn, formatDuration, relativeDate } from '@/lib/utils'
import { EmptyState, Modal } from '../ui/ui'

export function HomeScreen(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null)
  const [importing, setImporting] = useState<{ label: string; progress: number } | null>(null)
  const navigate = useApp((s) => s.navigate)
  const toast = useApp((s) => s.toast)

  const refresh = async (): Promise<void> => setProjects(await fw.projects.list())
  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const importVideo = async (path?: string): Promise<void> => {
    setImporting({ label: 'Importing', progress: 0 })
    const unsub = fw.projects.onProgress((p) => p.id === 'import' && setImporting({ label: p.label, progress: p.progress }))
    try {
      const p = await fw.projects.import(path)
      if (p) navigate({ name: 'editor', projectId: p.id })
    } catch (e) {
      toast({ kind: 'error', title: 'Import failed', message: (e as Error).message })
    } finally {
      unsub()
      setImporting(null)
    }
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (!f) return
    const path = (window as unknown as { webUtils?: { getPathForFile(f: File): string } }).webUtils?.getPathForFile(f) ?? (f as unknown as { path?: string }).path
    if (path) await importVideo(path)
    else await importVideo()
  }

  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="h-full overflow-y-auto" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        {/* Hero */}
        <div className="grid grid-cols-[1.4fr_1fr] gap-4 mb-10">
          <button
            onClick={() => navigate({ name: 'record' })}
            className="group relative overflow-hidden rounded-2xl p-6 text-left border border-white/10 transition-transform hover:scale-[1.01]"
            style={{ background: 'radial-gradient(120% 140% at 0% 0%, rgba(124,92,255,0.55), rgba(124,92,255,0.08) 45%, rgba(16,17,26,1) 100%)' }}
          >
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-accent-2 font-semibold">
              <Circle size={10} fill="currentColor" className="text-danger" /> New recording
            </div>
            <div className="text-[26px] font-semibold tracking-tight mt-2 leading-tight">
              Record your screen,
              <br />
              camera & audio
            </div>
            <div className="text-fg-2 text-[13px] mt-2 max-w-[360px]">Automatic zoom on clicks, smooth cursor, keystrokes, beautiful backgrounds — polish it all in the editor after.</div>
            <div className="mt-5 inline-flex items-center gap-2 btn btn-primary btn-lg">Start recording</div>
            <kbd className="absolute right-5 bottom-5 opacity-70">Ctrl Shift R</kbd>
          </button>
          <button onClick={() => void importVideo()} className="rounded-2xl p-6 text-left card hover:border-white/20 transition-colors flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-fg-3 font-semibold">
                <Import size={12} /> Import
              </div>
              <div className="text-[20px] font-semibold tracking-tight mt-2 leading-tight">Edit an existing video</div>
              <div className="text-fg-2 text-[13px] mt-2">MP4, MOV, WebM, MKV… Drop a file anywhere on this page.</div>
            </div>
            <div className="mt-4 text-[12px] text-fg-3 flex items-center gap-1.5">
              <Film size={13} /> Backgrounds, crop, captions, text, export
            </div>
          </button>
        </div>

        {/* Library */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-semibold">Library</h2>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
            <input className="input h-8 w-60 pl-7" placeholder="Search recordings" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>

        {projects === null ? (
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-video rounded-xl shimmer" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="card">
            <EmptyState icon={<Film size={20} />} title={query ? 'No matches' : 'No recordings yet'} description={query ? 'Try a different search.' : 'Your recordings and imported videos will appear here.'} />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {filtered.map((p) => (
              <div
                key={p.id}
                className="group card overflow-hidden cursor-pointer hover:border-white/20 transition-colors"
                onClick={() => navigate({ name: 'editor', projectId: p.id })}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ id: p.id, x: e.clientX, y: e.clientY })
                }}
              >
                <div className="aspect-video bg-bg-1 relative overflow-hidden">
                  {p.thumbnail ? <img src={fw.mediaUrl(p.thumbnail) + `?t=${p.updatedAt}`} className="w-full h-full object-cover" alt="" /> : <div className="w-full h-full grid place-items-center text-fg-3"><Film size={22} /></div>}
                  <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded-md bg-black/70 text-[11px] font-mono flex items-center gap-1">
                    <Clock size={10} /> {formatDuration(p.durationMs)}
                  </div>
                  {p.width > 0 && <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-black/60 text-[10.5px] text-fg-2">{p.height >= 2000 ? '4K' : p.height >= 1400 ? '1440p' : p.height >= 1000 ? '1080p' : `${p.height}p`}</div>}
                </div>
                <div className="p-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium truncate">{p.name}</div>
                    <div className="text-[11px] text-fg-3 mt-0.5">{relativeDate(p.updatedAt)}</div>
                  </div>
                  <button
                    className="btn btn-ghost btn-icon !h-7 !w-7 opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenu({ id: p.id, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {menu && (
        <div className="fixed z-50 card p-1 w-48 fade-in" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 200), boxShadow: 'var(--shadow-pop)' }} onClick={(e) => e.stopPropagation()}>
          {(() => {
            const p = projects?.find((x) => x.id === menu.id)
            if (!p) return null
            const item = (icon: React.ReactNode, label: string, onClick: () => void, danger?: boolean): React.JSX.Element => (
              <button
                className={cn('w-full flex items-center gap-2 px-2.5 h-8 rounded-md text-[12.5px] hover:bg-white/[0.06]', danger && 'text-danger')}
                onClick={() => {
                  setMenu(null)
                  onClick()
                }}
              >
                {icon} {label}
              </button>
            )
            return (
              <>
                {item(<Pencil size={13} />, 'Rename', () => setRenaming(p))}
                {item(<Copy size={13} />, 'Duplicate', async () => {
                  await fw.projects.duplicate(p.id)
                  await refresh()
                })}
                {item(<FolderOpen size={13} />, 'Show files', () => void fw.projects.openFolder(p.id))}
                <div className="h-px bg-line my-1" />
                {item(<Trash2 size={13} />, 'Delete', () => setConfirmDelete(p), true)}
              </>
            )
          })()}
        </div>
      )}

      <Modal open={!!renaming} onClose={() => setRenaming(null)} title="Rename recording" width={420}>
        {renaming && (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              const v = (new FormData(e.currentTarget).get('name') as string).trim()
              if (v) await fw.projects.rename(renaming.id, v)
              setRenaming(null)
              await refresh()
            }}
            className="flex gap-2"
          >
            <input name="name" autoFocus defaultValue={renaming.name} className="input" />
            <button className="btn btn-primary">Save</button>
          </form>
        )}
      </Modal>

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete recording?"
        width={420}
        footer={
          <>
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={async () => {
                if (confirmDelete) await fw.projects.delete(confirmDelete.id)
                setConfirmDelete(null)
                await refresh()
              }}
            >
              Delete permanently
            </button>
          </>
        }
      >
        <p className="text-[13px] text-fg-2">
          This removes <b className="text-fg">{confirmDelete?.name}</b> and all of its media files from disk. This cannot be undone.
        </p>
      </Modal>

      <Modal open={!!importing} onClose={() => {}} title="Importing video" width={420}>
        <div className="text-[13px] text-fg-2 mb-3">{importing?.label}…</div>
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((importing?.progress ?? 0) * 100)}%` }} />
        </div>
      </Modal>
    </div>
  )
}
