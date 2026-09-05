// ─────────────────────────────────────────────────────────────────────────────
// Framewave shared data model
// All times are in milliseconds unless suffixed otherwise. All positions that
// describe a point inside the captured screen are normalized to 0..1.
// ─────────────────────────────────────────────────────────────────────────────

export type Vec2 = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }

// ── Capture sources ──────────────────────────────────────────────────────────

export interface CaptureSource {
  id: string // desktopCapturer id: "screen:0:0" or "window:12345:0"
  name: string
  kind: 'screen' | 'window'
  thumbnail: string // data URL
  appIcon?: string
  displayId?: string
  bounds?: Rect // DIP bounds for displays / windows (best effort)
  scaleFactor?: number
}

export interface DisplayInfo {
  id: number
  label: string
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  isPrimary: boolean
}

export interface MediaDeviceSummary {
  deviceId: string
  label: string
  kind: 'audioinput' | 'videoinput' | 'audiooutput'
}

// ── Recording ───────────────────────────────────────────────────────────────

export type RecordingMode = 'display' | 'window' | 'region'

export interface RecordingOptions {
  mode: RecordingMode
  sourceId: string
  displayId?: number
  region?: Rect // DIP coordinates relative to the display, only for mode=region
  fps: 30 | 60
  quality: 'good' | 'high' | 'ultra'
  cameraDeviceId?: string | null
  micDeviceId?: string | null
  systemAudio: boolean
  countdown: 0 | 3 | 5
  cursorCapture: boolean
  /** Replace the OS cursor with an invisible one while recording (rendered later). */
  hideSystemCursor?: boolean
}

export type CursorKind = 'arrow' | 'ibeam' | 'hand' | 'wait' | 'cross' | 'resize-h' | 'resize-v' | 'resize-d' | 'move' | 'no'

export interface CursorSample {
  t: number
  x: number
  y: number
  /** Cursor shape at this sample (only present when it changes). */
  k?: CursorKind
}
export interface ClickEvent {
  t: number
  x: number
  y: number
  button: 'left' | 'right' | 'middle'
  phase: 'down' | 'up'
}
export interface KeyEvent {
  t: number
  key: string
  modifiers: Array<'ctrl' | 'shift' | 'alt' | 'meta'>
}
export interface RecordingEvents {
  cursor: CursorSample[]
  clicks: ClickEvent[]
  keys: KeyEvent[]
  scrolls: Array<{ t: number; x: number; y: number; dir: 'up' | 'down' }>
}

export interface MediaAsset {
  file: string // file name inside the project directory
  width?: number
  height?: number
  durationMs?: number
  hasAudio?: boolean
  codec?: string
  /** Start offset (ms) of this asset relative to the screen recording start. */
  offsetMs?: number
  /** Original raw recording file, kept until finalize succeeds. */
  raw?: string
}

export interface RecordingMeta {
  mode: RecordingMode
  fps: number
  durationMs: number
  /** Native pixel size of the screen video. */
  width: number
  height: number
  /** The area of the captured display (in *video* pixels) the user asked for, if region mode. */
  crop?: Rect
  screen?: MediaAsset
  camera?: MediaAsset
  mic?: MediaAsset
  system?: MediaAsset
  /** Events file (JSON of RecordingEvents) */
  events?: string
  /** Offset between the start of the screen recording and the events clock. */
  eventsOffsetMs: number
  scaleFactor: number
  displayBounds?: Rect
  recordedAt: number
  /** Wall-clock (epoch ms) when the recording was stopped; used to align tracks. */
  stoppedAt?: number
  /** Total paused time (ms) during the recording. */
  pausedMs?: number
  /** Events file still holds absolute epoch timestamps (converted during finalize). */
  eventsAbsolute?: boolean
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface Clip {
  id: string
  /** Source time range this clip plays. */
  sourceStart: number
  sourceEnd: number
  /** Playback speed multiplier. 1 = normal. */
  speed: number
  /** Extra: transition in/out */
  fadeIn?: number
  fadeOut?: number
}

export interface ZoomSegment {
  id: string
  /** Timeline time range */
  start: number
  end: number
  /** Focus point in normalized screen coords. */
  focus: Vec2
  scale: number
  /** 'auto' segments were generated from clicks and can be regenerated. */
  origin: 'auto' | 'manual'
  /** Follow the recorded cursor while zoomed. */
  followCursor: boolean
}

export interface CameraSegment {
  id: string
  start: number
  end: number
  /** Camera visible? */
  visible: boolean
  /** Optional override of size/position in this segment. */
  size?: number
  position?: CameraPosition
  fullscreen?: boolean
}

export type TextAnimation = 'none' | 'fade' | 'slide-up' | 'pop' | 'typewriter'

export interface TextOverlay {
  id: string
  start: number
  end: number
  text: string
  /** Position of the anchor (normalized to output frame) */
  position: Vec2
  anchor: 'center' | 'top-left' | 'top' | 'top-right' | 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'
  fontSize: number // in px relative to a 1080p frame
  fontFamily: string
  fontWeight: number
  color: string
  background: string | null
  padding: number
  radius: number
  animation: TextAnimation
  align: 'left' | 'center' | 'right'
  shadow: boolean
}

export interface CaptionSegment {
  id: string
  start: number
  end: number
  text: string
}

export interface AudioTrackSettings {
  volume: number // 0..2
  muted: boolean
  /** Simple noise gate threshold in dB (null=off) */
  gate: number | null
  fadeIn: number
  fadeOut: number
}

export interface MusicTrack {
  file: string
  volume: number
  muted: boolean
  offset: number // timeline start
  loop: boolean
  durationMs?: number
}

export interface Timeline {
  clips: Clip[]
  zooms: ZoomSegment[]
  camera: CameraSegment[]
  texts: TextOverlay[]
  captions: CaptionSegment[]
  audio: {
    mic: AudioTrackSettings
    system: AudioTrackSettings
    camera: AudioTrackSettings
    music: MusicTrack | null
  }
  /** Marker positions, handy for navigation */
  markers: Array<{ id: string; t: number; label: string }>
}

// ── Render / look settings ──────────────────────────────────────────────────

export type AspectPreset = 'source' | '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '4:5'

export interface GradientStop {
  color: string
  pos: number
}

export type BackgroundSettings =
  | { type: 'color'; color: string }
  | { type: 'gradient'; angle: number; stops: GradientStop[] }
  | { type: 'image'; src: string; blur: number; dim: number }
  | { type: 'wallpaper'; id: string }
  | { type: 'blur'; blur: number; dim: number; saturate: number }
  | { type: 'transparent' }

export type CameraPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'custom'
export type CameraShape = 'circle' | 'rounded' | 'square' | 'squircle'
export type CursorStyle = 'arrow' | 'arrow-dark' | 'dot' | 'ring' | 'hand'
export type ClickEffect = 'none' | 'ripple' | 'pulse' | 'spotlight'

export interface RenderSettings {
  aspect: AspectPreset
  /** Output resolution height; width follows aspect. */
  outputHeight: 720 | 1080 | 1440 | 2160
  background: BackgroundSettings
  /** Padding around the screen as a fraction of the shorter output edge (0..0.3). */
  padding: number
  cornerRadius: number // px at 1080p
  shadow: { enabled: boolean; blur: number; opacity: number; offsetY: number; spread: number }
  border: { enabled: boolean; width: number; color: string; opacity: number }
  /** Slight 3D tilt / perspective of the screen. */
  tilt: { x: number; y: number }
  /** Additional crop on top of recording crop (normalized, applied to the video). */
  crop: Rect | null
  cursor: {
    mode: 'hidden' | 'custom'
    style: CursorStyle
    /** Switch to I-beam / hand shapes when the recording says so. */
    adaptiveShape?: boolean
    size: number // multiplier
    smoothing: number // 0..1
    clickEffect: ClickEffect
    clickColor: string
    hideWhenIdle: boolean
    idleAfterMs: number
    tint: string | null
    motionBlur: boolean
  }
  camera: {
    enabled: boolean
    shape: CameraShape
    size: number // fraction of output height (0.1..0.6)
    position: CameraPosition
    custom: Vec2 // normalized center when position === 'custom'
    mirror: boolean
    shadow: boolean
    border: { enabled: boolean; width: number; color: string }
    radius: number // for 'rounded' shape, px at 1080p
    zoom: number // 1..2 crop-zoom into camera frame
    margin: number // px at 1080p
    blurBackground: boolean
  }
  zoom: {
    autoEnabled: boolean
    defaultScale: number // 1.5..4
    transitionMs: number
    holdMs: number
    easing: 'ease-in-out' | 'spring' | 'linear' | 'ease-out-expo'
    sensitivity: 'low' | 'medium' | 'high'
    followCursor: boolean
    followSmoothing: number
  }
  keystrokes: {
    enabled: boolean
    position: 'bottom' | 'top' | 'bottom-left' | 'bottom-right'
    style: 'pill' | 'keycaps'
    size: number
    durationMs: number
    showModifiersOnly: boolean
  }
  captions: {
    enabled: boolean
    fontSize: number
    fontFamily: string
    color: string
    background: string
    position: 'bottom' | 'top'
    highlightColor: string
    maxLines: number
  }
  /** Color grading */
  color: {
    brightness: number
    contrast: number
    saturation: number
    vignette: number
  }
  /** Global motion blur amount for zoom moves (0..1) */
  motionBlur: number
}

// ── Project ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  version: 1
  createdAt: number
  updatedAt: number
  dir: string
  recording: RecordingMeta
  timeline: Timeline
  render: RenderSettings
  thumbnail?: string
  /** Precomputed audio peaks per track for waveform display */
  peaks?: Record<string, number[]>
  /** One-shot flags (e.g. auto zoom already generated) */
  flags?: Record<string, boolean>
}

export interface ProjectSummary {
  id: string
  name: string
  dir: string
  createdAt: number
  updatedAt: number
  durationMs: number
  thumbnail?: string
  width: number
  height: number
}

// ── Export ──────────────────────────────────────────────────────────────────

export type ExportFormat = 'mp4' | 'webm' | 'gif' | 'png-sequence' | 'mp3'

export interface ExportOptions {
  format: ExportFormat
  fps: 24 | 30 | 60
  height: 480 | 720 | 1080 | 1440 | 2160
  quality: 'draft' | 'good' | 'high' | 'lossless'
  /** Only export a time range (timeline ms) */
  range: { start: number; end: number } | null
  outPath: string
  includeAudio: boolean
  gif?: { loop: boolean; colors: 64 | 128 | 256; dither: boolean }
  codec?: 'h264' | 'h265' | 'av1' | 'vp9'
  hwAccel: boolean
}

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'encoding-audio' | 'muxing' | 'finalizing' | 'done' | 'error' | 'cancelled'
  progress: number // 0..1
  frame?: number
  totalFrames?: number
  fps?: number
  etaMs?: number
  message?: string
  outPath?: string
}

// ── App settings ────────────────────────────────────────────────────────────

export interface AppSettings {
  projectsDir: string
  defaultRecording: Partial<RecordingOptions>
  defaultRender: Partial<RenderSettings>
  theme: 'dark' | 'midnight' | 'graphite'
  accent: string
  hardwareAcceleration: boolean
  hotkeys: {
    toggleRecord: string
    pauseResume: string
  }
  openEditorAfterRecord: boolean
  lastExportDir?: string
  telemetry: false
}

// ── IPC helpers ─────────────────────────────────────────────────────────────

export interface FfmpegJob {
  args: string[]
  /** Duration in ms for progress calculation */
  durationMs?: number
}

export interface FfmpegProgress {
  jobId: string
  progress: number
  timeMs: number
  speed?: string
  done?: boolean
  error?: string
}

export type HudCommand = 'pause' | 'resume' | 'stop' | 'cancel' | 'restart' | 'toggle-mic' | 'toggle-camera'

export interface HudState {
  status: 'countdown' | 'recording' | 'paused' | 'stopping'
  countdown?: number
  elapsedMs: number
  micLevel: number
  micEnabled: boolean
  cameraEnabled: boolean
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_RENDER: RenderSettings = {
  aspect: 'source',
  outputHeight: 1080,
  background: {
    type: 'gradient',
    angle: 135,
    stops: [
      { color: '#4f46e5', pos: 0 },
      { color: '#c026d3', pos: 0.55 },
      { color: '#f97316', pos: 1 }
    ]
  },
  padding: 0.08,
  cornerRadius: 18,
  shadow: { enabled: true, blur: 60, opacity: 0.45, offsetY: 24, spread: 0 },
  border: { enabled: false, width: 2, color: '#ffffff', opacity: 0.25 },
  tilt: { x: 0, y: 0 },
  crop: null,
  cursor: {
    mode: 'custom',
    style: 'arrow',
    size: 1.4,
    smoothing: 0.55,
    clickEffect: 'ripple',
    clickColor: '#60a5fa',
    hideWhenIdle: false,
    idleAfterMs: 2500,
    tint: null,
    motionBlur: true
  },
  camera: {
    enabled: true,
    shape: 'circle',
    size: 0.26,
    position: 'bottom-right',
    custom: { x: 0.85, y: 0.8 },
    mirror: true,
    shadow: true,
    border: { enabled: true, width: 4, color: '#ffffff' },
    radius: 24,
    zoom: 1,
    margin: 32,
    blurBackground: false
  },
  zoom: {
    autoEnabled: true,
    defaultScale: 2,
    transitionMs: 650,
    holdMs: 1800,
    easing: 'spring',
    sensitivity: 'medium',
    followCursor: true,
    followSmoothing: 0.6
  },
  keystrokes: {
    enabled: true,
    position: 'bottom',
    style: 'pill',
    size: 1,
    durationMs: 1400,
    showModifiersOnly: true
  },
  captions: {
    enabled: true,
    fontSize: 42,
    fontFamily: 'Inter, system-ui, sans-serif',
    color: '#ffffff',
    background: 'rgba(0,0,0,0.6)',
    position: 'bottom',
    highlightColor: '#fbbf24',
    maxLines: 2
  },
  color: { brightness: 0, contrast: 0, saturation: 0, vignette: 0 },
  motionBlur: 0.35
}

export const DEFAULT_AUDIO_TRACK: AudioTrackSettings = {
  volume: 1,
  muted: false,
  gate: null,
  fadeIn: 0,
  fadeOut: 0
}

export const DEFAULT_TIMELINE = (durationMs: number): Timeline => ({
  clips: [{ id: 'clip-1', sourceStart: 0, sourceEnd: durationMs, speed: 1 }],
  zooms: [],
  camera: [],
  texts: [],
  captions: [],
  audio: {
    mic: { ...DEFAULT_AUDIO_TRACK },
    system: { ...DEFAULT_AUDIO_TRACK, volume: 0.8 },
    camera: { ...DEFAULT_AUDIO_TRACK, muted: true },
    music: null
  },
  markers: []
})

export const WALLPAPERS: Array<{ id: string; name: string; css: string }> = [
  { id: 'aurora', name: 'Aurora', css: 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 35%,#0ea5e9 70%,#a7f3d0 100%)' },
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(160deg,#7c2d12 0%,#ea580c 40%,#fbbf24 100%)' },
  { id: 'candy', name: 'Candy', css: 'linear-gradient(135deg,#f472b6 0%,#c084fc 50%,#60a5fa 100%)' },
  { id: 'forest', name: 'Forest', css: 'linear-gradient(150deg,#052e16 0%,#166534 50%,#4ade80 100%)' },
  { id: 'midnight', name: 'Midnight', css: 'linear-gradient(180deg,#020617 0%,#1e1b4b 100%)' },
  { id: 'peach', name: 'Peach', css: 'linear-gradient(135deg,#fecdd3 0%,#fdba74 50%,#fde68a 100%)' },
  { id: 'ocean', name: 'Ocean', css: 'linear-gradient(135deg,#0c4a6e 0%,#0891b2 50%,#22d3ee 100%)' },
  { id: 'graphite', name: 'Graphite', css: 'linear-gradient(135deg,#111827 0%,#374151 100%)' },
  { id: 'lavender', name: 'Lavender', css: 'linear-gradient(135deg,#312e81 0%,#7c3aed 50%,#e879f9 100%)' },
  { id: 'mint', name: 'Mint', css: 'linear-gradient(135deg,#064e3b 0%,#10b981 50%,#a7f3d0 100%)' },
  { id: 'ember', name: 'Ember', css: 'linear-gradient(135deg,#450a0a 0%,#dc2626 50%,#f97316 100%)' },
  { id: 'paper', name: 'Paper', css: 'linear-gradient(135deg,#f5f5f4 0%,#e7e5e4 100%)' }
]

export const ASPECT_RATIOS: Record<Exclude<AspectPreset, 'source'>, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:4': 3 / 4,
  '21:9': 21 / 9,
  '4:5': 4 / 5
}
