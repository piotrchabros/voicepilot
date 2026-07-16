import type { Analysis, AnalysisStage, Speaker } from '@shared/types'
import { z } from 'zod'
import type { AnalysisLlm, Generation } from './analysis-llm'
import {
  ANALYSIS_MAX_PROMPT_CHARS,
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
  containsSentimentVocabulary
} from './analysis-prompts'
import type { KnowledgeBase } from './knowledge'
import type { TranscriptState } from './transcript-state'

/**
 * `AnalysisEngine` — HintEngine's sibling in `src/pipeline` (spec.md §7;
 * Plans.md Task 6.4). Transport-agnostic, no Electron imports, so it rides
 * the Phase-5 Fastify lift unchanged, exactly like HintEngine.
 *
 * Unlike HintEngine (fires on every interim, ~200ms debounce, feeds the
 * latency-critical hint card), AnalysisEngine is an asynchronous,
 * best-effort side panel: it fires ONLY on a settled PROSPECT (THEM)
 * turn-end, debounced ~1.5s, and never shares or delays the hint card's
 * budget. Cancel-previous is the design here too — a superseded analysis
 * call is aborted, never allowed to race a newer one to the sink.
 */

/** Debounce for the analysis engine. Deliberately separate from
 *  HintEngine's DEBOUNCE_MS=200 — analysis is best-effort background work,
 *  not the latency-critical hint card (spec.md §7 "Latency/cost"). */
export const ANALYSIS_DEBOUNCE_MS = 1500

/**
 * Hard per-call OUTPUT token cap (spec.md §7 "A hard per-call token cap
 * applies") — forwarded to `AnalysisLlm.generate()`'s
 * `AnalysisStreamOptions.maxOutputTokens` on every call. The matching INPUT
 * side of the cap is `ANALYSIS_MAX_PROMPT_CHARS` (re-exported below from
 * analysis-prompts.ts, enforced inside `buildAnalysisUserPrompt`).
 */
export const ANALYSIS_MAX_OUTPUT_TOKENS = 300

export { ANALYSIS_MAX_PROMPT_CHARS }

/** Closed set of conversation stages (spec.md §7 "Closed output schema").
 *  `AnalysisStage`/`Analysis` are now defined in shared/types.ts (Task 6.5,
 *  the wire-shape SSOT) — re-exported here so existing imports of this
 *  module (e.g. `./index.ts`) don't need to change. `satisfies` keeps this
 *  tuple (needed by zod's `z.enum`, which requires a non-empty literal
 *  tuple, not a general array) checked against that same union at
 *  compile-time — a typo or drift here is a type error. */
const ANALYSIS_STAGES = [
  'discovery',
  'demo',
  'objection',
  'closing',
  'other'
] as const satisfies readonly AnalysisStage[]

/** zod schema for the LLM's raw response. Non-conforming responses (wrong
 *  stage, >3 questions, missing required fields, extra free-form fields the
 *  schema doesn't declare) are dropped by the caller — never rendered. */
const AnalysisOutputSchema = z.object({
  stage: z.enum(ANALYSIS_STAGES),
  suggested_questions: z.array(z.string()).max(3),
  next_steps: z.array(z.string()).optional()
})

export type { Analysis, AnalysisStage }

const BOOLEAN_FLAG = z.enum(['0', '1'])

/**
 * Fail-closed zod boolean-ish parse for `LLM_ANALYSIS_ENABLED` (spec.md §7
 * cloud-send feature flag, default OFF). Mirrors the `BOOLEAN_FLAG` pattern
 * `src/main/env.ts` uses for `COPILOT_DEBUG` et al. Any unset or invalid
 * value resolves to `false` — this is the feature flag half of "engine only
 * calls the LLM when the cloud config resolves AND this flag is true"; the
 * cloud-config half is `resolveCloudLlmConfig` (Task 6.3, cloud-llm-client.ts).
 */
export function resolveAnalysisEnabledFlag(raw: string | undefined): boolean {
  const result = BOOLEAN_FLAG.safeParse(raw)
  return result.success && result.data === '1'
}

export interface AnalysisEngineOptions {
  /** Content loaded via `loadCustomerBrief()` from `InitMsg.customerBrief`'s
   *  basename (Task 6.7) — content only, never the whole customers/ dir.
   *  `null`/absent = no brief selected, the default. */
  readonly customerBriefContent?: string | null
  /** Cloud-send feature flag (spec.md §7): must be true only when the cloud
   *  LLM config resolved (Task 6.3) AND `LLM_ANALYSIS_ENABLED` is explicitly
   *  `'1'` (see `resolveAnalysisEnabledFlag`). `false` makes the engine
   *  fully inert — `onTurnEnd` never touches `llm`, so there is zero
   *  network/LLM traffic. */
  readonly enabled: boolean
  /** Top-K KnowledgeBase sections retrieved per call. Defaults to 3
   *  (mirrors KnowledgeBase.search's own default). */
  readonly topK?: number
}

export class AnalysisEngine {
  private readonly llm: AnalysisLlm
  private readonly kb: KnowledgeBase
  private readonly state: TranscriptState
  private readonly sink: (analysis: Analysis) => void
  private readonly customerBrief: string | null
  private readonly enabled: boolean
  private readonly topK: number

  private pending: ReturnType<typeof setTimeout> | null = null
  private inFlight: Generation | null = null

  constructor(
    llm: AnalysisLlm,
    kb: KnowledgeBase,
    state: TranscriptState,
    sink: (analysis: Analysis) => void,
    opts: AnalysisEngineOptions
  ) {
    this.llm = llm
    this.kb = kb
    this.state = state
    this.sink = sink
    this.customerBrief = opts.customerBriefContent ?? null
    this.enabled = opts.enabled
    this.topK = opts.topK ?? 3
  }

  /**
   * Trigger: a settled PROSPECT (THEM) turn-end only — never interims,
   * never ME turns, never an empty settled turn. Debounced ~1.5s;
   * cancel-previous, never queue — every call here resets the pending
   * timer, and once it fires, `analyze()` cancels whatever generation is
   * still in flight before starting the new one.
   *
   * When the feature flag is off (`enabled: false`), this is a complete
   * no-op: no timer is ever set, and `llm` is never touched — the DoD's
   * "flag OFF 時 network 呼び出し 0 件" contract.
   */
  onTurnEnd(who: Speaker, finalText: string): void {
    if (!this.enabled) return
    if (who !== 'THEM') return
    if (finalText.trim().length === 0) return

    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = setTimeout(() => this.analyze(), ANALYSIS_DEBOUNCE_MS)
  }

  private analyze(): void {
    this.pending = null

    // Cancel-previous, never queue: whatever is still in flight was based
    // on a transcript state that no longer reflects the newest settled
    // turn — letting it finish would risk it racing this one to the sink.
    if (this.inFlight !== null) this.inFlight.cancel()

    const rolling = this.state.renderRollingWindow()
    const kbSnippets = this.kb.search(rolling.text, this.topK)
    const userPrompt = buildAnalysisUserPrompt({
      transcriptText: rolling.text,
      asOfTurn: rolling.asOfTurn,
      kbSnippets,
      customerBrief: this.customerBrief
    })

    let acc = ''
    // Hard per-call token cap (spec.md §7): userPrompt is already bounded on
    // the INPUT side by buildAnalysisUserPrompt (ANALYSIS_MAX_PROMPT_CHARS,
    // truncating oldest rolling-window content first); maxOutputTokens below
    // is the OUTPUT-side half, forwarded to every AnalysisLlm implementation.
    const gen = this.llm.generate(
      ANALYSIS_SYSTEM_PROMPT,
      userPrompt,
      (tok) => {
        acc += tok
      },
      { maxOutputTokens: ANALYSIS_MAX_OUTPUT_TOKENS }
    )
    this.inFlight = gen

    void gen.done.then(() => {
      // A cancelled generation (superseded by a newer call, or shutdown)
      // must never reach the sink — that is the entire point of
      // cancel-previous. `this.inFlight !== gen` guards the case where the
      // promise settles after a newer generation has already taken over.
      if (gen.isCancelled() || this.inFlight !== gen) return
      this.inFlight = null
      this.handleResult(acc, rolling.asOfTurn)
    })
  }

  /**
   * zod-validates the closed schema, then applies the OUTPUT-path
   * no-sentiment guard a second time (spec.md §7 — prompt-only guards fail
   * on model drift): non-conforming JSON or a schema-valid-but-sentiment-
   * bearing response is dropped entirely, never rendered.
   */
  private handleResult(raw: string, asOfTurn: number): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const result = AnalysisOutputSchema.safeParse(parsed)
    if (!result.success) return

    const candidate = result.data
    const allStrings = [
      candidate.stage,
      ...candidate.suggested_questions,
      ...(candidate.next_steps ?? [])
    ]
    if (allStrings.some((s) => containsSentimentVocabulary(s))) return

    this.sink({
      stage: candidate.stage,
      suggestedQuestions: candidate.suggested_questions,
      ...(candidate.next_steps !== undefined && { nextSteps: candidate.next_steps }),
      asOfTurn
    })
  }

  shutdown(): void {
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = null
    if (this.inFlight !== null) this.inFlight.cancel()
  }
}
