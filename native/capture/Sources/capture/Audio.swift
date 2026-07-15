import AVFoundation

/// Canonical output format: 16kHz, mono, Float32, non-interleaved. Everything is
/// converted to this before chunking. This is what AVAudioConverter is FOR — do
/// not hand-roll a box-filter resampler (the Java code only did that because
/// javax.sound gave it nothing better).
func canonicalFormat() -> AVAudioFormat {
  AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: kTargetRate, channels: 1, interleaved: false)!
}

/// Wraps AVAudioConverter, converting any input PCM buffer to canonical 16k mono.
/// Recreates the underlying converter if the input format changes between buffers.
final class Resampler {
  private let output = canonicalFormat()
  private var converter: AVAudioConverter?
  private var sourceFormat: AVAudioFormat?

  func convert(_ input: AVAudioPCMBuffer) -> [Float]? {
    let inFormat = input.format
    if sourceFormat != inFormat || converter == nil {
      converter = AVAudioConverter(from: inFormat, to: output)
      sourceFormat = inFormat
    }
    guard let converter else { return nil }

    let ratio = output.sampleRate / inFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 32
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return nil }

    var supplied = false
    var convErr: NSError?
    let status = converter.convert(to: outBuf, error: &convErr) { _, outStatus in
      if supplied {
        outStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      outStatus.pointee = .haveData
      return input
    }

    if status == .error {
      if let convErr { Log.warn("resample error: \(convErr.localizedDescription)") }
      return nil
    }
    guard let ch = outBuf.floatChannelData else { return nil }
    let n = Int(outBuf.frameLength)
    return Array(UnsafeBufferPointer(start: ch[0], count: n))
  }
}

/// Accumulates a stream of 16k mono float samples and flushes exactly-512-sample
/// records to the writer. One chunker per leg; each keeps its own remainder.
final class FrameChunker {
  private let leg: Leg
  private let writer: RecordWriter
  private var buffer: [Float] = []

  init(leg: Leg, writer: RecordWriter) {
    self.leg = leg
    self.writer = writer
    buffer.reserveCapacity(kFrameSamples * 4)
  }

  func push(_ samples: [Float]) {
    buffer.append(contentsOf: samples)
    while buffer.count >= kFrameSamples {
      let frame = Array(buffer[0..<kFrameSamples])
      buffer.removeFirst(kFrameSamples)
      writer.write(leg: leg, samples: frame)
    }
  }
}
