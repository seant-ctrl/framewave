import { create } from 'zustand'

interface PlayerState {
  /** Timeline time in ms */
  time: number
  playing: boolean
  loop: boolean
  muted: boolean
  volume: number
  /** Timeline zoom: pixels per second */
  pxPerSec: number
  scrollX: number
  /** In/out points for range preview & export */
  inPoint: number | null
  outPoint: number | null
  fps: number
  setTime(t: number): void
  setPlaying(p: boolean): void
  toggle(): void
  setLoop(v: boolean): void
  setMuted(v: boolean): void
  setVolume(v: number): void
  setPxPerSec(v: number): void
  setScrollX(v: number): void
  setInOut(i: number | null, o: number | null): void
  setFps(f: number): void
}

export const usePlayer = create<PlayerState>((set, get) => ({
  time: 0,
  playing: false,
  loop: false,
  muted: false,
  volume: 1,
  pxPerSec: 60,
  scrollX: 0,
  inPoint: null,
  outPoint: null,
  fps: 0,
  setTime: (time) => set({ time: Math.max(0, time) }),
  setPlaying: (playing) => set({ playing }),
  toggle: () => set({ playing: !get().playing }),
  setLoop: (loop) => set({ loop }),
  setMuted: (muted) => set({ muted }),
  setVolume: (volume) => set({ volume }),
  setPxPerSec: (pxPerSec) => set({ pxPerSec: Math.min(2000, Math.max(4, pxPerSec)) }),
  setScrollX: (scrollX) => set({ scrollX: Math.max(0, scrollX) }),
  setInOut: (inPoint, outPoint) => set({ inPoint, outPoint }),
  setFps: (fps) => set({ fps })
}))
