# Architecture Overview

## Process model

The app runs three OS processes plus an optional fourth (llama-server):

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main process  (src/main/index.ts)                 │
│  • Creates transparent overlay BrowserWindow                │
│  • Spawns & supervises the other processes                  │
│  • Demuxes sidecar stdout → frames → pipeline              │
│  • Routes hints: pipeline → overlay renderer                 │
├──────────┬───────────────────────┬──────────────────────────┤
│ Swift    │ utilityProcess        │ BrowserWindow (renderer) │
│ sidecar  │ (pipeline)             │ overlay                  │
│          │                       │                          │
│ stdout:  │ VAD → STT → HintEng   │ One <span> — no framework│
│ 2049-byte│ → LlamaClient (SSE)   │ Receives hints via IPC   │
│ records  │                       │ Click-through, invisible │
│          │ postMessage to main   │ to screen share          │
└──────────┴───────────────────────┴──────────────────────────┘
                    ↑
            llama-server (HTTP :8080)
            spawned & supervised by LlamaSupervisor
```

### Why utilityProcess?

ONNX inference (Silero VAD + Zipformer STT) on the Electron main thread janks the overlay. The pipeline runs in a `utilityProcess.fork()` — Electron's lightweight child process — keeping the main thread free for window management and IPC. The pipeline is built as a second rollup entry alongside main (`electron.vite.config.ts`).

### Why a separate sidecar?

The Java prototype used BlackHole virtual audio + `TargetDataLine` for system capture and JavaFX for the overlay. Two problems: (1) BlackHole is a manual setup dependency; (2) `NSWindow.sharingType = .none` (hide from screen share) isn't reachable from JavaFX. The Swift sidecar solves both: ScreenCaptureKit grabs system audio directly, and the Electron overlay uses `setContentProtection(true)`.

## IPC boundaries

All wire shapes are defined in `src/shared/types.ts` — the single source of truth.

### Swift sidecar → main (stdout, binary)

Fixed 2049-byte records: 1 leg byte (`0x00` = mic/ME, `0x01` = system/THEM) + 512 × Float32 LE. No framing parser. stderr carries JSON log lines only. See [Audio capture](audio-capture.md#wire-protocol).

### main ↔ pipeline (utilityProcess postMessage, structured-clone)

| Direction | Message | Purpose |
|---|---|---|
| main → pipeline | `InitMsg` | One-time: model paths, system prompt, static context, playbook TSV, max turns |
| main → pipeline | `FrameMsg` | One 16 kHz mono frame (512 Float32, ArrayBuffer transfer) |
| main → pipeline | `ControlMsg` | `shutdown` |
| pipeline → main | `HintMsg` | A hint to paint (text + source) |
| pipeline → main | `MetricMsg` | Bench stage timestamp |
| pipeline → main | `LogMsg` | Structured log (kept off stdout to protect sidecar stream) |
| pipeline → main | `ReadyMsg` | Pipeline is warm and ready |

### main → renderer (IPC, contextBridge)

The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`). The preload (`src/main/preload.ts`) exposes exactly two methods via `contextBridge`:
- `onHint(cb)` — subscribe to hints; returns an unsubscribe function.
- `ready()` — signal that the renderer is live and safe to receive hints.

No other capability crosses the bridge.

## Overlay window

Source: `src/main/index.ts:createOverlay()`

Key properties:
- **900×90 px**, bottom-centred, 100 px above the dock.
- **Transparent + frameless** — `backgroundColor: '#00000000'`, `frame: false`, `hasShadow: false`.
- **Always on top** — uses `'screen-saver'` level to win against fullscreen Zoom.
- **Click-through** — `setIgnoreMouseEvents(true, { forward: true })`. Never steals focus (`focusable: false`).
- **Content protection** — `setContentProtection(true)`. Hides the window from screen share/recording. `COPILOT_NO_PROTECT=1` disables it for A/B testing the gate.
- **Visible on all workspaces** — including fullscreen.

The renderer (`src/renderer/overlay.ts`) does exactly one thing: paint the hint text into a `<span>`. RETRIEVED hints are dimmed (55% white); GENERATED hints are full white — so the eye learns to trust the bright one. No framework, no state, no logic.

## Lifecycle

### Startup

1. Electron app ready → `createOverlay()` — the window loads and sends `overlay:ready` via IPC.
2. `startPipeline()` (from `pipeline-host.ts`):
   - `checkModels()` — verifies `~/models/silero_vad.onnx` + `zipformer-streaming/`. If missing, logs a warning and stays idle (overlay still runs standalone).
   - `utilityProcess.fork('pipeline.js')` — spawns the pipeline child.
   - `LlamaSupervisor.ensure()` — checks `/health`; if not running, spawns `llama-server` and polls until healthy (60 s timeout).
   - Sends `InitMsg` to the pipeline (model paths, prompts, playbook TSV, max turns).
   - Pipeline initializes VAD + STT per leg, prefills the LLM warm prefix, sends `ReadyMsg`.
   - Spawns the Swift sidecar; frames start flowing.

### Frame processing (hot path)

```
sidecar stdout → main demux → postMessage(frame) → pipeline onFrame
  → per-leg serial chain (Promise tail)
    → VAD.accept(samples) → VadEvent
      → SILENCE: skip
      → SPEECH_START / SPEECH: STT.accept → state.live → engine.onTranscriptUpdate
      → TURN_END: STT.finish → engine.onTurnEnd (settles transcript)
```

Frames are serialized per-leg via a Promise chain (`leg.tail`) so VAD recurrent state and STT streams stay consistent. The two legs run in parallel.

### Shutdown

`pipeline-host.ts:shutdown()`:
1. Sidecar `SIGTERM`.
2. Pipeline `ControlMsg: shutdown` → pipeline closes STT streams, clears legs.
3. `utilityProcess.kill()`.
4. `LlamaSupervisor.stop()` — SIGTERM the llama-server if we spawned it.

## Build configuration

`electron.vite.config.ts` defines three build targets:
- **main** — `src/main/index.ts` + `src/pipeline/index.ts` as two rollup entries in the same bundle. Both use `externalizeDepsPlugin()` so native addons (`onnxruntime-node`, `sherpa-onnx-node`) are never bundled.
- **preload** — `src/main/preload.ts`.
- **renderer** — `src/renderer/index.html` (Vite root: `src/renderer`).

Path alias: `@shared` → `src/shared` (shared across all targets).

`tsconfig.json` is strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Excludes `node_modules`, `out`, `src/main/java`, `native`.

## Environment variables

| Variable | Effect |
|---|---|
| `COPILOT_NO_PROTECT=1` | Disable content protection (A/B test the screen-share gate) |
| `COPILOT_DEMO=1` | Cycle fake hints through the overlay (no models/llama needed) |
| `COPILOT_DEBUG=1` | Verbose per-leg logging: frame count, audio level, VAD probability |
| `COPILOT_MIC_SPECULATE=1` | Speculate on mic leg too (testing without Screen Recording permission) |
| `COPILOT_PLACEHOLDER=0` | Suppress the initial "ready" placeholder hint |

See [Operations & setup](operations.md) for model paths, llama-server flags, and CLI subcommands.
