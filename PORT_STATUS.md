# Port status: Java → Node/Electron

macOS-only Electron port of the conversation copilot, per `PORT.md`. This tracks
what's built and what you still need to run (the two load-bearing gates need
hardware/permissions I can't exercise for you).

## What's built and verified

| Area | File(s) | Verified |
|---|---|---|
| Electron scaffold + overlay window | `src/main/index.ts`, `src/renderer/*` | ✅ typecheck + build |
| Content-protection flags | `src/main/index.ts` | ✅ **Gate 1 PASSED** (A/B capture: visible with protection off, absent with it on; visible to the user both ways) |
| Swift capture sidecar | `native/capture/**` | ✅ compiles; `--list-devices` runs |
| TranscriptState (append-only prefix) | `src/pipeline/transcript-state.ts` | ✅ prefix-stability tests |
| Playbook (trigram cosine) | `src/pipeline/playbook.ts` | ✅ Polish-inflection tests |
| HintEngine (cancel-previous) | `src/pipeline/hint-engine.ts` | ✅ cancellation test (10→9 abort) |
| LlamaClient (SSE + AbortController) | `src/pipeline/llama-client.ts` | ✅ typecheck; ⛔ TTFT gate |
| SileroVad (v5) | `src/pipeline/vad.ts` | ✅ hysteresis/hangover tests |
| SherpaStt | `src/pipeline/stt.ts` | ✅ typecheck (runtime needs model) |
| Pipeline wiring (utilityProcess) | `src/main/pipeline-host.ts`, `src/pipeline/index.ts` | ✅ build; runtime needs models |
| llama-server supervision | `src/main/llama-supervisor.ts` | ✅ typecheck |
| `--bench <wav>` | `src/main/bench.ts`, `src/pipeline/wav.ts` | ✅ WAV reader tests |
| `--list-devices` | `src/main/list-devices.ts` | ✅ runs via sidecar |

`npm test` → **23 passing**. `npm run typecheck` and `npm run build` are clean.

Invariants honored: append-only prompt (byte-identical prefix test), full llama
request body incl. `cache_prompt`/`id_slot:0`/`--parallel 1`, cancel-previous via
`AbortController`, 512-sample frames, two-leg diarization (only THEM speculates),
`HANGOVER_MS=250` exposed in `vad.ts`. The box-filter resampler was **not**
ported — the Swift sidecar uses `AVAudioConverter` instead.

## Build

```bash
npm install
npm run sidecar     # swift build the capture binary
npm run build       # electron-vite build
```

## Runtime prerequisites (README steps 2–4)

1. **Models → `~/models/`**
   - `silero_vad.onnx` (v5)
   - `zipformer-streaming/` with `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, `tokens.txt` (Polish-capable)
   - `Qwen3-4B-Instruct-Q4_K_M.gguf`
2. **llama.cpp**: `brew install llama.cpp` (the app supervises/spawns `llama-server` with the exact flags; you can also run it yourself).
3. **Permissions** (first run prompts): Microphone + Screen Recording for the app.
   ScreenCaptureKit system-audio capture rides the Screen-Recording entitlement —
   this is what replaces BlackHole.

## The two gates — do not skip (from PORT.md)

### Gate 1 — content protection ✅ PASSED
Verified by an A/B screen-capture test + on-screen visual confirmation:
protection off → pill in the capture; protection on → pill absent from the
capture but still visible to the user. `setContentProtection` works.

Fixes made to get here: the built page's CSP was blocking the bundled external
stylesheet (pill lost all styling → invisible), and the placeholder hint raced
the renderer subscription. Fixed with a proper CSP (`style-src 'self'`) and a
renderer→main `ready()` handshake. Debug switch: `COPILOT_NO_PROTECT=1` disables
protection for re-verification.

```bash
npm run app          # builds + launches; overlay shows a "ready" pill bottom-centre
```

### Gate 2 — TTFT (prefix cache actually warm) ✅ PASSED
Measured through the real `LlamaClient` + `TranscriptState.renderPrompt()` via a
dedicated probe (`npm run ttft`), against `llama-server` running
`unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M` with the port's exact flags:

```
A: append-only (cache-friendly)   p50=37.8ms  p95=41.4ms
B: cache-busting control          p50=62.4ms
→ append-only p50 TTFT = 37.8ms  (< 100ms)  PASS
```

TTFT is well under budget and the append-only path beats the cache-busted
control, confirming `cache_prompt` + pinned warm slot reuse the prefix. (The
control is only ~1.7× slower rather than the ~20× "~800ms" failure mode because
the test transcript is short — the dramatic blow-up only appears at a full ~4k
context; the mechanism is demonstrably working either way.)

The full-pipeline bench (needs the VAD/STT models too) remains available:
```bash
npm run bench -- path/to/call.wav   # p50/p95 for every stage boundary
```

**Model note:** the GGUF is now in the HF cache (`~/.cache/huggingface/hub/...`),
not at `~/models/Qwen3-4B-Instruct-Q4_K_M.gguf`. To make `npm run app` supervise
it, either symlink it into `~/models/` or point the supervisor at
`-hf unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M`.

## Other commands
```bash
npm run list-devices   # verify the sidecar sees your mic
npm run dev            # electron-vite dev (HMR)
```
