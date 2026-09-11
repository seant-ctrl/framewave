// fw-sysaudio — records macOS system audio (what you hear) to a WAV file using
// ScreenCaptureKit. Requires macOS 13+. Spawned by Framewave's main process
// during a recording; it inherits the app's Screen Recording permission.
//
//   fw-sysaudio <output.wav>
//
// Protocol (stdout lines): "ready" once capture started, "error <msg>" on failure.
// Signals: SIGUSR1 = pause (drop samples), SIGUSR2 = resume, SIGTERM/SIGINT = stop & finalize.
import Foundation
import AVFoundation
import ScreenCaptureKit

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let url: URL
  var stream: SCStream?
  var file: AVAudioFile?
  var paused = false
  var frames: Int64 = 0
  let queue = DispatchQueue(label: "fw.sysaudio.out")

  init(url: URL) { self.url = url }

  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { throw NSError(domain: "fw", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display"]) }
    // We only want audio; keep the video side as cheap as possible.
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.capturesAudio = true
    cfg.excludesCurrentProcessAudio = true
    cfg.sampleRate = 48000
    cfg.channelCount = 2
    cfg.width = 2
    cfg.height = 2
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    cfg.queueDepth = 3
    let s = SCStream(filter: filter, configuration: cfg, delegate: self)
    try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try await s.startCapture()
    stream = s
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, !paused, sampleBuffer.isValid else { return }
    guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
    let format = AVAudioFormat(cmAudioFormatDescription: fmtDesc)
    if file == nil {
      do {
        // WAV, 16-bit PCM interleaved, same rate/channels as the capture
        let settings: [String: Any] = [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: format.sampleRate,
          AVNumberOfChannelsKey: format.channelCount,
          AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false,
          AVLinearPCMIsBigEndianKey: false,
          AVLinearPCMIsNonInterleaved: false
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
      } catch {
        print("error cannot create file: \(error)")
        fflush(stdout)
        return
      }
    }
    var blockBuffer: CMBlockBuffer?
    var abl = AudioBufferList()
    var size = 0
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, bufferListSizeNeededOut: &size, bufferListOut: &abl, bufferListSize: MemoryLayout<AudioBufferList>.size,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer)
    if status != noErr {
      // Multi-buffer (non-interleaved) layouts need a bigger list
      let count = Int(format.channelCount)
      let listPtr = AudioBufferList.allocate(maximumBuffers: count)
      defer { free(listPtr.unsafeMutablePointer) }
      let st2 = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: listPtr.unsafeMutablePointer,
        bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: count), blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer)
      guard st2 == noErr, let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: listPtr.unsafeMutablePointer) else { return }
      write(pcm)
      return
    }
    guard let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: &abl) else { return }
    write(pcm)
  }

  private func write(_ pcm: AVAudioPCMBuffer) {
    do {
      try file?.write(from: pcm)
      frames += Int64(pcm.frameLength)
    } catch {
      print("error write: \(error)")
      fflush(stdout)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    print("error stream stopped: \(error.localizedDescription)")
    fflush(stdout)
    finish()
  }

  func finish() {
    let s = stream
    stream = nil
    let sem = DispatchSemaphore(value: 0)
    s?.stopCapture { _ in sem.signal() }
    _ = sem.wait(timeout: .now() + 3)
    queue.sync { self.file = nil } // closes the WAV (header finalized on release)
    print("done \(frames)")
    fflush(stdout)
    exit(0)
  }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  print("error usage: fw-sysaudio <output.wav>")
  exit(2)
}
let rec = Recorder(url: URL(fileURLWithPath: args[1]))

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
signal(SIGUSR1, SIG_IGN)
signal(SIGUSR2, SIG_IGN)
let sigQueue = DispatchQueue(label: "fw.sysaudio.sig")
let stopSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
stopSrc.setEventHandler { rec.finish() }
stopSrc.resume()
let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: sigQueue)
intSrc.setEventHandler { rec.finish() }
intSrc.resume()
let pauseSrc = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: sigQueue)
pauseSrc.setEventHandler { rec.paused = true }
pauseSrc.resume()
let resumeSrc = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: sigQueue)
resumeSrc.setEventHandler { rec.paused = false }
resumeSrc.resume()

Task {
  do {
    try await rec.start()
    print("ready")
    fflush(stdout)
  } catch {
    print("error \(error.localizedDescription)")
    fflush(stdout)
    exit(1)
  }
}
// Exit if the parent dies (stdin closes)
DispatchQueue.global().async {
  while let line = readLine() { if line == "stop" { rec.finish() } }
  rec.finish()
}
dispatchMain()
