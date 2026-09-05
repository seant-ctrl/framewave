// Copies the ONNX Runtime web assets into the renderer public dir so Whisper
// captions work offline and within the app's CSP (no CDN).
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist')
const dst = join(root, 'src', 'renderer', 'public', 'ort')
if (!existsSync(src)) {
  console.warn('[copy-ort] onnxruntime-web not installed, skipping')
  process.exit(0)
}
mkdirSync(dst, { recursive: true })
let n = 0
for (const f of readdirSync(src)) {
  if (/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f)) {
    copyFileSync(join(src, f), join(dst, f))
    n++
  }
}
console.log(`[copy-ort] copied ${n} files to ${dst}`)
