import { fw } from '@/lib/fw'
import { useProject } from '@/store/projectStore'
import { useApp } from '@/store/appStore'
import { uid } from '@/lib/utils'
import type { Clip } from '@shared/types'

/**
 * Import media files into the open project and append them as clips.
 * Returns the number of clips added. Shows a progress toast.
 */
export async function addMediaToProject(projectId: string, files?: string[], insertIndex?: number): Promise<number> {
  const app = useApp.getState()
  const toastId = app.toast({ kind: 'progress', title: 'Importing media…', progress: 0 })
  const unsub = fw.projects.onProgress((p) => {
    if (p.id === projectId) app.updateToast(toastId, { message: p.label, progress: p.progress })
  })
  try {
    const assets = await fw.projects.addMedia(projectId, files)
    if (assets.length === 0) {
      app.dismissToast(toastId)
      return 0
    }
    const store = useProject.getState()
    store.mutate((p) => {
      p.recording = { ...p.recording, media: [...(p.recording.media ?? []), ...assets] }
      const newClips: Clip[] = assets.map((a) => ({
        id: uid('clip'),
        sourceId: a.id,
        sourceStart: 0,
        sourceEnd: a.durationMs ?? 4000,
        speed: 1,
        fit: 'cover',
        transitionIn: { type: 'fade', durationMs: 500 }
      }))
      const clips = [...p.timeline.clips]
      const at = insertIndex == null ? clips.length : Math.max(0, Math.min(clips.length, insertIndex))
      clips.splice(at, 0, ...newClips)
      if (clips[0]?.transitionIn) clips[0] = { ...clips[0], transitionIn: undefined }
      p.timeline = { ...p.timeline, clips }
      // A project that started as a plain recording keeps its dimensions; a fresh montage takes the first video's
      if (!p.recording.screen && (!p.recording.width || !p.recording.height)) {
        const first = assets.find((a) => a.kind === 'video') ?? assets[0]
        p.recording.width = first.width ?? 1920
        p.recording.height = first.height ?? 1080
      }
    })
    app.updateToast(toastId, { kind: 'success', title: `Added ${assets.length} clip${assets.length > 1 ? 's' : ''}`, message: undefined, progress: 1 })
    return assets.length
  } catch (e) {
    app.updateToast(toastId, { kind: 'error', title: 'Import failed', message: (e as Error).message })
    throw e
  } finally {
    unsub()
  }
}

/** Resolve absolute paths for dropped files (Electron's webUtils). */
export function pathsFromDrop(e: React.DragEvent | DragEvent): string[] {
  const dt = 'dataTransfer' in e ? e.dataTransfer : null
  if (!dt) return []
  const out: string[] = []
  for (const f of Array.from(dt.files)) {
    try {
      const p = fw.pathForFile(f)
      if (p) out.push(p)
    } catch {
      /* ignore */
    }
  }
  return out.filter((p) => /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp|gif)$/i.test(p))
}
