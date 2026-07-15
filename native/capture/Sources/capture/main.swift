import AVFoundation
import Foundation

// Entry point for the capture sidecar.
//
//   capture                 -> stream PCM records on stdout (the normal mode)
//   capture --list-devices  -> print available input devices as JSON, then exit
//
// Exit codes: 2 = screen-recording permission/capture failed, 3 = mic denied,
// 4 = mic start failed. Node treats a non-zero exit + the JSON stderr line as a
// setup problem to surface to the user, not a stack trace.

if CommandLine.arguments.contains("--list-devices") {
  listDevices()
  exit(0)
}

let writer = RecordWriter()
let mic = MicCapture(writer: writer)
let system = SystemCapture(writer: writer)

// Clean shutdown on SIGTERM/SIGINT (Node kills us on app quit).
for sig in [SIGTERM, SIGINT] {
  signal(sig) { _ in exit(0) }
}

// Each leg is best-effort: a denied permission on one must NOT take down the
// other. If both fail, the process stays alive but silent (the app surfaces the
// logged reason); no audio simply means no hints.

// Mic leg — request permission first so we log loud, not a silent stream.
AVCaptureDevice.requestAccess(for: .audio) { granted in
  guard granted else {
    Log.error(
      "Microphone permission denied. Open System Settings > Privacy & Security > Microphone and enable this app, then restart.",
      code: "mic-denied")
    return
  }
  do {
    try mic.start()
  } catch {
    Log.error("mic start failed: \(error.localizedDescription)", code: "mic-start")
  }
}

// System-audio leg — needs Screen Recording permission (rides screen capture).
Task {
  do {
    try await system.start()
  } catch {
    Log.error(
      "Screen Recording permission or capture failed: \(error.localizedDescription). "
        + "Open System Settings > Privacy & Security > Screen Recording and enable this app, then restart. "
        + "(The mic leg still runs without it.)",
      code: "screen-denied")
  }
}

// Park the main thread; audio flows on the tap thread and the SC audio queue.
dispatchMain()

/// `--list-devices`: enumerate audio input devices as JSON on stdout. System
/// audio has no device to pick (ScreenCaptureKit captures the whole system), so
/// it's reported as a single logical source.
func listDevices() {
  let session = AVCaptureDevice.DiscoverySession(
    deviceTypes: [.microphone, .external],
    mediaType: .audio,
    position: .unspecified)
  let mics = session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
  let payload: [String: Any] = [
    "mic": mics,
    "system": ["source": "ScreenCaptureKit (whole-system audio)", "requiresScreenRecording": true],
  ]
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
    let text = String(data: data, encoding: .utf8)
  {
    print(text)
  }
}
