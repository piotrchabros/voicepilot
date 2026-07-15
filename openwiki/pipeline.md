# Pipeline

The real-time audio → hint pipeline. Runs entirely inside a `utilityProcess` (off the Electron main thread). Entry point: `src/pipeline/index.ts`.

## Processing chain

```
FrameMsg (512 Float32, 16 kHz, per leg)
  │
  ├─ SileroVad.accept(samples) → VadEvent
  │    SILENCE → skip
  │    SPEECH_START / SPEECH → STT.accept → state.live → engine.onTranscriptUpdate
  │    TURN_END → STT.finish → engine.onTurnEnd
  │
  ├─ SherpaStt (streaming Zipformer transducer)
  │    accept(frame) → decode loop → interim() → finish() (reset stream)
  │
  └─ HintEngine
       onTranscriptUpdate:
         Layer 1: playbook.nearest(key) → instant RETRIEVED hint
         Layer 2: debounce 200ms → LlamaClient.streamHint → GENERATED hint
       onTurnEnd: state.settle(who, finalText)
```

### Per-leg isolation

Each capture leg (mic/ME, system/THEM) gets its own `SileroVad` + `SherpaStt` instance. VAD recurrent state and STT streams are leg-local. Frames within a leg are serialized via a Promise chain (`leg.tail`) to preserve ordering. The two legs process in parallel.

The shared state — `TranscriptState`, `HintEngine`, `LlamaClient`, `Playbook` — is single-instance across both legs.

## VAD (Silero)

Source: `src/pipeline/vad.ts`

Silero VAD v5 on ONNX Runtime. ~1 ms per 32 ms frame on one CPU core. Single-threaded ONNX session (`intraOpNumThreads: 1` — the model is tiny, more threads is overhead).

**v5 signature** (v4 differs — separate h/c inputs):
- Input: `input` (1, 512) float, `state` (2, 1, 128) float, `sr` (1,) int64
- Output: `output` (1, 1) float (speech probability), `stateN` (2, 1, 128) float

### Hysteresis + hangover state machine

The pure state machine is split out from ONNX inference via `step(p)` so it can be unit-tested without the model (`SileroVad.headless()`).

- **ENTER** = 0.5 — speech probability threshold to start speaking.
- **EXIT** = 0.35 — below this while speaking = silence counter increments. Hysteresis: easy to enter, hard to leave (clipping a word tail costs more than a few frames of trailing silence).
- **HANGOVER_MS** = 250 — silence must persist this long before `TURN_END` fires. At 32 ms frames, that's 7 frames (`HANGOVER_FRAMES`). A single loud frame mid-hangover resets the counter.

> **`HANGOVER_MS` is the single largest line item in the latency budget.** It is added in full to every hint. Halving it does more than any model swap. It is deliberately a named constant, not buried in a config object.

### Events

| Event | When | Pipeline action |
|---|---|---|
| `SILENCE` | Idle + prob < ENTER | Skip (don't burn STT cycles on room tone) |
| `SPEECH_START` | Idle + prob ≥ ENTER | Falls through to SPEECH processing |
| `SPEECH` | Speaking + prob ≥ EXIT | STT.accept → state.live → engine.onTranscriptUpdate |
| `TURN_END` | Speaking + HANGOVER_FRAMES of sub-EXIT | STT.finish → engine.onTurnEnd |

## STT (sherpa-onnx streaming Zipformer)

Source: `src/pipeline/stt.ts`, interface: `src/pipeline/stt-engine.ts`

Truly incremental streaming recognition via `sherpa-onnx-node`'s `OnlineRecognizer` + `OnlineStream`. No 30-second window, no chunk-stitching (the README is explicit: Whisper is not here on purpose — it's a 30s encoder-decoder, and every "streaming Whisper" re-encodes a growing buffer).

- **Model**: streaming Zipformer transducer (encoder + decoder + joiner + tokens). Needs a model whose language list covers Polish.
- **Config**: `featConfig: { sampleRate: 16_000, featureDim: 80 }`, `numThreads: 2`, `provider: 'cpu'`, `decodingMethod: 'greedy_search'`.
- **Endpointing disabled** — `enableEndpoint: false`. Silero VAD owns endpointing. Two components racing to decide turn-end is a bug.
- **Flow**: `acceptWaveform` → `decode` loop while ready → `getResult().text` for interim → `reset(stream)` on finish.
- **Vendor swap**: the `SttEngine` interface abstracts `accept` / `interim` / `finish` / `close`. You WILL swap engines — Polish WER is where they all diverge.

> ⚠️ The Node binding surface moves. If config keys or method names stop resolving, check `node_modules/sherpa-onnx-node/streaming-asr.js` — concepts are stable even when names aren't.

## HintEngine

Source: `src/pipeline/hint-engine.ts`

The core idea. Everything else is plumbing.

### Two-layer hints

**Layer 1 — Retrieval** (~10 ms, synchronous):
- On every `onTranscriptUpdate()`, extract `state.retrievalKey()` (live THEM text).
- If key length > 12 chars, run `playbook.nearest(key)` — character-trigram cosine similarity.
- If a match is found, immediately emit a `RETRIEVED` hint. Always shows something, instantly.

**Layer 2 — Generation** (debounced, ~50 ms TTFT):
- A 200 ms debounce timer fires `speculate()`.
- `speculate()` renders the full prompt via `state.renderPrompt()`, compares to `lastPrompt` (skip if identical — interim transcripts revise themselves, don't re-fire on a no-op).
- Aborts the previous in-flight generation, starts a new `LlamaClient.streamHint`.
- Each token is accumulated and emitted as a `GENERATED` hint, overwriting the RETRIEVED one.

### Speculative cancellation

> Cancel-previous is the design, not a bug. Every new speculation aborts the in-flight one because it was based on a transcript that no longer exists. Letting them race produces flicker or a stale hint winning.

`DEBOUNCE_MS` = 200. Below ~150 ms you thrash; above ~400 ms you lose the head start.

### Turn end

`onTurnEnd` does NOT kick off a generation and wait. The hint is already up. It just settles the transcript (`state.settle(who, finalText)`) so the next speculation has clean history.

### Speculation filter

Only speculates on `THEM` (the far end). Hinting at yourself mid-sentence is distracting. `COPILOT_MIC_SPECULATE=1` lifts this for testing so the mic leg alone can drive hints (no Screen Recording permission needed).

## LlamaClient

Source: `src/pipeline/llama-client.ts`

Talks to a local `llama-server` over HTTP SSE (`/completion` endpoint).

### Prefix cache — the whole game

The entire performance model depends on three things:
1. `cache_prompt: true` — tell llama-server to reuse the cached prefix.
2. `id_slot: 0` — pin to the one warm slot (`--parallel 1` = one KV cache).
3. **Append-only prompt** — the prompt grows at the end only. Everything before the new tokens must be byte-identical to last time.

Get this right → TTFT is ~30–50 ms (you only prefill the new tokens). Get it wrong → re-prefill 4k tokens on every interim → slower than a cloud API.

### Request parameters

| Parameter | Value | Why |
|---|---|---|
| `stream` | `true` | SSE token-by-token |
| `cache_prompt` | `true` | The entire point |
| `id_slot` | `0` | Pin to the warm slot |
| `n_predict` | `24` | Hints are ≤10 words; don't let it ramble |
| `temperature` | `0.3` | |
| `top_p` | `0.9` | |
| `stop` | `['\n', '</hint>']` | End at the first newline |

### Cancellation

`streamHint` returns a `Generation` handle with `cancel()` (AbortController). The abort signal is checked in the SSE loop before dispatching each chunk — a cancelled generation must not paint another token. Aborted generations are swallowed — no retry, no backoff.

### Warm prefix

`warm(systemPrompt)` fires one generation at startup so the model is resident and the system prompt is cached. Called once during pipeline init.

## TranscriptState

Source: `src/pipeline/transcript-state.ts`

Append-only conversation state. The most invariant-critical file in the repo.

### Prefix-cache invariant

`renderPrompt()` builds:
```
<systemPrompt>\n\n      ← never changes
<staticContext>\n\n      ← never changes
<transcript>\n
  Them: ...               ← grows at the end only
  Me: ...
  Them: <live text>       ← volatile tail (revised ~30×/sec)
</transcript>\n\n
<hint>
```

**Immutable prefix first, volatile tail last.** This ordering is the whole reason TTFT stays double-digit. If you insert a timestamp, reorder, or trim an old turn, you invalidate the cache.

### Grow-then-reset window

Not a sliding window. Turns accumulate until `maxTurns` (12), then the oldest is shifted off — one slow turn, rarely. A sliding window would shift the prefix on every turn and eat a slow turn every time.

### Retrieval key

`retrievalKey()` returns the live THEM text only (empty for ME). The retrieval layer matches on what the other person is saying right now.

> ⚠️ DO NOT refactor `renderPrompt()`'s string building "for readability." The exact ordering and rendering are load-bearing.

## Playbook

Source: `src/pipeline/playbook.ts`, data: `playbook.tsv`

Instant retrieval layer. Character-trigram cosine similarity over a TSV of `trigger <TAB> hint`.

### Why trigrams?

Polish inflection eats bag-of-words matchers alive: "drogo" / "drogie" / "za drogi" are three different tokens and the same objection. Character trigrams see through inflection.

### Matching

- Trigrams: lowercase, strip non-alphanumeric (Unicode-aware), pad with spaces, extract 3-char substrings.
- Cosine similarity with a `MIN_SCORE` threshold of 0.25. Below this, return `null` (show nothing rather than noise).
- Iterate the smaller map for the dot product (performance).

### Playbook format

`playbook.tsv` — one entry per line: `trigger phrase <TAB> hint to display`. Blank lines and `#` comments are ignored. The shipped playbook contains Polish sales objections:
- "za drogo" → price vs cost-of-inaction
- "muszę pogadać z zespołem" → who else decides?
- "wyślij ofertę" → don't send, book a walkthrough
- "nie mamy teraz budżetu" → budget cycle question
- "mamy już dostawcę" → what would you change?
- "musimy to przemyśleć" → what specifically concerns you?

## WAV reader

Source: `src/pipeline/wav.ts`

Used by the bench harness (`--bench <wav>`). Parses RIFF/WAVE files (PCM16 or IEEE float32, mono or stereo, any sample rate), downmixes to mono, linearly resamples to 16 kHz, and splits into 512-sample frames. Pure buffer operations — unit-testable without any audio hardware.
