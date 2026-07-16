// Vendor-agnostic contract for the Phase-6 cloud analysis LLM (spec.md §4
// item 8, §7; Plans.md Task 6.3). Deliberately mirrors llama-client.ts's
// `Generation`/`StreamOptions` shape so AnalysisEngine (Task 6.4) can share
// the exact same cancel-previous handling code path HintEngine already uses
// — regardless of whether the LLM behind it is local or cloud.
//
// This file defines the interface only. The concrete cloud implementation is
// cloud-llm-client.ts; the Analysis prompt/schema/engine that actually calls
// this is Task 6.4's job, not this one.

/** A cancellable in-flight generation. `cancel()` must actually abort the underlying request. */
export interface Generation {
  /** Abort the generation. Idempotent. */
  cancel(): void
  /** Resolves when the generation ends (naturally, by stop, or by abort). Never rejects. */
  readonly done: Promise<void>
  readonly isCancelled: () => boolean
}

export interface AnalysisStreamOptions {
  /** Fired once, when the first content token/chunk arrives. */
  onFirstToken?: () => void
}

/**
 * Narrow interface every cloud analysis LLM implementation — and every test
 * double standing in for one — must satisfy. Vendor-agnostic on purpose:
 * system prompt + user prompt in, streamed (or single-shot) text out. The
 * Analysis output schema (`{stage, suggested_questions, next_steps?}`) and
 * the prompt itself belong to Task 6.4, not this interface.
 */
export interface AnalysisLlm {
  generate(
    systemPrompt: string,
    userPrompt: string,
    onToken: (tok: string) => void,
    opts?: AnalysisStreamOptions
  ): Generation
}
