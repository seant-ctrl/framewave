/**
 * Global input tracker used during recording. Records cursor motion, clicks,
 * scrolls and keystrokes with wall-clock timestamps, normalized to the capture
 * rectangle (physical pixels). Uses uiohook-napi for global hooks and koffi to
 * query window geometry through Win32 (DWM extended frame bounds).
 */
import { screen } from 'electron'
import type { Rect, RecordingEvents, ClickEvent, KeyEvent, CursorSample, CursorKind } from '@shared/types'

type PhysRect = Rect

export interface TrackerTarget {
  kind: 'display' | 'window' | 'region'
  displayId?: number
  hwnd?: number
  /** DIP region relative to the display's bounds (region mode) */
  region?: Rect
  /** Replace system cursors with invisible ones while tracking */
  hideCursor?: boolean
}

interface Hook {
  on(ev: string, cb: (e: any) => void): void
  removeAllListeners(): void
  start(): void
  stop(): void
}

let hook: Hook | null = null
let keyNames: Record<number, string> = {}

function loadHook(): Hook | null {
  if (hook) return hook
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi')
    hook = mod.uIOhook as Hook
    const map = mod.UiohookKey as Record<string, number>
    keyNames = {}
    for (const [name, code] of Object.entries(map)) keyNames[code] = name
    return hook
  } catch (e) {
    console.warn('[tracker] uiohook unavailable:', e)
    return null
  }
}

// ── Win32 window rect via koffi ─────────────────────────────────────────────

let getWindowRect: ((hwnd: number) => PhysRect | null) | null = null

// Cursor control (Win32)
interface CursorApi {
  hideAll(): boolean
  restore(): void
  currentKind(): CursorKind | null
}
let cursorApi: CursorApi | null = null
let cursorsHidden = false

// OCR_* ids → shape
const OCR: Array<[number, CursorKind]> = [
  [32512, 'arrow'], // OCR_NORMAL
  [32513, 'ibeam'], // OCR_IBEAM
  [32514, 'wait'], // OCR_WAIT
  [32515, 'cross'], // OCR_CROSS
  [32516, 'arrow'], // OCR_UP
  [32642, 'resize-d'], // OCR_SIZENWSE
  [32643, 'resize-d'], // OCR_SIZENESW
  [32644, 'resize-h'], // OCR_SIZEWE
  [32645, 'resize-v'], // OCR_SIZENS
  [32646, 'move'], // OCR_SIZEALL
  [32648, 'no'], // OCR_NO
  [32649, 'hand'], // OCR_HAND
  [32650, 'arrow'] // OCR_APPSTARTING
]

function loadWin32(): void {
  if (getWindowRect || process.platform !== 'win32') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const RECT = koffi.struct('FW_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const dwmapi = koffi.load('dwmapi.dll')
    const user32 = koffi.load('user32.dll')
    const DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr hwnd, uint32 attr, _Out_ FW_RECT* rect, uint32 size)')
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ FW_RECT* rect)')
    const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)')

    // ── cursor api ──
    try {
      const CURSORINFO = koffi.struct('FW_CURSORINFO', { cbSize: 'uint32', flags: 'uint32', hCursor: 'intptr', x: 'long', y: 'long' })
      const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ FW_CURSORINFO* pci)')
      const LoadCursorW = user32.func('intptr __stdcall LoadCursorW(intptr hInstance, intptr lpCursorName)')
      const CopyImage = user32.func('intptr __stdcall CopyImage(intptr h, uint32 type, int cx, int cy, uint32 flags)')
      const CreateCursor = user32.func('intptr __stdcall CreateCursor(intptr hInst, int xHotSpot, int yHotSpot, int nWidth, int nHeight, const uint8* pvANDPlane, const uint8* pvXORPlane)')
      const SetSystemCursor = user32.func('bool __stdcall SetSystemCursor(intptr hcur, uint32 id)')
      const SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, intptr pvParam, uint32 fWinIni)')
      const DestroyCursor = user32.func('bool __stdcall DestroyCursor(intptr hCursor)')
      // handle → kind for the *original* system cursors (for shape detection while visible)
      const originalKinds = new Map<number, CursorKind>()
      for (const [id, kind] of OCR) {
        try {
          const h = LoadCursorW(0, id) as number
          if (h) originalKinds.set(Number(h), kind)
        } catch {
          /* ignore */
        }
      }
      const blankKinds = new Map<number, CursorKind>()
      const blanks: number[] = []
      cursorApi = {
        hideAll: () => {
          if (cursorsHidden) return true
          let ok = false
          for (const [id, kind] of OCR) {
            try {
              // 32x32 monochrome: AND mask all 1 (transparent), XOR mask all 0
              const and = Buffer.alloc(32 * 32 / 8, 0xff)
              const xor = Buffer.alloc(32 * 32 / 8, 0x00)
              const blank = CreateCursor(0, 0, 0, 32, 32, and, xor) as number
              if (!blank) continue
              blankKinds.set(Number(blank), kind)
              blanks.push(Number(blank))
              // SetSystemCursor destroys the cursor handle it receives, so pass a copy
              const copy = CopyImage(blank, 2 /*IMAGE_CURSOR*/, 0, 0, 0) as number
              if (SetSystemCursor(copy || blank, id)) ok = true
            } catch (e) {
              console.warn('[cursor] hide failed for', id, e)
            }
          }
          cursorsHidden = ok
          return ok
        },
        restore: () => {
          try {
            SystemParametersInfoW(0x0057 /*SPI_SETCURSORS*/, 0, 0, 0)
          } catch (e) {
            console.warn('[cursor] restore failed', e)
          }
          for (const b of blanks) {
            try {
              DestroyCursor(b)
            } catch {
              /* ignore */
            }
          }
          blanks.length = 0
          blankKinds.clear()
          cursorsHidden = false
        },
        currentKind: () => {
          try {
            const ci = { cbSize: 24, flags: 0, hCursor: 0, x: 0, y: 0 }
            if (!GetCursorInfo(ci)) return null
            const h = Number(ci.hCursor)
            if (!h) return null
            // While hidden, GetCursorInfo reports the *system* cursor handle (our replacement)
            return blankKinds.get(h) ?? originalKinds.get(h) ?? null
          } catch {
            return null
          }
        }
      }
    } catch (e) {
      console.warn('[tracker] cursor api unavailable:', e)
    }
    getWindowRect = (hwnd: number) => {
      try {
        if (IsIconic(hwnd)) return null
        const r: { left: number; top: number; right: number; bottom: number } = { left: 0, top: 0, right: 0, bottom: 0 }
        // DWMWA_EXTENDED_FRAME_BOUNDS = 9 → visible frame without invisible borders
        const hr = DwmGetWindowAttribute(hwnd, 9, r, 16)
        if (hr !== 0) {
          if (!GetWindowRect(hwnd, r)) return null
        }
        return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
      } catch {
        return null
      }
    }
  } catch (e) {
    console.warn('[tracker] koffi unavailable:', e)
  }
}

export function windowRect(hwnd: number): PhysRect | null {
  loadWin32()
  return getWindowRect ? getWindowRect(hwnd) : null
}

/** Make sure system cursors are visible (call on app start/quit as a safety net). */
export function restoreSystemCursors(): void {
  loadWin32()
  cursorApi?.restore()
}

// ── Tracking session ────────────────────────────────────────────────────────

class Session {
  events: RecordingEvents = { cursor: [], clicks: [], keys: [], scrolls: [] }
  rect: PhysRect
  private timer: NodeJS.Timeout | null = null
  private lastMoveT = 0
  private pressed = new Set<string>()

  private poll: NodeJS.Timeout | null = null
  private lastPoll: { x: number; y: number } | null = null
  private lastKind: CursorKind | null = null
  private kindTick = 0

  constructor(private target: TrackerTarget) {
    this.rect = this.computeRect() ?? { x: 0, y: 0, width: 1, height: 1 }
    loadWin32()
    if (target.hideCursor && cursorApi) {
      if (!cursorApi.hideAll()) console.warn('[tracker] could not hide system cursor')
    }
    if (target.kind === 'window') {
      this.timer = setInterval(() => {
        const r = this.computeRect()
        if (r && r.width > 0 && r.height > 0) this.rect = r
      }, 200)
    }
    // Polling fallback: catches programmatic cursor moves and works without the hook.
    this.poll = setInterval(() => {
      try {
        const now = Date.now()
        // Cursor shape (every ~50ms)
        if (cursorApi && ++this.kindTick % 4 === 0) {
          const k = cursorApi.currentKind()
          if (k && k !== this.lastKind) {
            this.lastKind = k
            const p0 = screen.dipToScreenPoint(screen.getCursorScreenPoint())
            const n0 = this.norm(p0.x, p0.y)
            this.events.cursor.push({ t: now, x: n0.x, y: n0.y, k })
            this.lastMoveT = now
            return
          }
        }
        const p = screen.dipToScreenPoint(screen.getCursorScreenPoint())
        if (this.lastPoll && this.lastPoll.x === p.x && this.lastPoll.y === p.y) return
        this.lastPoll = p
        if (now - this.lastMoveT < 6) return
        this.lastMoveT = now
        const n = this.norm(p.x, p.y)
        this.events.cursor.push({ t: now, x: n.x, y: n.y })
      } catch {
        /* ignore */
      }
    }, 1000 / 90)
  }

  private computeRect(): PhysRect | null {
    const t = this.target
    if (t.kind === 'window' && t.hwnd) {
      return windowRect(t.hwnd)
    }
    const display = t.displayId != null ? screen.getAllDisplays().find((d) => d.id === t.displayId) : screen.getPrimaryDisplay()
    if (!display) return null
    const phys = screen.dipToScreenRect(null, display.bounds)
    if (t.kind === 'region' && t.region) {
      const s = display.scaleFactor
      return {
        x: phys.x + Math.round(t.region.x * s),
        y: phys.y + Math.round(t.region.y * s),
        width: Math.round(t.region.width * s),
        height: Math.round(t.region.height * s)
      }
    }
    return phys
  }

  norm(x: number, y: number): { x: number; y: number } {
    const r = this.rect
    return { x: (x - r.x) / r.width, y: (y - r.y) / r.height }
  }

  onMove = (e: { x: number; y: number }): void => {
    const now = Date.now()
    if (now - this.lastMoveT < 6) return // ~150 Hz cap
    this.lastMoveT = now
    const p = this.norm(e.x, e.y)
    const s: CursorSample = { t: now, x: p.x, y: p.y }
    this.events.cursor.push(s)
  }

  onButton = (phase: 'down' | 'up') => (e: { x: number; y: number; button: number }): void => {
    const p = this.norm(e.x, e.y)
    const button: ClickEvent['button'] = e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left'
    this.events.clicks.push({ t: Date.now(), x: p.x, y: p.y, button, phase })
    // Also sample cursor here for precision
    this.events.cursor.push({ t: Date.now(), x: p.x, y: p.y })
  }

  onWheel = (e: { x: number; y: number; rotation: number }): void => {
    const p = this.norm(e.x, e.y)
    this.events.scrolls.push({ t: Date.now(), x: p.x, y: p.y, dir: e.rotation > 0 ? 'down' : 'up' })
  }

  onKeyDown = (e: { keycode: number; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): void => {
    const name = keyNames[e.keycode] ?? `Key${e.keycode}`
    if (this.pressed.has(name)) return // ignore auto-repeat
    this.pressed.add(name)
    const modifiers: KeyEvent['modifiers'] = []
    if (e.ctrlKey) modifiers.push('ctrl')
    if (e.shiftKey) modifiers.push('shift')
    if (e.altKey) modifiers.push('alt')
    if (e.metaKey) modifiers.push('meta')
    this.events.keys.push({ t: Date.now(), key: prettyKey(name), modifiers })
  }

  onKeyUp = (e: { keycode: number }): void => {
    this.pressed.delete(keyNames[e.keycode] ?? `Key${e.keycode}`)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.poll) clearInterval(this.poll)
    if (cursorsHidden) cursorApi?.restore()
    this.events.cursor.sort((a, b) => a.t - b.t)
  }
}

function prettyKey(name: string): string {
  const map: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Esc',
    Delete: 'Del',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Ctrl: 'Ctrl',
    CtrlRight: 'Ctrl',
    Shift: 'Shift',
    ShiftRight: 'Shift',
    Alt: 'Alt',
    AltRight: 'Alt',
    Meta: 'Win',
    MetaRight: 'Win',
    CapsLock: 'Caps',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`'
  }
  if (map[name]) return map[name]
  if (/^Numpad(\d)$/.test(name)) return name.replace('Numpad', '')
  if (/^[A-Z]$/.test(name)) return name
  if (/^\d$/.test(name)) return name
  return name
}

let session: Session | null = null

export function startTracking(target: TrackerTarget): boolean {
  stopTracking()
  const h = loadHook()
  session = new Session(target)
  if (!h) return false
  try {
    h.removeAllListeners()
    h.on('mousemove', session.onMove)
    h.on('mousedrag', session.onMove)
    h.on('mousedown', session.onButton('down'))
    h.on('mouseup', session.onButton('up'))
    h.on('wheel', session.onWheel)
    h.on('keydown', session.onKeyDown)
    h.on('keyup', session.onKeyUp)
    h.start()
    return true
  } catch (e) {
    console.warn('[tracker] failed to start hook:', e)
    return false
  }
}

/** Stop and return events with times relative to `startEpochMs`. */
export function stopTracking(startEpochMs?: number): RecordingEvents | null {
  if (!session) return null
  const s = session
  session = null
  s.dispose()
  try {
    hook?.removeAllListeners()
    hook?.stop()
  } catch {
    /* ignore */
  }
  if (startEpochMs == null) return s.events
  const rel = <T extends { t: number }>(arr: T[]): T[] => arr.map((e) => ({ ...e, t: e.t - startEpochMs })).filter((e) => e.t >= -50)
  return {
    cursor: rel(s.events.cursor),
    clicks: rel(s.events.clicks),
    keys: rel(s.events.keys),
    scrolls: rel(s.events.scrolls)
  }
}

export function isTracking(): boolean {
  return session !== null
}

/** Current normalized cursor position in the tracked rect (for live previews). */
export function currentCursor(): { x: number; y: number } | null {
  if (!session) return null
  const p = screen.dipToScreenPoint(screen.getCursorScreenPoint())
  return session.norm(p.x, p.y)
}
