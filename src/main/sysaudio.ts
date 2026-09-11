/**
 * macOS system-audio capture via the bundled `fw-sysaudio` helper
 * (ScreenCaptureKit, see native/mac/sysaudio.swift). Windows uses Chromium's
 * loopback capture instead, so this module is a no-op there.
 */
import { spawn, ChildProcess } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

let proc: ChildProcess | null = null
let exitPromise: Promise<void> | null = null

export function helperPath(): string | null {
  if (process.platform !== 'darwin') return null
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'fw-sysaudio')]
    : [join(app.getAppPath(), 'native', 'mac', 'build', 'fw-sysaudio'), join(process.cwd(), 'native', 'mac', 'build', 'fw-sysaudio')]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function available(): boolean {
  if (process.platform !== 'darwin') return false
  // ScreenCaptureKit audio needs macOS 13 (Darwin 22)
  const major = Number(require('os').release().split('.')[0])
  return major >= 22 && helperPath() !== null
}

/** Start capturing to `outFile`. Resolves once the helper reports it is capturing. */
export async function start(outFile: string): Promise<void> {
  if (proc) await stop()
  const bin = helperPath()
  if (!bin) throw new Error('System audio helper not available on this platform')
  const child = spawn(bin, [outFile], { stdio: ['pipe', 'pipe', 'pipe'] })
  proc = child
  exitPromise = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('System audio helper did not start in time')), 8000)
    child.stdout?.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('ready')) {
          clearTimeout(timer)
          resolve()
        } else if (line.startsWith('error')) {
          clearTimeout(timer)
          reject(new Error(line.slice(6).trim() || 'System audio capture failed'))
        } else if (line.startsWith('done')) {
          console.log('[sysaudio]', line)
        }
      }
    })
    child.stderr?.on('data', (d) => console.warn('[sysaudio]', d.toString().trim()))
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code && code !== 0) reject(new Error(`System audio helper exited with code ${code}`))
    })
    child.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

export function pause(): void {
  proc?.kill('SIGUSR1')
}

export function resume(): void {
  proc?.kill('SIGUSR2')
}

/** Stop capturing and wait for the WAV to be finalized. */
export async function stop(): Promise<void> {
  const p = proc
  if (!p) return
  proc = null
  try {
    p.stdin?.write('stop\n')
    p.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  const timeout = new Promise<void>((r) => setTimeout(r, 5000))
  await Promise.race([exitPromise ?? Promise.resolve(), timeout])
  if (p.exitCode == null) p.kill('SIGKILL')
  exitPromise = null
}
