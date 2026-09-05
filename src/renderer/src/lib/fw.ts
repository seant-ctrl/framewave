import type { FramewaveApi } from '../../../preload/index'

declare global {
  interface Window {
    fw: FramewaveApi
  }
}

export const fw: FramewaveApi = window.fw

/** Absolute path of a file inside a project directory. */
export function projectFilePath(dir: string, file: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + file : dir + sep + file
}

export function projectMediaUrl(dir: string, file: string): string {
  return fw.mediaUrl(projectFilePath(dir, file))
}
