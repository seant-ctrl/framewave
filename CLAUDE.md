# Framewave — notes for working on this repo

Electron (37) + electron-vite + React 19 + TypeScript + Tailwind v4 desktop app: a screen recorder & video editor (Cap / Screen Studio style) for Windows.

## Commands
- `npm run dev -- -w` — dev with renderer HMR **and** main-process restart on change (without `-w` main changes are not applied).
- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json` — typecheck both sides (`npm run typecheck` covers both).
- `npm run build` / `npm run dist` — production build / Windows installer via electron-builder.
- Debug automation: `FW_DEBUG_PORT=9333 npm run dev -- -w` exposes CDP; in dev the renderer sets `window.__fw` (stores, recorder, fw bridge, engine modules) and `window.__fwCtx` (editor player + compositor).

## Layout
- `src/shared/types.ts` — single source of truth for the data model. Times are ms; screen positions normalized 0..1 relative to the **full** captured video (crop is applied in the compositor).
- `src/main/` — `index.ts` (app, `fwmedia://` protocol with HTTP range support, display-media handler w/ Windows loopback audio), `ipc.ts`, `projects.ts` (storage + ffmpeg normalization of MediaRecorder output), `tracker.ts` (uiohook global hooks + koffi Win32: window rects, cursor hiding, cursor shape), `windows.ts` (main/HUD/camera bubble/region picker; overlay windows use `setContentProtection(true)` so they are excluded from capture).
- `src/preload/index.ts` — typed `window.fw` bridge; renderer accesses it via `src/renderer/src/lib/fw.ts`.
- `src/renderer/src/engine/` — pure rendering/logic: `compositor.ts` (draws a frame for a timeline time), `zoom.ts` (auto-zoom generation + stateful solver with cursor dead-zone follow), `cursor.ts`, `layout.ts`, `background.ts`, `timeline.ts` (clip math, split/trim/delete), `player.ts` (multi-track HTML media sync for preview), `audio.ts` (mediabunny decode, peaks, mixdown, silence detection), `transcribe.ts` (Whisper via transformers.js; ORT wasm served from `renderer/public/ort`).
- `src/renderer/src/export/exporter.ts` — WebCodecs export via mediabunny. Frames are read **sequentially** (`FrameFeeder`); random `getSample()` calls are ~100× slower.
- `src/renderer/src/recorder/recorder.ts` — recording engine (MediaRecorder per track, HUD sync, pause bookkeeping). Tracks are aligned by their common stop time in `finalizeRecording`; events are stored with absolute epoch times and converted there.

## macOS notes
- System audio: Chromium loopback is Windows-only, so `src/main/sysaudio.ts` spawns the bundled `fw-sysaudio` helper (Swift, `native/mac/sysaudio.swift`, ScreenCaptureKit, macOS 13+, built universal by `native/mac/build.sh` in CI and shipped via `extraResources`). It writes `system.wav`, pauses on SIGUSR1/resumes on SIGUSR2, finalizes on SIGTERM; the recorder stops it together with the MediaRecorders so end-alignment applies. Cursor hiding/shape and window-rect tracking remain Windows-only (koffi Win32).
- Packaging: `scripts/afterPack.cjs` ad-hoc signs the .app (unsigned apps show as "damaged" on Apple Silicon); title bar uses `hiddenInset` traffic lights on mac.

## Montage model
- `Clip.sourceId` selects a `MediaAsset` from `recording.media` (undefined/'screen' = the recording). `Clip.transitionIn` overlaps the previous clip: `placeClips()` in `engine/timeline.ts` computes overlapping placements and `activeClipsAt()` returns current + outgoing clip with progress. Compositor draws transitions in `drawContent`; player keeps one element per source and crossfades gains; exporter uses a `SourcePool` (one sequential `FrameFeeder` per video source, bitmaps for images); mixdown schedules each clip's own audio with fades matching the overlaps.
- Media ingestion (`projects.ts: ingestMedia`) normalizes everything to H.264 MP4 (or copies images).
- Audio track: `Timeline.audioClips` (`AudioClip` = source range + timeline `start`, volume/fades/mute, `fromClipId` when detached). `detachAudio`/`reattachAudio` in `engine/timeline.ts` (detaching mutes the video clip); `timelineDuration` = max(video end, audio block ends). Player keeps one media element per block (`audioEls`), mixdown schedules blocks with fade ramps, peaks are keyed by asset id in `project.peaks`. Audio-only imports (`ingestMedia` copies mp3/m4a/wav/ogg/opus/flac, transcodes the rest to m4a) become blocks at the playhead, trimmed to the video end. UI: `panels/ClipPanel.tsx`, drag-reorder + transition badges in `Timeline.tsx`, `mediaImport.ts` for add/drop.

## Gotchas learned
- Do not pass width/height constraints to `getDisplayMedia` — Chromium upscales the capture to the max.
- MediaRecorder `start` events are not reliable for sync; use end-alignment (all recorders stop together).
- `electron-store` v10 is ESM-only and breaks the CJS main bundle; settings use a small JSON store instead.
- React StrictMode double-invokes effects: `useProject.load` guards against stale loads.
- Production renderer is served via the custom `app://framewave/` scheme (not `file://`, which blocks `fetch()` of wasm/model files). Native modules (uiohook-napi, koffi) ship N-API prebuilds; electron-builder runs with `npmRebuild: false` because there is no Visual Studio toolchain on this machine.
- ES module instances are cached by URL; after editing `transcribe.ts` in dev, reload the page before re-importing it from a debug script.
