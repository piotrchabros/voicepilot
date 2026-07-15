# Copilot — Quickstart

A real-time conversation copilot for macOS. Listens to both legs of a call (your mic + system audio), speculatively generates a hint on every interim transcript update, and shows it as a transparent overlay before the other person finishes talking. Fully local — no cloud API, no metered inference.

## The one idea

The serial path — VAD → STT → turn-end → LLM → render — is 400–800 ms and cannot be made faster. So instead of waiting for the turn to end, the copilot generates continuously on partial transcripts, cancels constantly, and throws away ~90% of the work. By the time the other person stops talking, the answer has been on screen for half a second. This only works because inference is local; on a metered API, 10 speculations per turn is a bill and a rate limit.

## Repository history

The project was originally a Java 21 + JavaFX desktop app (commits `859fe12` → `a868a0d`). The current HEAD (`7fbd97e`) is a complete rewrite to Electron + TypeScript + a Swift native sidecar, removing all Java/Maven code. The Java sources (`src/main/java/...`) are deleted in the working tree; the TypeScript port lives under `src/main/` and `src/pipeline/`. The Swift sidecar (`native/capture/`) replaces the old `AudioCapture.java` + BlackHole audio routing with ScreenCaptureKit.

Uncommitted changes: `PORT.md` and `PORT_STATUS.md` are staged for deletion (port tracking docs, now obsolete); `scripts/fetch-models.sh` has been modified to also fetch the Parakeet-TDT multilingual model.

## Architecture at a glance

Three processes orchestrated by the Electron main process:

1. **Swift capture sidecar** (`native/capture/`) — captures mic (AVAudioEngine) and system audio (ScreenCaptureKit), resamples to 16 kHz mono, emits fixed 2049-byte PCM records on stdout.
2. **Pipeline utilityProcess** (`src/pipeline/index.ts`) — VAD (Silero v5) → streaming STT (Zipformer via sherpa-onnx) → HintEngine (playbook retrieval + speculative LLM generation). Runs off the main thread so ONNX inference never janks the overlay.
3. **Renderer overlay** (`src/renderer/`) — a transparent, click-through, screen-share-hidden BrowserWindow that paints one hint at a time.

A **LlamaSupervisor** manages a local `llama-server` process (spawn if needed, poll `/health`). The hint engine uses `cache_prompt: true` + a pinned slot (`id_slot: 0`) + an append-only prompt to keep TTFT at ~30–50 ms.

→ See [Architecture overview](architecture.md)

## Key concepts

- **Speculative cancellation** — every interim STT update fires a new LLM generation; the previous one is aborted. This is the design, not a bug. ([Pipeline](pipeline.md#speculative-cancellation))
- **Two-layer hints** — Layer 1: instant playbook retrieval (~10 ms, character-trigram cosine). Layer 2: debounced LLM generation (~50 ms TTFT). Retrieval shows immediately; generation overwrites when it lands. ([Pipeline](pipeline.md#two-layer-hints))
- **Prefix cache** — the prompt is append-only so llama.cpp's prefix cache stays warm. Mutating anything in the settled prefix triggers a full 4k-token re-prefill and kills TTFT. ([Pipeline](pipeline.md#prefix-cache--transcript-state))
- **HANGOVER_MS** — 250 ms of silence before a turn is declared over. This single constant dominates the latency budget. ([Pipeline](pipeline.md#vad--silero))
- **Wire protocol** — fixed 2049-byte records (1 leg byte + 512 × Float32 LE) on stdout. No framing parser. ([Audio capture](audio-capture.md#wire-protocol))
- **Content protection** — `setContentProtection(true)` hides the overlay from screen share/recording. The primary reason for the Electron port. ([Architecture](architecture.md#overlay-window))

## Setup (quick)

```bash
# 1. Build the Swift capture sidecar
npm run sidecar          # swift build --package-path native/capture -c release

# 2. Fetch models to ~/models/
bash scripts/fetch-models.sh

# 3. Start llama-server (or let the app auto-spawn it)
llama-server -m ~/models/Qwen3-4B-Instruct-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 --n-gpu-layers 99 \
  --parallel 1 --ctx-size 8192 --cache-reuse 256

# 4. Run the app
npm run dev
```

→ See [Operations & setup](operations.md) for full details, env vars, diagnostics, and known issues.

## CLI commands

| Command | What it does |
|---|---|
| `npm run dev` | Start in dev mode (electron-vite dev) |
| `npm run build` | Build all three bundles (main, preload, renderer) |
| `npm run app` | Build + run the packaged app |
| `npm run sidecar` | Build the Swift capture sidecar (release) |
| `npm run bench` | `--bench <wav>` — replay a WAV through the pipeline, print p50/p95 per stage |
| `npm run ttft` | `--ttft` — verify the prefix cache is working (Gate 2) |
| `npm run list-devices` | `--list-devices` — enumerate audio input devices via the sidecar |
| `npm test` | Run the Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |

→ See [Testing guide](testing.md)

## Documentation map

- [Architecture overview](architecture.md) — process model, IPC, overlay, lifecycle
- [Pipeline](pipeline.md) — VAD, STT, HintEngine, LlamaClient, TranscriptState, Playbook
- [Audio capture](audio-capture.md) — Swift sidecar, ScreenCaptureKit, wire protocol, permissions
- [Operations & setup](operations.md) — models, llama-server, env vars, bench, TTFT gate, known issues
- [Testing](testing.md) — Vitest suite, headless testing, what each test validates

## Source map

| Area | Key files | Notes |
|---|---|---|
| Electron main | `src/main/index.ts` | Overlay window, CLI subcommands, pipeline wiring |
| Pipeline host | `src/main/pipeline-host.ts` | Orchestrates sidecar + pipeline + llama-supervisor |
| Config & paths | `src/main/config.ts` | Model paths, readiness check, sidecar binary resolution |
| Llama supervisor | `src/main/llama-supervisor.ts` | Spawns/polls llama-server, load-bearing flags |
| Prompts | `src/main/prompts.ts` | System prompt, static context, MAX_TURNS |
| Preload bridge | `src/main/preload.ts` | Sandboxed renderer API (onHint + ready only) |
| Bench harness | `src/main/bench.ts` | `--bench <wav>` replays through full pipeline |
| TTFT harness | `src/main/ttft.ts` | `--ttft` verifies prefix cache via append-only vs cache-busting |
| Device listing | `src/main/list-devices.ts` | `--list-devices` delegates to Swift sidecar |
| Pipeline entry | `src/pipeline/index.ts` | utilityProcess: VAD → STT → HintEngine |
| VAD | `src/pipeline/vad.ts` | Silero v5 ONNX, hysteresis + hangover state machine |
| STT | `src/pipeline/stt.ts` | sherpa-onnx streaming Zipformer transducer |
| STT interface | `src/pipeline/stt-engine.ts` | Vendor-swappable STT interface |
| Hint engine | `src/pipeline/hint-engine.ts` | Two-layer hint strategy, cancel-previous, debounce |
| LLM client | `src/pipeline/llama-client.ts` | SSE streaming to llama-server, cache_prompt + pinned slot |
| Transcript state | `src/pipeline/transcript-state.ts` | Append-only conversation state, prefix-cache invariant |
| Playbook | `src/pipeline/playbook.ts` | Character-trigram cosine similarity retrieval |
| WAV reader | `src/pipeline/wav.ts` | PCM16/float32 WAV parse, mono downmix, 16k resample |
| Shared types | `src/shared/types.ts` | Wire protocol types across all process boundaries |
| Renderer | `src/renderer/overlay.ts` + `overlay.css` + `index.html` | One text node, no framework, dim/bright hint styling |
| Swift sidecar | `native/capture/Sources/capture/*.swift` | Mic + system capture, resampler, wire protocol |
| Playbook data | `playbook.tsv` | Polish sales objection → hint mapping |
| Scripts | `scripts/` | Model fetch, audio/VAD checks, hint test |
| Tests | `test/` | vitest unit tests (5 suites) |
| Build config | `electron.vite.config.ts`, `tsconfig.json`, `vitest.config.ts` | Three-target Electron build, strict TS, vitest node env |
| CI | `.github/workflows/openwiki-update.yml` | Scheduled daily OpenWiki doc update → PR |

## Backlog

- **Parakeet-TDT STT integration** — `scripts/fetch-parakeet.sh` downloads a multilingual model (25 EU languages incl. Polish), but `src/pipeline/stt.ts` still hardcodes the Zipformer config. The `SttEngine` interface is designed for this swap but the Parakeet path is not yet wired. Source: `scripts/fetch-parakeet.sh`, `src/pipeline/stt-engine.ts`.
- **Overlay multi-display** — hardcoded to primary display work area. Source: `src/main/index.ts:positionBottomCentre`.
- **Packaging/distribution** — no electron-builder or signing config. The app runs from source only. Source: `package.json`.
- **Thermal feedback loop** — sustained inference → fans → mic noise → STT degradation. Documented as a known issue in README but no mitigation code exists.
