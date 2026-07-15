// swift-tools-version:5.9
import PackageDescription

// The audio-capture sidecar. Replaces AudioCapture.java and kills the BlackHole
// dependency: system audio via ScreenCaptureKit, mic via AVAudioEngine. Emits
// fixed 2049-byte PCM records on stdout; logs + permission errors as JSON on stderr.
let package = Package(
  name: "capture",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "capture",
      path: "Sources/capture"
    )
  ]
)
