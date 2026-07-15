# Port this app from Java to Node/Electron

Read the existing Java source first, including the comments. The comments carry
reasoning that is not recoverable from the code, and several things that look
like sloppiness are load-bearing. Do not start writing until you've read
`HintEngine.java`, `TranscriptState.java`, and `LlamaClient.java` — those three
files contain the entire idea; everything else is plumbing around them.

## What this app is

A live conversation copilot. It listens to both legs of a call, and shows the
user a short hint about what to say next, on a floating overlay.

The one idea: **the serial path (VAD → STT → turn-end → LLM → render) is
400-800ms and cannot be made fast enough.** So we don't wait for the turn to end.
We speculatively generate a hint on *every interim transcript update* — roughly
30x/second while the other person is still talking — cancelling the previous
generation each time. ~90% of that work is thrown away. By the time they stop
talking, the hint has already been on screen for half a second. Perceived
latency is ~0 even though real latency is ~600ms.

This only works because inference is local and free at the margin. Every design
decision follows from that.

## Why we're porting (this is the whole scope)

Two reasons, both in the UI layer:

1. `win.setContentProtection(true)` — hides the overlay from screen share.
   Maps to `NSWindow.sharingType = .none` on macOS and `WDA_EXCLUDEFROMCAPTURE`
   on Windows. Not reachable from JavaFX without JNA. This is the reason for the
   port.
2. The overlay is the most design-uncertain part of the system and will be
   rewritten many times. CSS iterates faster than JavaFX.

**We are NOT porting for cross-platform reasons.** The platform-specific work
(system audio capture, window exclusion) has to be written per-platform
regardless of runtime. Don't let "Node is multiplatform" motivate any decision.
Target macOS only. Do not add Windows code paths, abstractions "for Windows
later", or platform-switching layers. They will be wrong.

## Non-negotiable invariants

These will look like things worth cleaning up. They are not. If you "improve" any
of them the app still runs and silently gets 10x slower or subtly wrong.

**1. The prompt is an append-only prefix.**
`TranscriptState.renderPrompt()` emits: system prompt → static context → settled
turns → live turn → `<hint>`. Immutable parts first, volatile parts last, always.

`llama.cpp`'s `cache_prompt` is a *prefix* cache. If any byte before the new
tokens differs from last time, it re-prefills the entire context. Insert a
timestamp, re-order the context block, trim an old turn from the front, or
"tidy" the string building, and TTFT goes from ~40ms to ~800ms with zero errors
and no test failures. Preserve the exact ordering and the exact rendering.

Note the deliberate non-sliding window: turns accumulate to a cap and then reset
once, eating one slow turn, rather than shifting the prefix every turn and eating
a slow turn every time. Keep that.

**2. `cache_prompt: true` + `id_slot: 0` + `--parallel 1`.**
Three parts of one mechanism: one slot, one KV cache, stays warm. Keep all three.
Do not make the slot dynamic. Do not add a connection pool.

**3. Cancel-previous is the design, not a bug.**
`HintEngine` cancels the in-flight generation on every new speculation. That's
intentional — the previous one was based on a transcript that no longer exists.
Letting them race produces flicker or a stale hint winning. In Node, an aborted
generation must actually abort: use `AbortController` wired through to the fetch,
and check the abort signal in the SSE loop before dispatching each token.

**4. 512-sample frames.**
Not a round number by accident: it's exactly Silero VAD v5's required window.
Don't change the frame size. Don't make it configurable. v5 also has a different
signature from v4 (combined `state` tensor, not separate `h`/`c`) — the Java code
targets v5.

**5. Two capture legs = speaker diarization.**
Mic leg is the user, system-audio leg is the far end. Separate VAD + separate STT
stream per leg. That's free, exact diarization; never add a diarization model.
Only the far-end leg triggers speculation — hinting at the user mid-sentence is
just distracting.

**6. `HANGOVER_MS` is the biggest number in the latency budget.**
250ms of silence before we call the turn over, added in full to every hint.
Keep it exposed and obvious. Don't bury it in a config object.

## Target structure

```
src/
  main/           Electron main: window, sidecar spawn, llama-server supervision, IPC
  pipeline/       utilityProcess: VAD, STT, HintEngine, LlamaClient
  renderer/       overlay — HTML/CSS/TS, no framework
  shared/         types shared across process boundaries
native/capture/   Swift package -> binary
test/
```

TypeScript, strict. `electron-vite` for the build. **No React** — the renderer is
one text node; a framework is pure overhead here.

**The pipeline must not run in the Electron main process.** ONNX inference on the
main thread janks the window. Put VAD/STT/engine in a `utilityProcess`. Renderer
does nothing but paint what it's sent.

Process layout:
```
swift sidecar --stdout(PCM)--> main --> utilityProcess (VAD/STT/engine)
                                            |
                                            +--HTTP/SSE--> llama-server
                                            |
                               main <--hints-- 
                                 |
                                 +--webContents.send--> renderer (overlay)
```

## The Swift sidecar (new code — this is the real work)

Replaces `AudioCapture.java` entirely and kills the BlackHole dependency.

- System audio: **ScreenCaptureKit** (`SCStream` with audio capture enabled).
- Mic: **AVAudioEngine** input node.
- Resample with `AVAudioConverter` to 16kHz mono Float32.

**Do not port the box-filter resampler in `AudioCapture.toMono16k()`.** It exists
only because `javax.sound.sampled` gave us 48k stereo int16 and nothing better.
`AVAudioConverter` does this properly. Delete the concept.

Protocol — stdout is binary, stderr is logs, keep it dumb:

```
Each record is exactly 2049 bytes:
  byte 0        : leg  (0x00 = mic/ME, 0x01 = system/THEM)
  bytes 1..2048 : 512 × Float32 little-endian, 16kHz mono
```

Fixed-size records mean no framing parser and no partial-read bugs. Read exactly
2049 bytes at a time in Node and dispatch by leg.

Emit permission errors as JSON lines on **stderr**, never stdout — a single stray
byte on stdout desynchronises the whole stream.

ScreenCaptureKit needs Screen Recording permission (audio capture rides on the
screen-capture entitlement). Handle the not-yet-granted case explicitly: the
first run will fail, and it must fail with a message that tells the user to open
System Settings, not with a stack trace.

## Port map

| Java | Node | Notes |
|---|---|---|
| `HintEngine.java` | `pipeline/hint-engine.ts` | Port near-verbatim. `AbortController` replaces `Generation.cancel()`. Keep `DEBOUNCE_MS = 200`. |
| `TranscriptState.java` | `pipeline/transcript-state.ts` | Verbatim. Do not refactor the string building. |
| `Playbook.java` | `pipeline/playbook.ts` | Verbatim. Trigrams (not words) because Polish inflection defeats bag-of-words — keep. |
| `LlamaClient.java` | `pipeline/llama-client.ts` | `fetch` + `ReadableStream` SSE parsing. Keep every field in the request body. |
| `SileroVad.java` | `pipeline/vad.ts` | `onnxruntime-node`. Same v5 tensor signature, same hysteresis (ENTER 0.5 / EXIT 0.35), same hangover. |
| `SherpaStt.java` | `pipeline/stt.ts` | `sherpa-onnx-node`. Keep the `SttEngine` interface — engines get swapped, Polish WER is unresolved. |
| `AudioCapture.java` | **deleted** | → Swift sidecar |
| `Overlay.java` | `renderer/*` | **Rewrite, don't port.** Keep only: 3 words max, ~30px semibold, bottom-centre, dim for RETRIEVED / bright for GENERATED. |
| `Main.java` | `main/index.ts` | Wiring only. |

## Electron window spec

Get these exactly right; several are non-obvious:

```ts
new BrowserWindow({
  transparent: true,
  backgroundColor: '#00000000',   // required WITH transparent on macOS
  frame: false,
  hasShadow: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  focusable: false,               // never steal focus from the call
  resizable: false,
  webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
})

win.setContentProtection(true)                  // THE reason for this port
win.setAlwaysOnTop(true, 'screen-saver')        // plain alwaysOnTop loses to fullscreen Zoom
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
win.setIgnoreMouseEvents(true, { forward: true })  // clicks pass through to the call
```

`'screen-saver'` level and `visibleOnFullScreen` are both required or the overlay
vanishes the moment someone fullscreens the call — which is when it's needed.

## llama-server

Keep it as a separate process over localhost. Do **not** switch to
`node-llama-cpp` or embed inference. The separate process buys a supervisor,
model restarts without app restarts, and slot discipline that's harder to reason
about in-process. Localhost round-trip is ~1ms.

Main should spawn it if it isn't already running, poll `/health` until ready, and
surface a clear error if the model file is missing. Flags are in
`LlamaClient.java`'s header comment — carry them over exactly, including
`--parallel 1`.

## Tests that must pass

**Prefix stability (the important one).** This catches the silent perf killer:

```
Render the prompt. Settle a new turn. Render again.
Assert: everything in render#1 up to and including the last settled turn
        is a byte-identical prefix of render#2.
```

If someone later adds a timestamp or reorders the context block, this fails
instead of quietly costing 760ms per hint.

**Cancellation.** Fire 10 `onTranscriptUpdate()` calls in rapid succession
against a stub LLM. Assert exactly one generation survives and 9 abort.

**Playbook.** Polish inflection cases: `drogo` / `drogie` / `za drogi` must all
hit the same entry. Below-threshold input must return nothing, not a bad guess.

**Bench harness.** Add `--bench <wav>` that replays a file through the pipeline
and prints p50/p95 for each stage boundary:
`frame_in → vad_out → stt_interim → speculate_fired → first_token → painted`.
This is how the port gets validated — everything else is unverifiable without a
real call.

Also port `--list-devices`.

## Out of scope — do not do these

- Windows support, or any abstraction anticipating it
- React/Vue/Svelte in the renderer
- Embedding llama.cpp
- A diarization model (the two legs already are one)
- Making frame size, VAD window, or slot count configurable
- Refactoring `TranscriptState`'s string building "for readability"
- Retry/backoff on aborted generations — they're *supposed* to die
- Cloud STT/LLM fallbacks. Local-only is the product, not an optimisation.

## Order of work

1. Scaffold + build, empty overlay window with all the flags above. Verify
   `setContentProtection` actually works — start a screen recording and confirm
   the overlay is absent. **If this doesn't work, stop. The port has no point.**
2. Swift sidecar → PCM on stdout. Verify with a Node script that dumps a wav and
   plays back recognisably.
3. Port `TranscriptState` + `Playbook` + tests. Pure logic, no I/O.
4. Port `LlamaClient`, verify TTFT <100ms against a warm server. If it's ~800ms,
   the prefix cache is broken — fix before continuing.
5. Port VAD + STT.
6. Port `HintEngine`, wire end to end.
7. Bench harness, then a real call.

Report at each step. Don't proceed past step 1 or step 4 if the check fails —
both are load-bearing for whether this is worth doing at all.
