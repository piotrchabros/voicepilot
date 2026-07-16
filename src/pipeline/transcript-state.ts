import type { Speaker } from '@shared/types'

/**
 * Append-only conversation state. Verbatim port of TranscriptState.java.
 *
 * "Append-only" is not stylistic. llama.cpp's prefix cache only survives if
 * everything before the new tokens is byte-identical to last time. Insert a
 * timestamp in the middle, re-order the playbook, trim an old turn from the
 * front — and you've invalidated the cache, triggered a full 4k-token re-prefill,
 * and turned your 40ms TTFT into 800ms. The cache is a prefix cache. Respect the
 * prefix.
 *
 * The sliding window below is deliberately NOT a sliding window during a call: we
 * grow until we hit the ceiling, then reset once and eat one slow turn, rather
 * than shifting the prefix on every single turn and eating a slow turn every time.
 *
 * DO NOT refactor renderPrompt()'s string building "for readability". The exact
 * ordering and exact rendering are load-bearing.
 */
interface Turn {
  readonly speaker: Speaker
  readonly text: string
}

function renderTurn(t: Turn): string {
  return (t.speaker === 'ME' ? 'Me: ' : 'Them: ') + t.text + '\n'
}

/** Result of {@link TranscriptState.renderRollingWindow}. */
export interface RollingWindowResult {
  /** Speaker-labelled turns, most recent last. Plain text, no system/playbook wrapper. */
  readonly text: string
  /** Count of settled turns currently held, so callers can stamp "as of turn N". */
  readonly asOfTurn: number
}

export class TranscriptState {
  private readonly systemPrompt: string
  private readonly playbook: string
  private readonly settled: Turn[] = []
  private readonly maxTurns: number

  private liveSpeaker: Speaker = 'THEM'
  private liveTextValue = ''

  constructor(systemPrompt: string, playbook: string, maxTurns: number) {
    this.systemPrompt = systemPrompt
    this.playbook = playbook
    this.maxTurns = maxTurns
  }

  /** Interim STT update for the turn currently in progress. */
  live(who: Speaker, text: string): void {
    this.liveSpeaker = who
    this.liveTextValue = text
  }

  /** VAD said the turn ended. Promote it. */
  settle(who: Speaker, text: string): void {
    if (text.trim().length === 0) {
      this.liveTextValue = ''
      return
    }
    this.settled.push({ speaker: who, text })
    while (this.settled.length > this.maxTurns) this.settled.shift() // one slow turn, rarely
    this.liveTextValue = ''
  }

  liveText(): string {
    return this.liveTextValue
  }

  liveSpeakerOf(): Speaker {
    return this.liveSpeaker
  }

  /**
   * Immutable prefix first, volatile tail last. This ordering is the whole reason
   * TTFT stays double-digit.
   */
  renderPrompt(): string {
    let sb = ''
    sb += this.systemPrompt + '\n\n' // never changes
    sb += this.playbook + '\n\n' // never changes
    sb += '<transcript>\n'
    for (const t of this.settled) sb += renderTurn(t) // grows at the end only
    if (this.liveTextValue.trim().length > 0) {
      sb += (this.liveSpeaker === 'ME' ? 'Me: ' : 'Them: ') + this.liveTextValue + '\n'
    }
    sb += '</transcript>\n\n'
    sb += '<hint>'
    return sb
  }

  /** Cheap retrieval key: what they're saying right now. */
  retrievalKey(): string {
    return this.liveSpeaker === 'THEM' ? this.liveTextValue : ''
  }

  /**
   * Rolling-window renderer for stateless cloud generation calls only
   * (spec.md §3: "Rolling-window rendering may be used only for stateless
   * cloud generation calls"). This is a separate read path from
   * {@link renderPrompt}: it does not touch or share the append-only,
   * prefix-cache-locked `settled` array, and calling it never mutates any
   * TranscriptState field. `renderPrompt()`'s output is unaffected by any
   * number of calls to this method.
   */
  renderRollingWindow(opts: { maxTurns?: number } = {}): RollingWindowResult {
    const bound = opts.maxTurns ?? this.maxTurns
    const window = bound > 0 ? this.settled.slice(-bound) : []
    let text = ''
    for (const t of window) text += renderTurn(t)
    return { text, asOfTurn: this.settled.length }
  }
}
