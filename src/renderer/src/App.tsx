import React, { useEffect } from 'react'
import { useApp } from '@/store/appStore'
import { TitleBar } from '@/components/TitleBar'
import { Toasts } from '@/components/Toasts'
import { HomeScreen } from '@/components/home/HomeScreen'
import { RecorderScreen } from '@/components/recorder/RecorderScreen'
import { Editor } from '@/components/editor/Editor'
import { SettingsScreen } from '@/components/SettingsScreen'
import { fw } from '@/lib/fw'
import { recorder } from '@/recorder/recorder'
import { useProject } from '@/store/projectStore'
import { usePlayer } from '@/store/playerStore'

if (import.meta.env.DEV) {
  void Promise.all([import('@/engine/zoom'), import('@/engine/compositor'), import('@/export/exporter')]).then(([zoom, comp, exp]) => {
    ;(window as unknown as { __fw: unknown }).__fw = { useApp, useProject, usePlayer, recorder, fw, zoom, comp, exp }
  })
}

export function App(): React.JSX.Element {
  const route = useApp((s) => s.route)
  const loadSettings = useApp((s) => s.loadSettings)
  const setMaximized = useApp((s) => s.setMaximized)
  const navigate = useApp((s) => s.navigate)
  const toast = useApp((s) => s.toast)

  useEffect(() => {
    void loadSettings()
    void fw.window.isMaximized().then(setMaximized)
    const unsub = fw.window.onState((s) => setMaximized(s.maximized))
    // Global hotkeys from main
    const unsubHk = fw.app.onHotkey((k) => {
      if (k === 'toggle-record') {
        if (recorder.active) void recorder.stop()
        else navigate({ name: 'record' })
      } else if (k === 'pause-resume' && recorder.active) recorder.togglePause()
    })
    // Recording finished → open editor
    recorder.onDone = (project) => {
      toast({ kind: 'success', title: 'Recording saved', message: project.name })
      navigate({ name: 'editor', projectId: project.id })
    }
    recorder.onCancelled = () => toast({ kind: 'info', title: 'Recording discarded' })
    return () => {
      unsub()
      unsubHk()
    }
  }, [loadSettings, setMaximized, navigate, toast])

  // Prevent default browser drag/drop navigation
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  return (
    <div className="h-full flex flex-col bg-bg text-fg">
      <TitleBar />
      <div className="flex-1 min-h-0 relative">
        {route.name === 'home' && <HomeScreen />}
        {route.name === 'record' && <RecorderScreen />}
        {route.name === 'editor' && <Editor key={route.projectId} projectId={route.projectId} />}
        {route.name === 'settings' && <SettingsScreen />}
      </div>
      <Toasts />
    </div>
  )
}
