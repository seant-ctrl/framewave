import { create } from 'zustand'
import type { AppSettings } from '@shared/types'
import { fw } from '@/lib/fw'
import { uid } from '@/lib/utils'

export type Route = { name: 'home' } | { name: 'record' } | { name: 'editor'; projectId: string } | { name: 'settings' }

export interface Toast {
  id: string
  title: string
  message?: string
  kind: 'info' | 'success' | 'error' | 'progress'
  progress?: number
  timeout?: number
  action?: { label: string; onClick: () => void }
}

interface AppState {
  route: Route
  settings: AppSettings | null
  toasts: Toast[]
  maximized: boolean
  navigate(r: Route): void
  loadSettings(): Promise<void>
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  toast(t: Omit<Toast, 'id'> & { id?: string }): string
  updateToast(id: string, patch: Partial<Toast>): void
  dismissToast(id: string): void
  setMaximized(v: boolean): void
}

export const useApp = create<AppState>((set, get) => ({
  route: { name: 'home' },
  settings: null,
  toasts: [],
  maximized: false,
  navigate(route) {
    set({ route })
  },
  async loadSettings() {
    const settings = await fw.settings.get()
    set({ settings })
  },
  async updateSettings(patch) {
    const settings = await fw.settings.set(patch)
    set({ settings })
    if (patch.hotkeys) fw.settings.updateHotkeys(settings.hotkeys)
  },
  toast(t) {
    const id = t.id ?? uid('toast')
    const toast: Toast = { ...t, id }
    set((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== id), toast] }))
    const timeout = t.timeout ?? (t.kind === 'progress' ? 0 : t.kind === 'error' ? 7000 : 3500)
    if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout)
    return id
  },
  updateToast(id, patch) {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    if (patch.kind && patch.kind !== 'progress') {
      const timeout = patch.timeout ?? (patch.kind === 'error' ? 7000 : 3500)
      setTimeout(() => get().dismissToast(id), timeout)
    }
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  setMaximized(maximized) {
    set({ maximized })
  }
}))
