import { create } from 'zustand'
import type { Project, RecordingEvents, RenderSettings, Timeline, ZoomSegment, TextOverlay, CameraSegment, CaptionSegment } from '@shared/types'
import { fw } from '@/lib/fw'
import { deepClone, debounce, uid } from '@/lib/utils'
import { timelineDuration, clampSegments } from '@/engine/timeline'

export type Selection =
  | { kind: 'none' }
  | { kind: 'clip'; id: string }
  | { kind: 'zoom'; id: string }
  | { kind: 'camera'; id: string }
  | { kind: 'text'; id: string }
  | { kind: 'caption'; id: string }
  | { kind: 'range'; start: number; end: number }

interface Snapshot {
  timeline: Timeline
  render: RenderSettings
}

interface ProjectState {
  project: Project | null
  events: RecordingEvents | null
  loading: boolean
  dirty: boolean
  saving: boolean
  history: Snapshot[]
  future: Snapshot[]
  selection: Selection
  activePanel: PanelId

  load(id: string): Promise<void>
  close(): void
  setProject(p: Project): void
  /** Apply a mutation (pushes to history). */
  mutate(fn: (p: Project) => unknown, opts?: { history?: boolean; label?: string }): void
  updateRender(patch: Partial<RenderSettings> | ((r: RenderSettings) => Partial<RenderSettings>), opts?: { history?: boolean }): void
  updateTimeline(fn: (t: Timeline) => Timeline, opts?: { history?: boolean }): void
  undo(): void
  redo(): void
  save(): Promise<void>
  setSelection(s: Selection): void
  setActivePanel(p: PanelId): void
  setEvents(e: RecordingEvents | null): void
  rename(name: string): Promise<void>

  // convenience mutators
  addZoom(z: Omit<ZoomSegment, 'id'>): string
  updateZoom(id: string, patch: Partial<ZoomSegment>, history?: boolean): void
  removeZoom(id: string): void
  addText(t: Partial<TextOverlay> & { start: number; end: number }): string
  updateText(id: string, patch: Partial<TextOverlay>, history?: boolean): void
  removeText(id: string): void
  addCameraSegment(s: Omit<CameraSegment, 'id'>): string
  updateCameraSegment(id: string, patch: Partial<CameraSegment>, history?: boolean): void
  removeCameraSegment(id: string): void
  setCaptions(c: CaptionSegment[]): void
  updateCaption(id: string, patch: Partial<CaptionSegment>): void
  removeCaption(id: string): void
}

export type PanelId = 'background' | 'screen' | 'cursor' | 'zoom' | 'camera' | 'audio' | 'text' | 'captions' | 'color' | 'keys'

const MAX_HISTORY = 120

let loadSeq = 0

export const useProject = create<ProjectState>((set, get) => {
  const scheduleSave = debounce(() => void get().save(), 900)

  const pushHistory = (): void => {
    const p = get().project
    if (!p) return
    const snap: Snapshot = { timeline: deepClone(p.timeline), render: deepClone(p.render) }
    set((s) => ({ history: [...s.history.slice(-MAX_HISTORY + 1), snap], future: [] }))
  }

  return {
    project: null,
    events: null,
    loading: false,
    dirty: false,
    saving: false,
    history: [],
    future: [],
    selection: { kind: 'none' },
    activePanel: 'background',

    async load(id) {
      // Ignore stale loads (e.g. StrictMode double-invocation or quick navigation)
      const seq = ++loadSeq
      if (get().project?.id === id && !get().loading) return
      set({ loading: true, project: null, events: null, history: [], future: [], selection: { kind: 'none' } })
      const project = await fw.projects.load(id)
      let events: RecordingEvents | null = null
      if (project.recording.events) {
        try {
          events = JSON.parse(await fw.projects.readText(id, project.recording.events)) as RecordingEvents
        } catch (e) {
          console.warn('events load failed', e)
        }
      }
      if (seq !== loadSeq) return
      set({ project, events, loading: false, dirty: false })
    },

    close() {
      const s = get()
      if (s.dirty) void s.save()
      set({ project: null, events: null, history: [], future: [], selection: { kind: 'none' } })
    },

    setProject(project) {
      set({ project })
    },

    mutate(fn, opts = {}) {
      const p = get().project
      if (!p) return
      if (opts.history !== false) pushHistory()
      const next = { ...p, timeline: { ...p.timeline }, render: { ...p.render } }
      fn(next)
      next.timeline = clampSegments(next.timeline)
      set({ project: next, dirty: true })
      scheduleSave()
    },

    updateRender(patch, opts = {}) {
      get().mutate(
        (p) => {
          const pt = typeof patch === 'function' ? patch(p.render) : patch
          p.render = { ...p.render, ...pt }
        },
        { history: opts.history }
      )
    },

    updateTimeline(fn, opts = {}) {
      get().mutate((p) => (p.timeline = fn(p.timeline)), { history: opts.history })
    },

    undo() {
      const s = get()
      if (!s.project || s.history.length === 0) return
      const prev = s.history[s.history.length - 1]
      const cur: Snapshot = { timeline: deepClone(s.project.timeline), render: deepClone(s.project.render) }
      set({
        project: { ...s.project, timeline: prev.timeline, render: prev.render },
        history: s.history.slice(0, -1),
        future: [...s.future, cur],
        dirty: true
      })
      scheduleSave()
    },

    redo() {
      const s = get()
      if (!s.project || s.future.length === 0) return
      const next = s.future[s.future.length - 1]
      const cur: Snapshot = { timeline: deepClone(s.project.timeline), render: deepClone(s.project.render) }
      set({
        project: { ...s.project, timeline: next.timeline, render: next.render },
        future: s.future.slice(0, -1),
        history: [...s.history, cur],
        dirty: true
      })
      scheduleSave()
    },

    async save() {
      const p = get().project
      if (!p) return
      set({ saving: true })
      try {
        const saved = await fw.projects.save(p)
        // keep local edits made during save
        set((s) => ({ saving: false, dirty: s.project !== p, project: s.project ? { ...s.project, updatedAt: saved.updatedAt } : s.project }))
      } catch (e) {
        console.error('save failed', e)
        set({ saving: false })
      }
    },

    setSelection(selection) {
      set({ selection })
      // auto-focus the matching panel
      if (selection.kind === 'zoom') set({ activePanel: 'zoom' })
      if (selection.kind === 'text') set({ activePanel: 'text' })
      if (selection.kind === 'camera') set({ activePanel: 'camera' })
      if (selection.kind === 'caption') set({ activePanel: 'captions' })
    },
    setActivePanel(activePanel) {
      set({ activePanel })
    },
    setEvents(events) {
      set({ events })
    },
    async rename(name) {
      const p = get().project
      if (!p) return
      set({ project: { ...p, name } })
      await fw.projects.rename(p.id, name)
    },

    addZoom(z) {
      const id = uid('zoom')
      get().updateTimeline((t) => ({ ...t, zooms: [...t.zooms, { ...z, id }].sort((a, b) => a.start - b.start) }))
      return id
    },
    updateZoom(id, patch, history = true) {
      get().updateTimeline((t) => ({ ...t, zooms: t.zooms.map((z) => (z.id === id ? { ...z, ...patch } : z)) }), { history })
    },
    removeZoom(id) {
      get().updateTimeline((t) => ({ ...t, zooms: t.zooms.filter((z) => z.id !== id) }))
      if (get().selection.kind === 'zoom') set({ selection: { kind: 'none' } })
    },

    addText(t) {
      const id = uid('text')
      const overlay: TextOverlay = {
        id,
        text: 'Your text here',
        position: { x: 0.5, y: 0.5 },
        anchor: 'center',
        fontSize: 56,
        fontFamily: 'Inter, system-ui, sans-serif',
        fontWeight: 700,
        color: '#ffffff',
        background: 'rgba(0,0,0,0.55)',
        padding: 18,
        radius: 14,
        animation: 'pop',
        align: 'center',
        shadow: true,
        ...t
      }
      get().updateTimeline((tl) => ({ ...tl, texts: [...tl.texts, overlay] }))
      return id
    },
    updateText(id, patch, history = true) {
      get().updateTimeline((t) => ({ ...t, texts: t.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), { history })
    },
    removeText(id) {
      get().updateTimeline((t) => ({ ...t, texts: t.texts.filter((x) => x.id !== id) }))
      if (get().selection.kind === 'text') set({ selection: { kind: 'none' } })
    },

    addCameraSegment(s) {
      const id = uid('cam')
      get().updateTimeline((t) => ({ ...t, camera: [...t.camera, { ...s, id }].sort((a, b) => a.start - b.start) }))
      return id
    },
    updateCameraSegment(id, patch, history = true) {
      get().updateTimeline((t) => ({ ...t, camera: t.camera.map((x) => (x.id === id ? { ...x, ...patch } : x)) }), { history })
    },
    removeCameraSegment(id) {
      get().updateTimeline((t) => ({ ...t, camera: t.camera.filter((x) => x.id !== id) }))
      if (get().selection.kind === 'camera') set({ selection: { kind: 'none' } })
    },

    setCaptions(captions) {
      get().updateTimeline((t) => ({ ...t, captions }))
    },
    updateCaption(id, patch) {
      get().updateTimeline((t) => ({ ...t, captions: t.captions.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
    },
    removeCaption(id) {
      get().updateTimeline((t) => ({ ...t, captions: t.captions.filter((c) => c.id !== id) }))
    }
  }
})

export function useDuration(): number {
  return useProject((s) => (s.project ? timelineDuration(s.project.timeline) : 0))
}
