import { app } from 'electron'

export const is = {
  get dev(): boolean {
    return !app.isPackaged
  }
}

export function toRendererError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
