import type { Hint, Speaker } from '@shared/types'
import type { Generation, StreamOptions } from './llama-client'
import type { Playbook } from './playbook'
import type { TranscriptState } from './transcript-state'

/**
 * The actual idea. Everything else in this project is plumbing. Port of
 * HintEngine.java.
 *
 * You cannot make the serial path (VAD -> STT -> turn-end -> LLM -> render) fit
 * in 300ms. So stop measuring from "they stopped talking" and start generating
 * while they're STILL TALKING. By the time they stop, the hint has been on screen
 * for half a second.
 *
 * Two layers:
 *   1. Retrieval  — nearest playbook entry, ~10ms, always shows something
 *   2. Generation — local LLM, ~50ms TTFT, overwrites layer 1 when it lands
 *
 * Cancel-previous is the design, not a bug: every new speculation aborts the
 * in-flight one, because it was based on a transcript that no longer exists.
 * Letting them race produces flicker or a stale hint winning.
 */

/** The subset of LlamaClient the engine needs — narrowed so tests can stub it. */
export interface HintLlm {
  streamHint(prompt: string, onToken: (tok: string) => void, opts?: StreamOptions): Generation
}

/** Debounce. Below ~150ms you thrash; above ~400ms you lose the head start. */
export const DEBOUNCE_MS = 200

export class HintEngine {
  private readonly llm: HintLlm
  private readonly playbook: Playbook
  private readonly state: TranscriptState
  private readonly sink: (hint: Hint) => void

  private pending: ReturnType<typeof setTimeout> | null = null
  private inFlight: Generation | null = null
  private lastPrompt = ''

  /** Fired when a speculation actually dispatches to the LLM — for the bench. */
  onSpeculate?: () => void
  /** Fired on the first generated token of a speculation — for the bench. */
  onFirstToken?: () => void

  constructor(
    llm: HintLlm,
    playbook: Playbook,
    state: TranscriptState,
    sink: (hint: Hint) => void
  ) {
    this.llm = llm
    this.playbook = playbook
    this.state = state
    this.sink = sink
  }

  /**
   * Call this on EVERY interim STT update — i.e. ~30x/second while they talk.
   * Yes, really. That's the point.
   */
  onTranscriptUpdate(): void {
    // Layer 1: instant. Synchronous, ~10ms, no excuses.
    const key = this.state.retrievalKey()
    if (key.length > 12) {
      const hit = this.playbook.nearest(key)
      if (hit !== null) this.sink({ text: hit, source: 'RETRIEVED' })
    }

    // Layer 2: debounced speculation.
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = setTimeout(() => this.speculate(), DEBOUNCE_MS)
  }

  private speculate(retried = false): void {
    this.pending = null
    const prompt = this.state.renderPrompt()

    // Interim transcripts revise themselves constantly; don't re-run on a no-op.
    if (!retried && prompt === this.lastPrompt) return
    this.lastPrompt = prompt

    // Kill the previous speculation. It was based on a transcript that no longer
    // exists. Letting it finish would race the new one to the UI — flicker, or a
    // stale hint winning.
    if (this.inFlight !== null) this.inFlight.cancel()

    let acc = ''
    this.onSpeculate?.()
    const gen = this.llm.streamHint(
      prompt,
      (tok) => {
        acc += tok
        const text = acc.trim()
        // Whitespace-only accumulations are noise, not a hint — don't paint them.
        if (text.length > 0) this.sink({ text, source: 'GENERATED' })
      },
      { onFirstToken: () => this.onFirstToken?.() }
    )
    this.inFlight = gen

    // Sampling variance sometimes opens with "\n" and instantly hits the stop —
    // a COMPLETED-but-empty generation. Retry that once. (Aborted generations
    // are different: they are supposed to die; never retry those.)
    if (!retried) {
      void gen.done.then(() => {
        if (!gen.isCancelled() && acc.trim().length === 0 && this.inFlight === gen) {
          this.speculate(true)
        }
      })
    }
  }

  /**
   * VAD fired TURN_END. Note what we DON'T do here: we don't kick off a
   * generation and wait. The hint is already up. This just settles the transcript
   * so the next speculation has clean history.
   */
  onTurnEnd(who: Speaker, finalText: string): void {
    this.state.settle(who, finalText)
  }

  shutdown(): void {
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = null
    if (this.inFlight !== null) this.inFlight.cancel()
  }
}
