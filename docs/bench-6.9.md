# Bench evidence — Task 6.9 (analysis latency/tokens + card-path baseline)

spec.md §7: *"Bench reports analysis p50/p95 and tokens/call separately from
`BenchStage`; card p95 must be unchanged vs baseline."* This records the
implementation, the unit-test coverage, and one real (non-mocked VAD/STT)
`--bench` run demonstrating the new reporting sections end to end.

## What changed

`src/main/bench.ts` (`--bench <wav>`) now runs **two passes** over the same
wav corpus instead of one:

1. **Pass 1/2 — analysis disabled.** Identical to the pre-6.9 `--bench`
   behavior: VAD → STT → `HintEngine`, printing the existing `BenchStage`
   table (`report()`, unchanged shape/labels).
2. **Pass 2/2 — analysis enabled(fake).** Same wav, same realtime cadence,
   `HintEngine` wired exactly as pass 1, PLUS an `AnalysisEngine` instance
   wired to a new `FakeAnalysisLlm` (deterministic latency/token counts, never
   touches the network — mirrors `FakeCloudClient` in
   `test/cloud-llm-client.test.ts`). The real `CloudLlmClient`/
   `resolveCloudLlmConfig` are never constructed by `--bench`; the cloud-send
   flag stays functionally OFF regardless of `LLM_ANALYSIS_ENABLED`/cloud env.

Three new sections print after both passes:

- `report(pass1.timings)` — the existing `BenchStage` table, **unchanged**.
- `reportAnalysis(pass2.analysisSamples)` — a **separate** table: n,
  analysis p50(ms)/p95(ms), avg prompt chars (input-side accounting, same
  char budget `ANALYSIS_MAX_PROMPT_CHARS` bounds), avg output tokens/call
  (output-side accounting, capped at `ANALYSIS_MAX_OUTPUT_TOKENS` — Task
  6.4's hard per-call caps).
- `reportCardPathComparison(compareCardPaths(pass2.timings, pass1.timings))`
  — per-`BenchStage`-pair p50/p95 for "with analysis" vs "without analysis",
  plus a final `card p95: UNCHANGED` / `CHANGED` verdict. **Method**: a stage
  counts as changed only when BOTH runs have a real (non-null) percentile for
  it AND `|delta| >= noiseThresholdMs` (default 5ms) — a stage missing in
  both runs (e.g. no llama-server reachable) is never counted as evidence of
  either regression or stability.

New exports (all pure, unit-tested with fixture data — no models/wav
required): `AnalysisSample`, `FakeAnalysisLlm`, `reportAnalysis`,
`CardPathComparisonRow`, `CardPathComparisonResult`, `compareCardPaths`,
`reportCardPathComparison`. `runBench`/`runPass` themselves stay
integration-only (same convention `report()`'s own doc comment already
states: "everything else is unverifiable without a real call").

## Unit-test coverage (`CI=true npm test`, no models needed)

`test/bench-report.test.ts` — 13 tests, all green:

- `FakeAnalysisLlm`: records one `AnalysisSample` per settled call with
  correct `latencyMs`/`promptChars`/`outputTokens`; caps `outputTokens` at
  the caller's `maxOutputTokens`; a cancelled generation records **no**
  sample and never fires `onToken`; `done` never rejects (mirrors
  `CloudLlmClient`'s "never rejects" contract).
- `reportAnalysis()`: prints n/p50/p95/avg-prompt-chars/avg-tokens for a
  fixture sample set; n=0 prints an em-dash placeholder, not a crash.
- `compareCardPaths()`: flags `unchanged` when every shared-stage delta is
  under the noise threshold; flags `changed` when a delta exceeds it; a
  stage missing from **both** runs is never counted as a regression
  (`deltaP50`/`deltaP95` stay `null`, not zero-filled).
- `reportCardPathComparison()`: prints the table plus the final verdict line.

## Real `--bench` run (evidence)

Command (macOS, this worktree, `712f113697f074e1d3c6ae73d3b4b0e93aa3b95a`,
run on 2026-07-16):

```bash
npm run build
npx electron . --bench /tmp/bench-6.9-corpus.wav
```

Corpus: a 14.2s synthetic wav built from three Polish `say -v Zosia` TTS
utterances (real VAD/Sherpa-STT input, not fixture timestamps) separated by
short silences, containing price-objection/timing-objection trigger phrases
("za drogo", "nie stać nas", "może później, nie teraz") — real
`silero_vad.onnx` + `zipformer-streaming` models from `~/models/` did the
VAD/STT work; `llama-server` (Qwen3-4B, `~/models/Qwen3-4B-Instruct-Q4_K_M.gguf`)
was reachable at `127.0.0.1:8080` for this run.

Output:

```
bench: /tmp/bench-6.9-corpus.wav -> streaming frames at natural cadence (~32ms/frame)

bench: pass 1/2 — card path WITHOUT analysis engine (baseline)
bench: processed 444 frames (14.208s @16k mono)

bench: pass 2/2 — card path WITH analysis engine enabled (FakeAnalysisLlm — functionally OFF for any real cloud LLM)
knowledge base: directory not found: .../knowledge — loading empty
bench: processed 444 frames (14.208s @16k mono)

stage boundary        n     p50(ms)   p95(ms)   transport
---------------------------------------------------------
frame_in -> vad_out        0          —         —   —
vad_out -> stt_interim     0          —         —   —
stt_interim -> speculate   0          —         —   —
speculate -> first_token   0          —         —   —
first_token -> painted     0          —         —   —

analysis latency + tokens/call (separate from BenchStage above)
n     p50(ms)   p95(ms)   avg prompt chars   avg output tokens/call
------------------------------------------------------------------
   2      220.0     220.0               890.5                    48.0

card path (hint) p50/p95 — analysis engine enabled(fake) vs disabled
stage boundary        with-p50   without-p50   with-p95   without-p95
----------------------------------------------------------------------
frame_in -> vad_out              —             —           —             —
vad_out -> stt_interim           —             —           —             —
stt_interim -> speculate         —             —           —             —
speculate -> first_token         —             —           —             —
first_token -> painted           —             —           —             —
card p95: UNCHANGED (every shared stage delta < noise threshold)
```

### Reading this run honestly

- The **analysis** section is real, non-trivial evidence: `AnalysisEngine`
  fired on real settled `THEM` turns (2 debounced calls survived
  cancel-previous out of 3 spoken turns — the two turns' ~0.8s silence gap
  is shorter than `ANALYSIS_DEBOUNCE_MS` (1.5s), so the middle turn's
  pending call was superseded before it fired, exactly the cancel-previous
  contract AnalysisEngine.md documents), producing real `promptChars`/
  `outputTokens` accounting from a real `TranscriptState`/`KnowledgeBase`
  (empty KB in this run — no `knowledge/` dir shipped in this worktree, an
  empty-safe load per spec.md §7, not a bug).
- The **card path** section's `UNCHANGED` verdict in this specific run is
  **trivial, not a strong regression check**: `BenchStage` shows n=0 in
  BOTH passes, meaning `HintEngine` never actually dispatched a speculative
  LLM generation in either pass despite `llama-server` being reachable —
  this local `sherpa-onnx zipformer-streaming` model instance in
  `~/models/` did not reliably transcribe the synthesized-TTS Polish audio
  into text matching the Tier-1 classifier's trigger phrases closely enough
  to pass `shouldGenerate`'s gate (see `src/pipeline/hint-engine.ts`,
  `src/pipeline/classifier.ts`). Two zero-sample runs being "identical" is
  real but weak evidence — it confirms `AnalysisEngine` running alongside
  `HintEngine` did not *crash*, *block*, or *steal CPU badly enough to move
  an already-empty baseline*, but does **not** by itself prove p95 is
  unchanged under load with real generation happening. `compareCardPaths()`
  is written to give a **meaningful, non-trivial** verdict the moment a run
  produces real samples in both passes (see its unit tests, which exercise
  the non-trivial "changed" and "unchanged" cases with populated sample
  data) — closing this gap needs a bench corpus recorded from an actual
  captured call (per the pre-existing `runBench()` doc comment: "everything
  else is unverifiable without a real call"), not a synthesized-TTS wav.
- **Structural argument for "unchanged" independent of this run's numbers**:
  `AnalysisEngine` and `HintEngine` are separate class instances with
  independent `StageClock`/timer state; `AnalysisEngine.onTurnEnd` never
  touches `HintEngine`'s `pending`/`inFlight` fields or its `sink`, and
  `AnalysisEngine`'s only wiring point in `runPass()` is `analysisEngine?.onTurnEnd(...)`
  called immediately after (never before or in place of) `engine.onTurnEnd(...)`
  — the hint card's own debounce/cancel-previous timers are untouched by
  the analysis engine's presence. The one real shared resource is CPU
  (single Node event loop) — `ANALYSIS_DEBOUNCE_MS` (1.5s) keeps analysis
  calls off the hint card's ~200ms debounce window in the vast majority of
  turns, and `FakeAnalysisLlm`'s "work" is a single `setTimeout`, not real
  CPU-bound computation.

## Follow-up (not this task)

Re-run `--bench` against a wav recorded from an actual live call (or a
corpus confirmed to transcribe cleanly through the shipped
`zipformer-streaming` model) once one is available, to get a non-trivial
`compareCardPaths()` verdict with populated `BenchStage` samples in both
passes.
