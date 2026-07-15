# Operations & Setup

## Prerequisites

- **macOS 14+** (ScreenCaptureKit audio capture API)
- **Node.js 22** (CI uses 22; `@types/node` ^22.7.4)
- **Swift toolchain** (for building the sidecar; Xcode or swift.org)
- **llama.cpp** (`brew install llama.cpp`) — provides `llama-server`
- **32 GB+ RAM** recommended (Zoom + Chrome + 4B model + 2× STT)
- **Apple Silicon** preferred (`--n-gpu-layers 99` for Metal; without it you're on CPU and "it's over")

## Setup

### 1. Build the Swift capture sidecar

```bash
npm run sidecar
# swift build --package-path native/capture -c release
```

Verify it can see devices:
```bash
npm run list-devices
```

### 2. Fetch models to ~/models/

```bash
bash scripts/fetch-models.sh
```

Downloads:
- `~/models/silero_vad.onnx` — Silero VAD v5 (from snakers4/silero-vad)
- `~/models/zipformer-streaming/` — streaming Zipformer (encoder, decoder, joiner, tokens)
- Parakeet-TDT 0.6b v3 int8 (25 EU languages incl. Polish) — via `scripts/fetch-parakeet.sh`

Model readiness is checked at startup by `src/main/config.ts:checkModels()`:
- `silero`: `~/models/silero_vad.onnx` exists
- `zipformer`: all four files exist (`encoder.onnx`, `decoder.onnx`, `joiner.onnx`, `tokens.txt`)
- `gguf`: `~/models/Qwen3-4B-Instruct-Q4_K_M.gguf` exists (optional for overlay-only mode)

If silero or zipformer are missing, the pipeline stays idle and logs a warning. The overlay still runs standalone.

### 3. llama-server

You can either start it manually or let the app auto-spawn it.

**Manual** (recommended for tuning):
```bash
llama-server -m ~/models/Qwen3-4B-Instruct-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 \
  --n-gpu-layers 99 \
  --parallel 1 \
  --ctx-size 8192 \
  --cache-reuse 256
```

**Auto-spawn**: `LlamaSupervisor` (`src/main/llama-supervisor.ts`) checks `http://127.0.0.1:8080/health`. If not answering, spawns `llama-server` with the flags above and polls until healthy (60 s timeout).

Every flag is load-bearing:
| Flag | Why |
|---|---|
| `--n-gpu-layers 99` | Metal. Without this you're on CPU. |
| `--parallel 1` | ONE slot = one KV cache = it stays warm. Not a typo. |
| `--ctx-size 8192` | Context window. |
| `--cache-reuse 256` | Reuse the cached prefix instead of re-prefilling. |

### 4. Playbook

`playbook.tsv` at the project root. TSV format: `trigger phrase <TAB> hint to display`. See [Pipeline](pipeline.md#playbook) for the matching algorithm.

### 5. macOS permissions

On first run:
- **Microphone** — macOS will prompt. If denied, the sidecar logs `mic-denied` (exit code 3). Fix in System Settings → Privacy & Security → Microphone.
- **Screen Recording** — needed for system audio capture (ScreenCaptureKit). macOS will prompt. If denied, the system-audio leg throws and logs `sc-stopped`. Fix in System Settings → Privacy & Security → Screen Recording.

### 6. Run

```bash
npm run dev
```

## Environment variables

| Variable | Effect |
|---|---|
| `COPILOT_NO_PROTECT=1` | Disable content protection — the pill will appear in screen share. Use only to A/B verify the gate. |
| `COPILOT_DEMO=1` | Cycle fake hints through the overlay. No models/llama needed. |
| `COPILOT_DEBUG=1` | Per-leg debug: frame count, audio level (mean \|sample\|), VAD max probability every ~2 s. |
| `COPILOT_MIC_SPECULATE=1` | Speculate on the mic leg too. Testing mode — no Screen Recording permission needed. |
| `COPILOT_PLACEHOLDER=0` | Suppress the initial "ready" placeholder hint. |

## CLI subcommands

### --bench <wav>

Source: `src/main/bench.ts`

Replays a WAV file through the full pipeline (VAD → STT → HintEngine → LlamaClient) and prints p50/p95 latency per stage boundary:

```
stage boundary        n     p50(ms)   p95(ms)
----------------------------------------------
frame_in -> vad_out    XX     X.X       X.X
vad_out -> stt_interim XX     X.X       X.X
stt_interim -> speculate XX     X.X       X.X
speculate -> first_token XX     X.X       X.X
first_token -> painted  XX     X.X       X.X
```

Frames are fed at their natural 32 ms cadence so the debounce and llama slot behave as on a live call. A 20 s WAV takes ~20 s. The bench uses a single VAD + STT (single leg, simulating THEM).

### --ttft

Source: `src/main/ttft.ts`

Gate 2 — verifies the prefix cache is working. Two phases:
- **Phase A (append-only)**: growing interim transcripts extend the prompt; only new tokens are prefilled → TTFT should be double-digit ms.
- **Phase B (cache-busting control)**: a unique prefix is prepended each time → forces full re-prefill → TTFT balloons.

Pass condition: Phase A p50 TTFT < 100 ms and A << B. If A ≥ 100 ms, something mutates the prompt prefix — investigate.

### --list-devices

Source: `src/main/list-devices.ts`

Delegates to the Swift sidecar's `--list-devices` mode. Prints available AVFoundation input devices as JSON.

## Diagnostic script reference

The `scripts/` directory contains standalone diagnostic tools (not part of the app runtime):

| Script | Purpose |
|---|---|
| `fetch-models.sh` | Download silero + zipformer (+ parakeet) models to `~/models/` |
| `fetch-parakeet.sh` | Download Parakeet-TDT multilingual model |
| `check-models.mjs` | Verify model file presence and print readiness |
| `audio-check.mjs` | Audio device capture test |
| `audio-check2.mjs` | Audio capture test (alternate) |
| `vad-check.mjs` | VAD inference test on a sample audio input |
| `sherpa-vad-check.mjs` | VAD + sherpa-onnx combined check |
| `vad-matrix.mjs` | VAD parameter sweep |
| `hint-test.mjs` | Hint engine test with mock transcript |

## Known issues

These are documented in the README's "honest list" and confirmed by source inspection:

- **Whisper is not here on purpose.** It's a 30-second encoder-decoder. Every "streaming Whisper" re-encodes a growing buffer and calls 1–5s real-time.
- **Polish WER is the real risk.** Every benchmark is English. Record 20 minutes of actual calls and measure before committing to any engine. The `SttEngine` interface is designed for swapping.
- **Thermals.** Sustained inference spins the fans → fans feed the mic → mic feeds STT → feedback loop. Watch for it.
- **sherpa-onnx Node bindings move.** If class names in `stt.ts` don't resolve, check `node_modules/sherpa-onnx-node/streaming-asr.js`. Concepts are stable even when names aren't.
- **Content protection robustness.** `setContentProtection(true)` is the Electron API. The README notes `NSWindow.sharingType = .none` (native Swift) would be more robust. Needs real-world verification with actual Zoom/Meet screen share.
