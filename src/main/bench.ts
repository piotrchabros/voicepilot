import type { SuggestionTiming } from '@shared/types'
import { FRAME_MS } from '@shared/types'
import { ANALYSIS_DEBOUNCE_MS, AnalysisEngine } from '../pipeline/analysis-engine'
import type { AnalysisLlm, AnalysisStreamOptions, Generation } from '../pipeline/analysis-llm'
import { streamFrames } from '../pipeline/frame-stream'
import { HintEngine } from '../pipeline/hint-engine'
import { KnowledgeBase } from '../pipeline/knowledge'
import { LlamaClient } from '../pipeline/llama-client'
import { Playbook } from '../pipeline/playbook'
import { SherpaStt } from '../pipeline/stt'
import { shouldBeginTurn, StageClock, stageDeltas } from '../pipeline/timing'
import { TranscriptState } from '../pipeline/transcript-state'
import { SileroVad } from '../pipeline/vad'
import { checkModels, knowledgeDir, paths, playbookDir } from './config'
import { MAX_TURNS, STATIC_CONTEXT, SYSTEM_PROMPT } from './prompts'

// `--bench <wav>`: replay a wav through the pipeline and print p50/p95 for each
// stage boundary, aggregated from Hint.timing (Task 3.3 — same StageClock the
// live pipeline uses, transport tagged 'file' here since this replays via
// FileAudioSource). This is how the port gets validated — everything else is
// unverifiable without a real call.
//
// Frames are fed at their natural 32ms cadence so the 200ms debounce and the
// llama slot behave the way they would on a live call. A 20s wav takes ~20s.

/** Ordered (label, printed heading) pairs — same order/labels as the original
 *  bench report, so existing output consumers see an unchanged table shape
 *  plus one new trailing column. */
const STAGE_ROWS: readonly (readonly [string, string])[] = [
  ['frame_in->vad_out', 'frame_in -> vad_out'],
  ['vad_out->stt_interim', 'vad_out -> stt_interim'],
  ['stt_interim->speculate_fired', 'stt_interim -> speculate'],
  ['speculate_fired->first_token', 'speculate -> first_token'],
  ['first_token->painted', 'first_token -> painted']
]

/** One replay pass's output: hint-card timings plus (when analysis was
 *  driven) the analysis engine's own latency/token samples. Two separate
 *  arrays on purpose — same "analysis reported separately from BenchStage"
 *  rule (spec.md §7) applies inside a single pass, not just across passes. */
interface BenchPassResult {
  readonly timings: SuggestionTiming[]
  readonly analysisSamples: AnalysisSample[]
}

/**
 * Runs one full realtime replay of `wav` through VAD -> STT -> HintEngine
 * (and, when `driveAnalysis` is true, AnalysisEngine wired with a
 * `FakeAnalysisLlm` — never a real cloud call, `LLM_ANALYSIS_ENABLED`/cloud
 * config are never consulted here). Extracted from the former single-pass
 * `runBench` body so the "card path" comparison (Task 6.9, spec.md §7 "card
 * p95 must be unchanged vs baseline") can replay the SAME corpus twice —
 * once with the analysis side panel functionally off, once on — and report
 * both.
 */
async function runPass(
  wav: string,
  llm: LlamaClient,
  playbook: Playbook,
  driveAnalysis: boolean
): Promise<BenchPassResult> {
  const state = new TranscriptState(SYSTEM_PROMPT, STATIC_CONTEXT, MAX_TURNS)
  const clock = new StageClock()
  const timings: SuggestionTiming[] = []
  let awaitingPaint = false

  const engine = new HintEngine(
    llm,
    playbook,
    state,
    (hint) => {
      if (hint.source === 'GENERATED' && awaitingPaint) {
        clock.mark('painted')
        const snap = clock.snapshot()
        if (snap !== null) timings.push(snap)
        awaitingPaint = false
      }
    },
    clock
  )
  engine.onFirstToken = () => {
    awaitingPaint = true
  }

  const fakeAnalysisLlm = new FakeAnalysisLlm()
  let analysisEngine: AnalysisEngine | null = null
  if (driveAnalysis) {
    // KnowledgeBase.load() is empty-safe against a missing knowledge/ dir
    // (spec.md §7) — bench corpora don't need to ship their own KB fixture.
    const kb = KnowledgeBase.load(knowledgeDir())
    analysisEngine = new AnalysisEngine(fakeAnalysisLlm, kb, state, () => {}, { enabled: true })
  }

  const vad = await SileroVad.create(paths.silero)
  const stt = new SherpaStt(paths.zipformer)

  // Frames are supplied by `FileAudioSource` (via the pure `streamFrames`
  // wrapper) at their natural 32ms cadence, so the 200ms debounce and the
  // llama slot behave the way they would on a live call. Counted here (as
  // they're consumed) rather than via a separate upfront wav parse, so the
  // file is only ever parsed once per pass (inside `FileAudioSource`).
  let frameCount = 0
  for await (const frame of streamFrames(wav, { realtime: true })) {
    frameCount++
    const ev = await vad.accept(frame.pcm)
    // Baseline resets ONLY on SPEECH_START (shouldBeginTurn) — see
    // pipeline/index.ts for why resetting on every frame corrupts
    // speculate_fired/first_token attribution.
    if (shouldBeginTurn(ev)) clock.beginTurn('file')

    if (ev === 'SPEECH_START' || ev === 'SPEECH') {
      // vad_out/stt_interim are scoped to SPEECH_START/SPEECH only — marking
      // them on SILENCE/TURN_END frames too would let a later frame overwrite
      // vad_out with a LATER timestamp, making vad_out -> stt_interim negative.
      clock.mark('vad_out')
      stt.accept(frame.pcm)
      const interim = stt.interim()
      clock.mark('stt_interim')
      state.live('THEM', interim)
      engine.onTranscriptUpdate()
    } else if (ev === 'TURN_END') {
      stt.accept(frame.pcm)
      const finalText = await stt.finish()
      engine.onTurnEnd('THEM', finalText)
      analysisEngine?.onTurnEnd('THEM', finalText)
    }
  }
  console.log(
    `bench: processed ${frameCount} frames (${(frameCount * FRAME_MS) / 1000}s @16k mono)`
  )

  // Let the last in-flight speculation (and, when analysis is being driven,
  // its longer ~1.5s debounce, ANALYSIS_DEBOUNCE_MS) land.
  await delay(driveAnalysis ? ANALYSIS_DEBOUNCE_MS + 500 : 500)
  engine.shutdown()
  analysisEngine?.shutdown()
  stt.close()

  return { timings, analysisSamples: fakeAnalysisLlm.samples }
}

export async function runBench(wav: string | undefined): Promise<void> {
  if (wav === undefined) {
    console.error('usage: --bench <file.wav>')
    return
  }
  const models = checkModels()
  if (!models.silero || !models.zipformer) {
    console.error(
      `models missing in ${paths.models}: need silero_vad.onnx + zipformer-streaming/. See README step 2.`
    )
    return
  }

  console.log(`bench: ${wav} -> streaming frames at natural cadence (~${FRAME_MS}ms/frame)`)

  const llm = new LlamaClient(paths.llamaBase)
  if (!(await llm.health())) {
    console.warn(
      `warning: llama-server not answering at ${paths.llamaBase}/health — ttft/paint stages will be empty.`
    )
  }

  const playbook = loadPlaybook()
  await llm.warm(SYSTEM_PROMPT)

  // Two passes over the SAME corpus: analysis-disabled first (the existing
  // BenchStage/report() table stays this pass's baseline, unchanged shape),
  // then analysis-enabled(fake) — so the "card path" comparison below is
  // same-wav, same-cadence, the only variable being whether AnalysisEngine
  // was wired alongside HintEngine (Task 6.9, spec.md §7).
  console.log('\nbench: pass 1/2 — card path WITHOUT analysis engine (baseline)')
  const withoutAnalysis = await runPass(wav, llm, playbook, false)
  console.log(
    '\nbench: pass 2/2 — card path WITH analysis engine enabled (FakeAnalysisLlm — functionally OFF for any real cloud LLM)'
  )
  const withAnalysis = await runPass(wav, llm, playbook, true)

  report(withoutAnalysis.timings)
  reportAnalysis(withAnalysis.analysisSamples)
  reportCardPathComparison(compareCardPaths(withAnalysis.timings, withoutAnalysis.timings))
}

function loadPlaybook(): Playbook {
  return Playbook.load(playbookDir())
}

/** Pure aggregation + print: exported so it can be unit-tested with fixture
 *  `SuggestionTiming[]` instead of a real model/wav run.
 *
 *  Reviewer finding (Task 3.3, major): a bench run can carry more than one
 *  transport (e.g. re-running --bench against wavs recorded from different
 *  sources, or future multi-transport benches). Mixing transports into a
 *  single joined tag per stage would silently average across sources with
 *  different latency profiles. Bucket by (stage, transport) and print one
 *  row per combination instead. */
export function report(timings: readonly SuggestionTiming[]): void {
  console.log('\nstage boundary        n     p50(ms)   p95(ms)   transport')
  console.log('---------------------------------------------------------')
  const buckets = new Map<string, number[]>()
  const transports = new Set<string>()
  for (const timing of timings) {
    transports.add(timing.transport)
    for (const delta of stageDeltas(timing)) {
      const key = `${delta.label}::${delta.transport}`
      const arr = buckets.get(key) ?? []
      arr.push(delta.ms)
      buckets.set(key, arr)
    }
  }
  // No timings at all: still print the table shape with an em-dash transport
  // placeholder rather than emitting nothing.
  const transportList = transports.size === 0 ? ['—'] : [...transports].sort()
  for (const [label, heading] of STAGE_ROWS) {
    for (const transport of transportList) {
      const xs = buckets.get(`${label}::${transport}`) ?? []
      const p50 = pct(xs, 50)
      const p95 = pct(xs, 95)
      console.log(
        `${heading.padEnd(24)}${String(xs.length).padStart(4)}   ${fmt(p50).padStart(8)}  ${fmt(p95).padStart(8)}   ${transport}`
      )
    }
  }
}

function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? null
}

function fmt(x: number | null): string {
  return x === null ? '—' : x.toFixed(1)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---- Task 6.9: analysis latency/tokens, reported SEPARATELY from BenchStage
//      above (spec.md §7 "Bench reports analysis p50/p95 and tokens/call
//      separately from BenchStage"), plus a card-path (hint) comparison
//      proving the analysis side panel does not move the hint card's own
//      p50/p95 (§7 "card p95 must be unchanged vs baseline"). --------------

/** One completed `FakeAnalysisLlm.generate()` call's metrics. */
export interface AnalysisSample {
  readonly latencyMs: number
  /** Input-side accounting: prompt char length (system + user prompt), the
   *  same char-budget shape `ANALYSIS_MAX_PROMPT_CHARS` bounds (Task 6.4) —
   *  a char count, not a tokenizer-accurate token count, same conservative
   *  rationale as analysis-prompts.ts's own cap. */
  readonly promptChars: number
  /** Output-side accounting: tokens this call actually emitted, capped at
   *  the caller's `maxOutputTokens` (i.e. `ANALYSIS_MAX_OUTPUT_TOKENS`,
   *  Task 6.4's hard per-call output cap) — never exceeds it. */
  readonly outputTokens: number
}

/**
 * Deterministic, network-free `AnalysisLlm` test double for `--bench`
 * (mirrors `FakeCloudClient` in test/cloud-llm-client.test.ts). `--bench`
 * must never make a real cloud LLM call regardless of `LLM_ANALYSIS_ENABLED`
 * or cloud config — this class is the ENTIRE analysis code path the bench
 * harness drives; `resolveCloudLlmConfig`/`CloudLlmClient` are never
 * constructed here. Latency/token counts are fixed instrumentation values
 * for exercising `AnalysisEngine`'s own timing/cancel-previous code path,
 * not a measurement of any real vendor.
 */
export class FakeAnalysisLlm implements AnalysisLlm {
  readonly samples: AnalysisSample[] = []
  private readonly latencyMs: number
  private readonly tokensPerCall: number

  constructor(opts: { latencyMs?: number; tokensPerCall?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? 220
    this.tokensPerCall = opts.tokensPerCall ?? 48
  }

  generate(
    systemPrompt: string,
    userPrompt: string,
    onToken: (tok: string) => void,
    opts: AnalysisStreamOptions = {}
  ): Generation {
    let cancelled = false
    const promptChars = systemPrompt.length + userPrompt.length
    const outputTokens = Math.min(this.tokensPerCall, opts.maxOutputTokens ?? this.tokensPerCall)

    const done = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!cancelled) {
          opts.onFirstToken?.()
          // Closed-schema-conforming output so a real AnalysisEngine.sink
          // wired to this double can exercise its full parse path too, not
          // just the timing side.
          onToken(JSON.stringify({ stage: 'other', suggested_questions: [] }))
          this.samples.push({ latencyMs: this.latencyMs, promptChars, outputTokens })
        }
        resolve()
      }, this.latencyMs)
    })

    return {
      cancel: () => {
        cancelled = true
      },
      done,
      isCancelled: () => cancelled
    }
  }
}

/** Pure aggregation + print for {@link AnalysisSample}s — same shape/pattern
 *  as {@link report}, but a SEPARATE table (spec.md §7): never merged into
 *  BenchStage's stage-boundary rows. */
export function reportAnalysis(samples: readonly AnalysisSample[]): void {
  console.log('\nanalysis latency + tokens/call (separate from BenchStage above)')
  console.log('n     p50(ms)   p95(ms)   avg prompt chars   avg output tokens/call')
  console.log('------------------------------------------------------------------')
  const latencies = samples.map((s) => s.latencyMs)
  const p50 = pct(latencies, 50)
  const p95 = pct(latencies, 95)
  const avgPromptChars = avg(samples.map((s) => s.promptChars))
  const avgOutputTokens = avg(samples.map((s) => s.outputTokens))
  console.log(
    `${String(samples.length).padStart(4)}   ${fmt(p50).padStart(8)}  ${fmt(p95).padStart(8)}   ${fmt(avgPromptChars).padStart(17)}   ${fmt(avgOutputTokens).padStart(21)}`
  )
}

function avg(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** One stage's card-path comparison row. `deltaP50`/`deltaP95` are `null`
 *  when the stage is missing a real sample in either run (e.g. no
 *  llama-server reachable) — never zero-filled, so an absent stage is never
 *  mistaken for "measured, and identical". */
export interface CardPathComparisonRow {
  readonly label: string
  readonly withAnalysisP50: number | null
  readonly withoutAnalysisP50: number | null
  readonly withAnalysisP95: number | null
  readonly withoutAnalysisP95: number | null
  readonly deltaP50: number | null
  readonly deltaP95: number | null
}

export interface CardPathComparisonResult {
  readonly rows: readonly CardPathComparisonRow[]
  /** True only when every stage with a real sample in BOTH runs has
   *  |delta| < noiseThresholdMs at both p50 and p95. A stage absent from
   *  both runs does not affect this verdict either way. */
  readonly unchanged: boolean
}

function stagePercentiles(
  timings: readonly SuggestionTiming[]
): Map<string, { p50: number | null; p95: number | null }> {
  const buckets = new Map<string, number[]>()
  for (const timing of timings) {
    for (const delta of stageDeltas(timing)) {
      const arr = buckets.get(delta.label) ?? []
      arr.push(delta.ms)
      buckets.set(delta.label, arr)
    }
  }
  const out = new Map<string, { p50: number | null; p95: number | null }>()
  for (const [label, xs] of buckets) {
    out.set(label, { p50: pct(xs, 50), p95: pct(xs, 95) })
  }
  return out
}

/**
 * Compares hint-card p50/p95 (per {@link STAGE_ROWS} stage) between an
 * analysis-enabled(fake) replay and an analysis-disabled replay of the SAME
 * corpus (Task 6.9, spec.md §7 "card p95 must be unchanged vs baseline").
 * Method: a stage counts as "changed" only when BOTH runs have a real
 * (non-null) percentile for it AND the absolute delta reaches
 * `noiseThresholdMs` — this deliberately never treats a stage that is
 * missing in both runs (e.g. no llama-server reachable during a bench run)
 * as evidence of either regression or stability.
 */
export function compareCardPaths(
  withAnalysis: readonly SuggestionTiming[],
  withoutAnalysis: readonly SuggestionTiming[],
  noiseThresholdMs = 5
): CardPathComparisonResult {
  const withP = stagePercentiles(withAnalysis)
  const withoutP = stagePercentiles(withoutAnalysis)
  const rows: CardPathComparisonRow[] = []
  let unchanged = true

  for (const [label] of STAGE_ROWS) {
    const w = withP.get(label) ?? { p50: null, p95: null }
    const wo = withoutP.get(label) ?? { p50: null, p95: null }
    const deltaP50 = w.p50 !== null && wo.p50 !== null ? w.p50 - wo.p50 : null
    const deltaP95 = w.p95 !== null && wo.p95 !== null ? w.p95 - wo.p95 : null
    if (deltaP50 !== null && Math.abs(deltaP50) >= noiseThresholdMs) unchanged = false
    if (deltaP95 !== null && Math.abs(deltaP95) >= noiseThresholdMs) unchanged = false
    rows.push({
      label,
      withAnalysisP50: w.p50,
      withoutAnalysisP50: wo.p50,
      withAnalysisP95: w.p95,
      withoutAnalysisP95: wo.p95,
      deltaP50,
      deltaP95
    })
  }

  return { rows, unchanged }
}

/** Prints {@link compareCardPaths}'s result as a table plus a final
 *  unchanged/changed verdict line. */
export function reportCardPathComparison(result: CardPathComparisonResult): void {
  console.log('\ncard path (hint) p50/p95 — analysis engine enabled(fake) vs disabled')
  console.log('stage boundary        with-p50   without-p50   with-p95   without-p95')
  console.log('----------------------------------------------------------------------')
  for (const [label, heading] of STAGE_ROWS) {
    const row = result.rows.find((r) => r.label === label)
    console.log(
      `${heading.padEnd(24)}${fmt(row?.withAnalysisP50 ?? null).padStart(10)}   ${fmt(row?.withoutAnalysisP50 ?? null).padStart(11)}   ${fmt(row?.withAnalysisP95 ?? null).padStart(9)}   ${fmt(row?.withoutAnalysisP95 ?? null).padStart(11)}`
    )
  }
  console.log(
    result.unchanged
      ? 'card p95: UNCHANGED (every shared stage delta < noise threshold)'
      : 'card p95: CHANGED — at least one shared stage delta reached the noise threshold, see rows above'
  )
}
