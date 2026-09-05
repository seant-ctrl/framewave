import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import type { AppSettings } from '@shared/types'

const defaults = (): AppSettings => ({
  projectsDir: join(app.getPath('videos'), 'Framewave'),
  defaultRecording: { fps: 60, quality: 'high', systemAudio: true, countdown: 3, cursorCapture: true },
  defaultRender: {},
  theme: 'dark',
  accent: '#7c5cff',
  hardwareAcceleration: true,
  hotkeys: { toggleRecord: 'CommandOrControl+Shift+R', pauseResume: 'CommandOrControl+Shift+P' },
  openEditorAfterRecord: true,
  telemetry: false
})

let cache: AppSettings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): AppSettings {
  if (cache) return cache
  let stored: Partial<AppSettings> = {}
  try {
    if (existsSync(file())) stored = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<AppSettings>
  } catch (e) {
    console.warn('settings unreadable, using defaults', e)
  }
  const d = defaults()
  cache = {
    ...d,
    ...stored,
    defaultRecording: { ...d.defaultRecording, ...(stored.defaultRecording ?? {}) },
    hotkeys: { ...d.hotkeys, ...(stored.hotkeys ?? {}) }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  cache = next
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
    renameSync(tmp, file())
  } catch (e) {
    console.error('failed to save settings', e)
  }
  return next
}
