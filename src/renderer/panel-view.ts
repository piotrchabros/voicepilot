import type { Analysis, AnalysisStage } from '@shared/types'

// Pure display-logic extraction (spec.md §5 "Phase 6 adds a second... analysis
// panel window", Plans.md Task 6.6), mirroring hint-view.ts's/consent-view.ts's
// existing pure-seam pattern: what the panel should show for a given
// analysis/flag/time state, kept separate from panel.ts (DOM + IPC) so it's
// testable without jsdom.

/** Time-based staleness threshold (spec.md §7 "greyed when stale ... after a
 *  time threshold since last analysis"). Chosen well above a typical
 *  analysis round trip (ANALYSIS_DEBOUNCE_MS=1500 + generation latency,
 *  analysis-engine.ts) so a normal in-flight call never flickers grey.
 *
 *  Scope note: spec.md §7 also lists "when a newer settled turn exists than
 *  the analysis's asOfTurn" as a staleness trigger. The panel always renders
 *  the most recently *received* analysis (paintAnalysis forwards every
 *  result as it arrives, main/index.ts), so that condition is naturally
 *  satisfied as soon as a fresher result lands — there is no separate
 *  "conversation moved on but no new analysis arrived yet" signal on the
 *  wire as of Task 6.6 (would require exposing the live rolling-window turn
 *  count outside `AnalysisEngine`, out of this task's scope per the
 *  briefing's "do not modify analysis-engine.ts"). The time-threshold half
 *  below is this task's honest, testable approximation of both triggers —
 *  documented here and in docs/qa-checklist-6.6.md, not silently dropped. */
export const STALE_THRESHOLD_MS = 30_000

/** Belt-and-suspenders cap (spec.md §7 "up to three suggested next
 *  questions"). `AnalysisOutputSchema` (analysis-engine.ts) already enforces
 *  `.max(3)` on the LLM-facing side, but the panel is a second, independent
 *  consumer of the wire-shape `Analysis` type — it must never trust that
 *  upstream guarantee alone (reviewer finding, Task 6.6 fix). */
const MAX_SUGGESTED_QUESTIONS = 3

const STAGE_LABELS: Record<AnalysisStage, string> = {
  discovery: 'Discovery',
  demo: 'Demo',
  objection: 'Objection',
  closing: 'Closing',
  other: 'Other'
}

export function stageLabelFor(stage: AnalysisStage): string {
  return STAGE_LABELS[stage]
}

export type PanelEmptyReason = 'disabled' | 'awaiting'

export interface PanelViewModel {
  /** True when there is nothing to render yet (flag off, or no analysis has
   *  arrived) — spec.md §7 "Panel must render an honest empty state". */
  readonly empty: boolean
  readonly emptyReason?: PanelEmptyReason
  /** Cloud-processing indicator (spec.md §7, "analogous to REC"). */
  readonly cloudActive: boolean
  /** Grey-out flag (spec.md §7 "greyed when stale"). */
  readonly stale: boolean
  readonly stageLabel?: string
  readonly suggestedQuestions: readonly string[]
  readonly nextSteps?: readonly string[]
  readonly asOfTurnLabel?: string
}

export interface PanelViewInput {
  readonly analysis: Analysis | null
  /** `LLM_ANALYSIS_ENABLED` resolved true at boot (PanelInitMsg). */
  readonly analysisEnabled: boolean
  /** When `analysis` was received by the panel renderer, or `null` if none
   *  has arrived yet. */
  readonly receivedAtMs: number | null
  readonly nowMs: number
  readonly staleThresholdMs?: number
}

/**
 * Builds the panel's fixed-skeleton view model (spec.md §7: "one-line
 * call-stage indicator + up to three suggested next questions, stamped
 * 'as of turn N' and greyed when stale, plus a visible cloud-processing
 * indicator"). Stable section ordering is the caller's (panel.ts's) job —
 * this only decides what each section's content/visibility should be.
 */
export function panelViewModelFor(input: PanelViewInput): PanelViewModel {
  const cloudActive = input.analysisEnabled

  if (!input.analysisEnabled) {
    return {
      empty: true,
      emptyReason: 'disabled',
      cloudActive,
      stale: false,
      suggestedQuestions: []
    }
  }

  if (input.analysis === null) {
    return {
      empty: true,
      emptyReason: 'awaiting',
      cloudActive,
      stale: false,
      suggestedQuestions: []
    }
  }

  const threshold = input.staleThresholdMs ?? STALE_THRESHOLD_MS
  const stale = input.receivedAtMs !== null && input.nowMs - input.receivedAtMs > threshold

  return {
    empty: false,
    cloudActive,
    stale,
    stageLabel: stageLabelFor(input.analysis.stage),
    suggestedQuestions: input.analysis.suggestedQuestions.slice(0, MAX_SUGGESTED_QUESTIONS),
    ...(input.analysis.nextSteps !== undefined && { nextSteps: input.analysis.nextSteps }),
    // "as of turn N (retained)" — honest labelling: asOfTurn is a
    // retained-turn count that plateaus at the transcript cap, not a global
    // monotonic turn counter (spec.md §7 briefing note, Analysis.asOfTurn
    // doc in shared/types.ts).
    asOfTurnLabel: `as of turn ${input.analysis.asOfTurn} (retained)`
  }
}
