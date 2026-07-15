import Foundation

// Wire protocol — must stay byte-identical to src/shared/types.ts.
//
// Each record is exactly 2049 bytes:
//   byte 0        : leg  (0x00 = mic/ME, 0x01 = system/THEM)
//   bytes 1..2048 : 512 × Float32 little-endian, 16kHz mono
//
// Fixed-size records mean no framing parser and no partial-read bugs on the Node
// side. stdout is binary and carries ONLY these records; a single stray byte
// desynchronises the whole stream, so everything else goes to stderr.
enum Leg: UInt8 {
  case mic = 0x00 // ME   — the user's microphone
  case system = 0x01 // THEM — the far end (system audio)
}

let kFrameSamples = 512
let kTargetRate = 16_000.0
let kRecordBytes = 1 + kFrameSamples * 4 // 2049

/// Serializes writes to stdout so the two capture legs never interleave a record.
/// Each 2049-byte record is written in a single write() under the lock.
final class RecordWriter {
  private let lock = NSLock()
  private let out = FileHandle.standardOutput

  /// `samples` must be exactly kFrameSamples long.
  func write(leg: Leg, samples: [Float]) {
    precondition(samples.count == kFrameSamples)
    var record = Data(capacity: kRecordBytes)
    record.append(leg.rawValue)
    samples.withUnsafeBytes { raw in
      record.append(contentsOf: raw) // native LE on arm64/x86_64
    }
    lock.lock()
    defer { lock.unlock() }
    out.write(record)
  }
}

/// Structured logging + permission errors on stderr as JSON lines. Never stdout.
enum Log {
  private static let err = FileHandle.standardError

  static func emit(_ level: String, _ msg: String, code: String? = nil) {
    var obj: [String: Any] = ["level": level, "msg": msg]
    if let code { obj["code"] = code }
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
      var line = String(data: data, encoding: .utf8)
    else { return }
    line += "\n"
    if let bytes = line.data(using: .utf8) { err.write(bytes) }
  }

  static func info(_ msg: String) { emit("info", msg) }
  static func warn(_ msg: String) { emit("warn", msg) }
  static func error(_ msg: String, code: String? = nil) { emit("error", msg, code: code) }
}
