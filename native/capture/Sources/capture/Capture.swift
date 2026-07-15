import AVFoundation
import ScreenCaptureKit

enum CaptureError: Error {
  case noDisplay
}

/// Microphone leg (ME) via AVAudioEngine. The input node's native format is
/// resampled to canonical 16k mono, then chunked into 512-sample records.
final class MicCapture {
  private let engine = AVAudioEngine()
  private let resampler = Resampler()
  private let chunker: FrameChunker

  init(writer: RecordWriter) {
    chunker = FrameChunker(leg: .mic, writer: writer)
  }

  func start() throws {
    let input = engine.inputNode
    let format = input.inputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
      guard let self, let samples = self.resampler.convert(buf) else { return }
      self.chunker.push(samples)
    }
    engine.prepare()
    try engine.start()
    Log.info("mic capture started (\(format.sampleRate)Hz, \(format.channelCount)ch)")
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }
}

/// System-audio leg (THEM) via ScreenCaptureKit. Audio capture rides the
/// screen-capture entitlement, so this needs Screen Recording permission.
final class SystemCapture: NSObject, SCStreamOutput, SCStreamDelegate {
  private var stream: SCStream?
  private let resampler = Resampler()
  private let chunker: FrameChunker
  private let audioQueue = DispatchQueue(label: "pl.bespokesoft.copilot.sc-audio")

  init(writer: RecordWriter) {
    chunker = FrameChunker(leg: .system, writer: writer)
    super.init()
  }

  func start() async throws {
    // Throws if Screen Recording permission has not been granted.
    let content = try await SCShareableContent.current
    guard let display = content.displays.first else { throw CaptureError.noDisplay }

    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = Int(kTargetRate)
    config.channelCount = 1
    config.excludesCurrentProcessAudio = true // don't capture our own overlay/app audio
    // Audio rides screen capture; keep the video path as cheap as possible.
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
    try await stream.startCapture()
    self.stream = stream
    Log.info("system-audio capture started")
  }

  func stop() async {
    if let stream { try? await stream.stopCapture() }
    stream = nil
  }

  // SCStreamOutput
  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sampleBuffer.isValid else { return }
    guard let pcm = Self.pcmBuffer(from: sampleBuffer), let samples = resampler.convert(pcm) else { return }
    chunker.push(samples)
  }

  // SCStreamDelegate
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    Log.error("system-audio stream stopped: \(error.localizedDescription)", code: "sc-stopped")
  }

  /// CMSampleBuffer (audio) -> AVAudioPCMBuffer for the resampler.
  private static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
    guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
      let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)
    else { return nil }
    var asbd = asbdPtr.pointee
    guard let format = AVAudioFormat(streamDescription: &asbd) else { return nil }
    let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
    guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
    pcm.frameLength = frames
    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
      sampleBuffer, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList)
    return status == noErr ? pcm : nil
  }
}
