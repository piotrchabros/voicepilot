import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hint } from '@shared/types'
import { DEBOUNCE_MS, HintEngine, type HintLlm } from '../src/pipeline/hint-engine'
import type { Generation } from '../src/pipeline/llama-client'
import { Playbook } from '../src/pipeline/playbook'
import { TranscriptState } from '../src/pipeline/transcript-state'

const TSV = 'za drogo\tCena vs koszt zwloki'

interface Rec {
  prompt: string
  cancelled: boolean
}

/** Stub LLM: records every generation and whether it was cancelled. Feeds each
 *  generation the token strings queued in `nextTokens` (default: none). */
class StubLlm implements HintLlm {
  readonly gens: Rec[] = []
  nextTokens: string[][] = []
  streamHint(prompt: string, onToken: (tok: string) => void): Generation {
    const rec: Rec = { prompt, cancelled: false }
    this.gens.push(rec)
    for (const tok of this.nextTokens.shift() ?? []) onToken(tok)
    return {
      cancel: () => {
        rec.cancelled = true
      },
      done: Promise.resolve(),
      isCancelled: () => rec.cancelled
    }
  }
}

function setup(): { engine: HintEngine; llm: StubLlm; state: TranscriptState; hints: Hint[] } {
  const llm = new StubLlm()
  const playbook = Playbook.parse(TSV)
  const state = new TranscriptState('sys', 'pb', 12)
  const hints: Hint[] = []
  const engine = new HintEngine(llm, playbook, state, (h) => hints.push(h))
  return { engine, llm, state, hints }
}

describe('HintEngine cancel-previous (the design, not a bug)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('10 successive speculations => exactly one survives, nine abort', () => {
    const { engine, llm, state } = setup()

    // Ten distinct interim transcripts, each far enough apart to fire its own
    // speculation. Each new speculation must cancel the previous in-flight one.
    for (let i = 0; i < 10; i++) {
      state.live('THEM', `interim revision number ${i}`)
      engine.onTranscriptUpdate()
      vi.advanceTimersByTime(DEBOUNCE_MS)
    }

    expect(llm.gens).toHaveLength(10)
    expect(llm.gens.filter((g) => g.cancelled)).toHaveLength(9)
    expect(llm.gens.filter((g) => !g.cancelled)).toHaveLength(1)
    // The survivor is the last one dispatched.
    expect(llm.gens[9]?.cancelled).toBe(false)
  })

  it('a rapid burst within the debounce coalesces to a single generation', () => {
    const { engine, llm, state } = setup()
    for (let i = 0; i < 10; i++) {
      state.live('THEM', `fast revision ${i}`)
      engine.onTranscriptUpdate()
      vi.advanceTimersByTime(10) // all inside one 200ms debounce window
    }
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(llm.gens).toHaveLength(1)
    expect(llm.gens[0]?.cancelled).toBe(false)
  })

  it('identical prompt does not re-fire (no-op guard)', () => {
    const { engine, llm, state } = setup()
    state.live('THEM', 'steady text that does not change')
    engine.onTranscriptUpdate()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    engine.onTranscriptUpdate() // same live text -> same prompt
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(llm.gens).toHaveLength(1)
  })

  it('emits an instant RETRIEVED hint before any generation', () => {
    const { engine, state, hints } = setup()
    state.live('THEM', 'to jest za drogo dla nas')
    engine.onTranscriptUpdate()
    expect(hints[0]).toEqual({ text: 'Cena vs koszt zwloki', source: 'RETRIEVED' })
  })

  it('never sinks whitespace-only generated hints', () => {
    const { engine, llm, state, hints } = setup()
    llm.nextTokens = [[' ', '\t']]
    state.live('THEM', 'jakas dluga wypowiedz klienta wlasnie teraz')
    engine.onTranscriptUpdate()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(hints.filter((h) => h.source === 'GENERATED')).toHaveLength(0)
  })

  it('retries once when an uncancelled generation completes empty', async () => {
    const { engine, llm, state, hints } = setup()
    llm.nextTokens = [[], ['Zapytaj', ' o budzet']] // 1st empty, 2nd real
    state.live('THEM', 'nie mamy na to budzetu w tym roku')
    engine.onTranscriptUpdate()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    await Promise.resolve() // let gen.done settle
    await Promise.resolve()
    expect(llm.gens).toHaveLength(2) // the single retry
    expect(hints.at(-1)).toEqual({ text: 'Zapytaj o budzet', source: 'GENERATED' })
    // And the retry itself must not loop: a second empty stays empty.
    expect(llm.gens[1]?.cancelled).toBe(false)
  })

  it('shutdown cancels the in-flight generation', () => {
    const { engine, llm, state } = setup()
    state.live('THEM', 'something being said now')
    engine.onTranscriptUpdate()
    vi.advanceTimersByTime(DEBOUNCE_MS)
    engine.shutdown()
    expect(llm.gens[0]?.cancelled).toBe(true)
  })
})
