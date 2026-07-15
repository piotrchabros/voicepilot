// Per-suggestion latency instrumentation (spec.md §3, Task 3.3): "per-stage
// timestamps tagged with transport on every suggestion". Pure — no timers, no
// side effects beyond the injected clock, so tests can drive it with a fake.

import type { BenchStage, SuggestionTiming, SuggestionTransport } from '@shared/types'
import type { VadEvent } from './vad'

export type NowFn = () => number

/**
 * Whether a VAD event should (re)start the turn baseline. Only `SPEECH_START`
 * qualifies — reviewer finding (Task 3.3, critical): calling `beginTurn` on
 * every frame wipes the baseline mid-flight, between when `stt_interim` gets
 * marked and when the debounced `speculate_fired`/`first_token` eventually
 * fire, so those marks end up relative to a *different, later* frame than the
 * one that actually triggered them. `SPEECH` (mid-turn) and `SILENCE`/
 * `TURN_END` must never reset the baseline; only the frame that opens a new
 * turn does. Extracted as a pure predicate so pipeline/index.ts and bench.ts
 * share one gate and it's unit-testable without a live VAD/parentPort.
 */
export function shouldBeginTurn(ev: VadEvent): boolean {
  return ev === 'SPEECH_START'
}

/** The stage-to-stage pairs the bench/latency report cares about, in pipeline
 *  order. `frame_in` is always 0 by construction (it IS the turn baseline). */
export const STAGE_PAIRS: readonly (readonly [BenchStage, BenchStage])[] = [
  ['frame_in', 'vad_out'],
  ['vad_out', 'stt_interim'],
  ['stt_interim', 'speculate_fired'],
  ['speculate_fired', 'first_token'],
  ['first_token', 'painted']
]

/**
 * A single turn's stage clock: `beginTurn` sets the baseline (and tags the
 * transport that produced this suggestion), `mark` records an elapsed-ms
 * sample for a stage relative to that baseline, `snapshot` reads the current
 * state out as an immutable `SuggestionTiming` (or null before any turn has
 * begun). `now` is dependency-injected — production uses `performance.now()`,
 * tests supply a fake monotonic sequence.
 */
export class StageClock {
  private readonly now: NowFn
  private turnStart: number | null = null
  private transport: SuggestionTransport | null = null
  private stages: Partial<Record<BenchStage, number>> = {}

  constructor(now: NowFn = () => performance.now()) {
    this.now = now
  }

  /** Starts (or restarts) a turn: baseline = now, frame_in = 0, prior stage
   *  marks are discarded. */
  beginTurn(transport: SuggestionTransport): void {
    this.transport = transport
    this.turnStart = this.now()
    this.stages = { frame_in: 0 }
  }

  /** Records `stage` at (now - baseline) ms. No-op if no turn has begun yet. */
  mark(stage: BenchStage): void {
    if (this.turnStart === null) return
    this.stages[stage] = this.now() - this.turnStart
  }

  /** Immutable read of the current turn's timing, or null before `beginTurn`. */
  snapshot(): SuggestionTiming | null {
    if (this.transport === null) return null
    return { transport: this.transport, stages: { ...this.stages } }
  }
}

export interface StageDeltaSample {
  readonly label: string
  readonly transport: SuggestionTransport
  readonly ms: number
}

/** Derives consecutive stage-to-stage deltas from one `SuggestionTiming`
 *  snapshot. A pair is skipped (not zero-filled) when either endpoint stage
 *  was never marked — e.g. a card painted from the RETRIEVED layer alone,
 *  never reaching speculate_fired/first_token. */
export function stageDeltas(timing: SuggestionTiming): StageDeltaSample[] {
  const out: StageDeltaSample[] = []
  for (const [from, to] of STAGE_PAIRS) {
    const a = timing.stages[from]
    const b = timing.stages[to]
    if (a === undefined || b === undefined) continue
    out.push({ label: `${from}->${to}`, transport: timing.transport, ms: b - a })
  }
  return out
}
