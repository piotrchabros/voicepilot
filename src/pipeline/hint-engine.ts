import type { Hint, Speaker } from '@shared/types'
import type { Generation, StreamOptions } from './llama-client'
import type { Playbook } from './playbook'
import type { StageClock } from './timing'
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
  private readonly clock: StageClock | null

  private pending: ReturnType<typeof setTimeout> | null = null
  private inFlight: Generation | null = null
  private lastPrompt = ''

  /** Fired when a speculation actually dispatches to the LLM — for the bench. */
  onSpeculate?: () => void
  /** Fired on the first generated token of a speculation — for the bench. */
  onFirstToken?: () => void

  /**
   * `clock` is optional (Task 3.3): when supplied, every hint passed to
   * `sink` gets a `timing` snapshot attached, and speculate_fired/first_token
   * get marked on it as they happen. Omitting it (default) is the original,
   * uninstrumented behavior — existing callers/tests are unaffected.
   */
  constructor(
    llm: HintLlm,
    playbook: Playbook,
    state: TranscriptState,
    sink: (hint: Hint) => void,
    clock?: StageClock
  ) {
    this.llm = llm
    this.playbook = playbook
    this.state = state
    this.sink = sink
    this.clock = clock ?? null
  }

  /** Attaches the current clock snapshot (if any) before handing the hint to
   *  the real sink. All hint emission — retrieval and generation — goes
   *  through here so timing coverage doesn't depend on the caller remembering. */
  private sinkHint(hint: Hint): void {
    const timing = this.clock?.snapshot() ?? undefined
    this.sink(timing !== undefined ? { ...hint, timing } : hint)
  }

  /**
   * Call this on EVERY interim STT update — i.e. ~30x/second while they talk.
   * Yes, really. That's the point.
   */
  onTranscriptUpdate(): void {
    // Layer 1: instant. Synchronous, ~10ms, no excuses.
    const key = this.state.retrievalKey()
    if (key.length > 12) {
      const play = this.playbook.nearestPlay(key)
      if (play !== null)
        this.sinkHint({ text: `${play.headline} — ${play.line}`, source: 'RETRIEVED' })
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
    this.clock?.mark('speculate_fired')
    this.onSpeculate?.()
    const gen = this.llm.streamHint(
      prompt,
      (tok) => {
        acc += tok
        const text = acc.trim()
        // Whitespace-only accumulations are noise, not a hint — don't paint them.
        if (text.length > 0) this.sinkHint({ text, source: 'GENERATED' })
      },
      {
        onFirstToken: () => {
          this.clock?.mark('first_token')
          this.onFirstToken?.()
        }
      }
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
