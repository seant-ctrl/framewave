import { fw, projectMediaUrl } from '@/lib/fw'
import { computePeaks } from '@/engine/audio'
import { videoDuration } from '@/engine/timeline'
import { useProject } from '@/store/projectStore'
import { useApp } from '@/store/appStore'
import { uid } from '@/lib/utils'
import { usePlayer } from '@/store/playerStore'
import type { Clip, AudioClip } from '@shared/types'

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
    const playhead = usePlayer.getState().time
    store.mutate((p) => {
      p.recording = { ...p.recording, media: [...(p.recording.media ?? []), ...assets] }
      // Audio files become independent blocks on the Audio track, starting at the playhead
      const audioAssets = assets.filter((a) => a.kind === 'audio')
      let cursor = playhead
      const videoEnd = videoDuration(p.timeline)
      const newAudio: AudioClip[] = audioAssets.map((a) => {
        const full = a.durationMs ?? 10000
        // A track longer than the remaining video is trimmed to the video's end (drag its edge to extend it)
        const fit = videoEnd > cursor + 1000 ? Math.min(full, videoEnd - cursor) : full
        const ac: AudioClip = { id: uid('audio'), sourceId: a.id!, sourceStart: 0, sourceEnd: fit, start: cursor, volume: 0.8, muted: false, fadeIn: 0, fadeOut: 0, name: a.name }
        cursor += ac.sourceEnd
        return ac
      })
      if (newAudio.length) p.timeline = { ...p.timeline, audioClips: [...(p.timeline.audioClips ?? []), ...newAudio] }
      const visual = assets.filter((a) => a.kind !== 'audio')
      const newClips: Clip[] = visual.map((a) => ({
        id: uid('clip'),
        sourceId: a.id,
        sourceStart: 0,
        sourceEnd: a.durationMs ?? 4000,
        speed: 1,
        fit: 'cover',
        transitionIn: { type: 'fade', durationMs: 500 }
      }))
      if (newClips.length) {
        const clips = [...p.timeline.clips]
        const at = insertIndex == null ? clips.length : Math.max(0, Math.min(clips.length, insertIndex))
        clips.splice(at, 0, ...newClips)
        if (clips[0]?.transitionIn) clips[0] = { ...clips[0], transitionIn: undefined }
        p.timeline = { ...p.timeline, clips }
      }
      // A project that started as a plain recording keeps its dimensions; a fresh montage takes the first video's
      if (!p.recording.screen && (!p.recording.width || !p.recording.height)) {
        const first = assets.find((a) => a.kind === 'video') ?? assets[0]
        p.recording.width = first.width ?? 1920
        p.recording.height = first.height ?? 1080
      }
    })
    app.updateToast(toastId, { kind: 'success', title: `Added ${assets.length} item${assets.length > 1 ? 's' : ''}`, message: undefined, progress: 1 })
    // Waveforms for the new assets (the editor only computes them on open)
    void (async () => {
      const dir = store.project?.dir
      if (!dir) return
      for (const a of assets) {
        if (!a.id || !a.hasAudio) continue
        const peaks = await computePeaks(projectMediaUrl(dir, a.file), 3000)
        const cur = useProject.getState()
        if (peaks && cur.project?.id === projectId) cur.mutate((np) => (np.peaks = { ...(np.peaks ?? {}), [a.id!]: peaks }), { history: false })
      }
    })()
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
  return out.filter((p) => /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp|gif|mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(p))
}
