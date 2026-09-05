import type { CaptionSegment, Project } from '@shared/types'
import { mixdown, mixSourcesFor } from './audio'
import { timelineDuration } from './timeline'
import { uid } from '@/lib/utils'

export type WhisperModel = 'tiny' | 'base' | 'small'

export interface TranscribeProgress {
  phase: 'audio' | 'download' | 'transcribing' | 'done'
  progress: number
  message?: string
}

// "_timestamped" exports include cross-attentions, required for word-level timestamps.
const MODEL_IDS: Record<WhisperModel, string> = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped'
}
const FALLBACK_IDS: Record<WhisperModel, string> = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineCache: { model: string; device: string; pipe: any } | null = null

async function loadPipeline(model: WhisperModel, onProgress: (p: TranscribeProgress) => void, useFallback = false): Promise<any> {
  const id = useFallback ? FALLBACK_IDS[model] : MODEL_IDS[model]
  const hasWebGPU = 'gpu' in navigator
  const device = hasWebGPU ? 'webgpu' : 'wasm'
  if (pipelineCache && pipelineCache.model === id && pipelineCache.device === device) return pipelineCache.pipe
  const tf = await import('@huggingface/transformers')
  tf.env.allowLocalModels = false
  // Serve the ONNX runtime WASM/JS from the app instead of a CDN (offline + CSP friendly)
  const ortBase = new URL('ort/', document.baseURI).href
  const onnx = (tf.env.backends as { onnx?: { wasm?: { wasmPaths?: string; proxy?: boolean } } }).onnx
  if (onnx?.wasm) {
    onnx.wasm.wasmPaths = ortBase
    onnx.wasm.proxy = false
  }
  const files = new Map<string, { loaded: number; total: number }>()
  const report = (): void => {
    let loaded = 0
    let total = 0
    for (const f of files.values()) {
      loaded += f.loaded
      total += f.total
    }
    onProgress({ phase: 'download', progress: total ? loaded / total : 0, message: `Downloading model (${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)` })
  }
  const attempt = async (dev: string): Promise<any> =>
    tf.pipeline('automatic-speech-recognition', id, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ output_attentions: !useFallback } as any),
      device: dev as 'webgpu' | 'wasm',
      dtype: dev === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'fp32' } : 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
          report()
        }
      }
    })
  let pipe
  try {
    pipe = await attempt(device)
  } catch (e) {
    if (!useFallback && /404|not found|Could not locate/i.test(String((e as Error).message ?? e))) {
      console.warn('timestamped model unavailable, using plain model', e)
      return loadPipeline(model, onProgress, true)
    }
    console.warn('webgpu pipeline failed, falling back to wasm', e)
    pipe = await attempt('wasm')
  }
  pipelineCache = { model: id, device, pipe }
  return pipe
}

/** Resample an AudioBuffer to mono 16 kHz Float32Array. */
async function toMono16k(buffer: AudioBuffer): Promise<Float32Array> {
  const targetRate = 16000
  const length = Math.ceil(buffer.duration * targetRate)
  const ctx = new OfflineAudioContext(1, length, targetRate)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start()
  const out = await ctx.startRendering()
  return out.getChannelData(0)
}

interface Chunk {
  text: string
  timestamp: [number, number | null]
}

/** Group word-level chunks into caption segments of readable length. */
function chunksToCaptions(chunks: Chunk[], maxChars = 42, maxDurMs = 4500): CaptionSegment[] {
  const out: CaptionSegment[] = []
  let cur: { start: number; end: number; text: string } | null = null
  const flush = (): void => {
    if (cur && cur.text.trim()) out.push({ id: uid('cap'), start: Math.round(cur.start), end: Math.round(Math.max(cur.end, cur.start + 400)), text: cur.text.trim() })
    cur = null
  }
  for (const c of chunks) {
    const [a, b] = c.timestamp
    const start = a * 1000
    const end = (b ?? a + 0.5) * 1000
    const word = c.text
    if (!cur) {
      cur = { start, end, text: word }
      continue
    }
    const gap = start - cur.end
    const wouldBe = cur.text + word
    const endsSentence = /[.!?]$/.test(cur.text.trim())
    if (wouldBe.length > maxChars || end - cur.start > maxDurMs || gap > 900 || (endsSentence && cur.text.length > 16)) {
      flush()
      cur = { start, end, text: word }
    } else {
      cur.text = wouldBe
      cur.end = end
    }
  }
  flush()
  // avoid overlaps
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = out[i].start - 10
  return out
}

/**
 * Transcribe the project's mixed voice audio (mic + system) with Whisper running
 * locally via WebGPU/WASM. Returns caption segments in timeline time.
 */
export async function transcribeProject(project: Project, model: WhisperModel, language: string | null, onProgress: (p: TranscribeProgress) => void, signal?: AbortSignal): Promise<CaptionSegment[]> {
  onProgress({ phase: 'audio', progress: 0, message: 'Preparing audio…' })
  const range = { start: 0, end: timelineDuration(project.timeline) }
  // Voice-only sources: prefer mic; fall back to everything
  const all = mixSourcesFor(project).filter((s) => s.name !== 'music')
  const voice = all.filter((s) => s.name === 'mic' || s.name === 'camera')
  const sources = (voice.length ? voice : all).map((s) => ({ ...s, settings: { ...s.settings, muted: false, volume: 1, gate: null } }))
  const buffer = await mixdown(project, sources, range, 16000, (p) => onProgress({ phase: 'audio', progress: p, message: 'Decoding audio…' }))
  if (!buffer) throw new Error('No audio track to transcribe')
  if (signal?.aborted) throw new Error('cancelled')
  const audio = await toMono16k(buffer)

  onProgress({ phase: 'download', progress: 0, message: 'Loading speech model…' })
  let pipe = await loadPipeline(model, onProgress)
  if (signal?.aborted) throw new Error('cancelled')
  let wordLevel = true

  onProgress({ phase: 'transcribing', progress: 0, message: 'Transcribing…' })
  const totalSec = audio.length / 16000
  // Process in 30s windows so we can report progress and keep memory bounded
  const win = 30
  const stride = 2
  const chunks: Chunk[] = []
  for (let start = 0; start < totalSec; start += win - stride) {
    if (signal?.aborted) throw new Error('cancelled')
    const end = Math.min(totalSec, start + win)
    const slice = audio.subarray(Math.floor(start * 16000), Math.floor(end * 16000))
    const run = async (): Promise<{ chunks?: Chunk[] }> =>
      pipe(slice, {
        return_timestamps: wordLevel ? 'word' : true,
        chunk_length_s: 30,
        language: language ?? undefined,
        task: 'transcribe'
      })
    let result: { chunks?: Chunk[] }
    try {
      result = await run()
    } catch (e) {
      if (wordLevel && /cross attentions/i.test(String((e as Error).message ?? e))) {
        // Model without attentions → fall back to segment-level timestamps
        wordLevel = false
        result = await run()
      } else throw e
    }
    const got: Chunk[] = result?.chunks ?? []
    for (const c of got) {
      const a = c.timestamp[0] + start
      if (start > 0 && c.timestamp[0] < stride / 2) continue // overlap dedupe
      chunks.push({ text: c.text, timestamp: [a, c.timestamp[1] != null ? c.timestamp[1] + start : null] })
    }
    onProgress({ phase: 'transcribing', progress: Math.min(1, end / totalSec), message: `Transcribing… ${Math.round((end / totalSec) * 100)}%` })
    if (end >= totalSec) break
  }
  onProgress({ phase: 'done', progress: 1 })
  void pipe
  const caps = chunksToCaptions(chunks, wordLevel ? 42 : 80, wordLevel ? 4500 : 8000)
  // Clamp to the timeline and drop Whisper hallucinations that fall outside it
  return caps
    .filter((c) => c.start < range.end - 50)
    .map((c) => ({ ...c, end: Math.min(c.end, range.end) }))
    .filter((c) => c.end - c.start > 100)
}
