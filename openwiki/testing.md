# Testing Guide

## Framework

- **Runner**: Vitest (`vitest.config.ts`), node environment
- **Location**: `test/` — all `*.test.ts` files
- **Run**: `npm test` (single run) or `npm run test:watch`

## Test Suites

### 1. VAD State Machine (`test/vad.test.ts`)

Tests the pure hysteresis + hangover state machine (`SileroVad.step(p)`) with synthetic probabilities — **no ONNX model required**. Uses `SileroVad.headless()` which constructs the object with a null session.

Covers:
- Enter at ≥0.5, stay speaking down to 0.35 (hysteresis band)
- `TURN_END` fires after exactly `HANGOVER_FRAMES` (7) of sub-EXIT frames
- A single loud frame mid-hangover resets the silence counter → full hangover again
- `reset()` returns to idle

**Key insight**: `HANGOVER_MS` (250ms) is the dominant latency line item. The test pins the exact frame count so changes to it are caught.

### 2. Playbook Trigram Matching (`test/playbook.test.ts`)

Tests `Playbook.parse()` and `Playbook.nearest()` with the shipped Polish objection set.

Covers:
- `drogo` / `drogie` / `za drogi` all hit the same "za drogo" entry (Polish inflection)
- Below-threshold input returns `null` (not a bad guess)
- Distinct objections route to their own hints
- Blank lines and `#` comments are ignored during parsing

**Key insight**: Trigrams, not words, because Polish inflection eats bag-of-words alive. The test validates that the trigram approach handles inflected variants.

### 3. Transcript State Prefix Stability (`test/transcript-state.test.ts`)

The most important test — validates that the settled prefix stays byte-identical across turns and interim revisions. If someone adds a timestamp or reorders context, this test fails instead of quietly costing ~760ms per hint.

Covers:
- Settling a new turn keeps the prior settled prefix byte-identical
- Live interim updates never disturb the settled prefix
- The immutable head (system + playbook) is always the literal prefix
- Exact string rendering (speakers, tags, newlines)
- Blank settle is a no-op on history but clears the live turn
- `retrievalKey()` only exposes THEM, never ME

### 4. Hint Engine Cancel Logic (`test/hint-engine.test.ts`)

Tests the cancel-previous design with a `StubLlm` that records every generation and whether it was cancelled. Uses `vi.useFakeTimers()` to control the 200ms debounce.

Covers:
- 10 successive speculations → exactly one survives, nine abort (the core design)
- Rapid burst within debounce window coalesces to a single generation
- Identical prompt does not re-fire (no-op guard)
- Emits an instant `RETRIEVED` hint before any generation
- `shutdown()` cancels the in-flight generation

**Key insight**: Cancel-previous is the design, not a bug. Every new speculation aborts the in-flight one because it was based on a transcript that no longer exists.

### 5. WAV Reader (`test/wav.test.ts`)

Tests `parseWav()`, `toMono16k()`, `toFrames()` with synthetic PCM16 WAV buffers.

Covers:
- PCM16 mono 16k parsing preserves samples
- `toMono16k` is identity for mono 16k
- Stereo downmix + 48k→16k resample
- `toFrames` yields 512-sample frames, drops partial tail

## What's Not Unit-Tested

- **STT engine**: Requires native addons + model files. Tested via `scripts/check-models.mjs` and `--bench` end-to-end.
- **LlamaClient**: Requires a running llama-server. Tested via `--ttft` gate.
- **Sidecar I/O**: Requires Swift binary + macOS permissions. Tested via `--list-devices` and manual run.
- **Overlay rendering**: Pure DOM, but Electron-dependent. Tested via `COPILOT_DEMO=1`.

## Test-to-Source Mapping

| Test | Source | Concept |
|---|---|---|
| `vad.test.ts` | `src/pipeline/vad.ts` | Hysteresis + hangover state machine |
| `playbook.test.ts` | `src/pipeline/playbook.ts` | Trigram cosine matching, Polish inflection |
| `transcript-state.test.ts` | `src/pipeline/transcript-state.ts` | Prefix-cache invariant (byte-identical prefix) |
| `hint-engine.test.ts` | `src/pipeline/hint-engine.ts` | Cancel-previous, debounce, retrieval layer |
| `wav.test.ts` | `src/pipeline/wav.ts` | WAV parse, resample, frame chunking |
