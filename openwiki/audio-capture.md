# Audio Capture Sidecar

Source: `native/capture/` (Swift Package, `Package.swift`)

A small Swift executable that replaces the old Java `AudioCapture.java` + BlackHole dependency. Captures both legs of a call — microphone (ME) and system audio (THEM) — and emits a stream of fixed-size PCM records on stdout.

## What it replaces

The Java prototype used `TargetDataLine` (javax.sound) with BlackHole 2ch as a virtual audio loopback for system audio. This required manual BlackHole setup and `Audio MIDI Setup.app` multi-output device configuration. The Swift sidecar uses ScreenCaptureKit for system audio directly — no BlackHole, no manual audio routing.

## Architecture

```
native/capture/Sources/capture/
├── main.swift      — entry point, permission handling, signal handlers
├── Capture.swift   — MicCapture (AVAudioEngine) + SystemCapture (ScreenCaptureKit)
├── Audio.swift     — Resampler (AVAudioConverter) + FrameChunker
└── Protocol.swift  — Leg enum, RecordWriter, Log (JSON stderr)
```

### MicCapture (ME — leg 0x00)

Uses `AVAudioEngine`'s input node. Installs a tap on bus 0, converts to canonical 16 kHz mono via `Resampler`, chunks into 512-sample records via `FrameChunker`, and writes to stdout via `RecordWriter`.

Requires **Microphone permission** (`AVCaptureDevice.requestAccess(for: .audio)`). If denied, logs an error with code `mic-denied` and stays silent.

### SystemCapture (THEM — leg 0x01)

Uses `ScreenCaptureKit` (`SCStream`) with audio capture enabled. Rides the screen-capture entitlement, so this needs **Screen Recording permission**. Key config:
- `capturesAudio = true`, `sampleRate = 16_000`, `channelCount = 1`
- `excludesCurrentProcessAudio = true` — don't capture our own app audio
- Video path is minimal: `width = 2`, `height = 2`, `minimumFrameInterval = 1/1` — audio rides screen capture, so video is kept as cheap as possible
- Converts `CMSampleBuffer` → `AVAudioPCMBuffer` → `Resampler` → `FrameChunker` → stdout

If screen recording permission is denied, the `SCShareableContent.current` call throws and the leg logs an error.

### Best-effort per leg

Each leg is independent. A denied permission on one leg does NOT take down the other. If both fail, the process stays alive but silent — the app surfaces the logged reason; no audio means no hints.

## Resampler

Source: `Audio.swift:Resampler`

Wraps `AVAudioConverter` to convert any input PCM buffer to canonical 16 kHz mono float32. Recreates the underlying converter if the input format changes between buffers (system audio format can shift).

> The README notes the old Java code used a box-filter resampler (fine for speech, but a WER suspect). The Swift version uses `AVAudioConverter` — this is what it's FOR.

## Wire protocol

Source: `Protocol.swift`, mirrored in `src/shared/types.ts`

Each record is exactly **2049 bytes**:
```
byte 0          : leg  (0x00 = mic/ME, 0x01 = system/THEM)
bytes 1..2048   : 512 × Float32 little-endian, 16kHz mono
```

Fixed-size records mean no framing parser and no partial-read bugs on the Node side. stdout is binary and carries ONLY these records. stderr carries JSON log lines — a single stray byte on stdout desynchronises the whole stream.

### RecordWriter

`Protocol.swift:RecordWriter` serializes writes under an `NSLock` so the two capture legs never interleave a record. Each 2049-byte record is written in a single `write()` call.

### Node-side demux

`src/main/sidecar.ts:Sidecar` buffers stdout chunks and drains as many whole 2049-byte records as available. The leg byte determines `Leg`; the PCM bytes are copied into a standalone `ArrayBuffer` (transferred to the pipeline utilityProcess). stderr lines are parsed as JSON `{ level, msg, code? }`.

## Logging

`Log` emits JSON lines to stderr: `{"level": "...", "msg": "...", "code": "..."}`. Codes include `mic-denied`, `mic-start`, `sc-stopped`. The Node side (`Sidecar.onStderr`) parses these and forwards them to the main process log.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Normal exit (SIGTERM/SIGINT) |
| 2 | Screen recording permission/capture failed |
| 3 | Microphone permission denied |
| 4 | Microphone start failed |

Node treats non-zero exit + the JSON stderr line as a setup problem to surface to the user, not a stack trace.

## Building

```bash
npm run sidecar
# equivalent to: swift build --package-path native/capture -c release
```

Output: `native/capture/.build/release/capture`. The config resolver (`src/main/config.ts:sidecarBinary()`) checks this path first, then falls back to `process.resourcesPath` for packaged builds.

## Device enumeration

```bash
npm run list-devices
# equivalent to: electron-vite build && electron . --list-devices
```

Delegates to the Swift sidecar's `--list-devices` mode, which prints available AVFoundation input devices as JSON and exits. Used to verify that both capture legs can see their devices.

## Platform requirements

- macOS 14+ (`.macOS(.v14)` in `Package.swift` — ScreenCaptureKit audio capture API)
- Microphone permission
- Screen Recording permission (for system audio leg)
