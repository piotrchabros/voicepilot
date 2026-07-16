import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisStreamOptions, Generation } from '../src/pipeline/analysis-llm'
import {
  ANALYSIS_DEBOUNCE_MS,
  ANALYSIS_MAX_OUTPUT_TOKENS,
  ANALYSIS_MAX_PROMPT_CHARS,
  AnalysisEngine,
  resolveAnalysisEnabledFlag,
  type Analysis
} from '../src/pipeline/analysis-engine'
import {
  ANALYSIS_SYSTEM_PROMPT,
  containsSentimentVocabulary
} from '../src/pipeline/analysis-prompts'
import { KnowledgeBase } from '../src/pipeline/knowledge'
import { TranscriptState } from '../src/pipeline/transcript-state'

// spec.md §7 (Knowledge base & analysis engine, Phase 6) / Plans.md Task 6.4.
// AnalysisEngine is HintEngine's sibling: settled prospect turn-end trigger,
// ~1.5s debounce (own constant, separate from HintEngine's 200ms), cancel-
// previous (never queue), closed zod output schema, no-sentiment guard on
// BOTH prompt and output, "as of turn N" stamp, cloud-send feature flag
// (default OFF), log hygiene.

interface Rec {
  systemPrompt: string
  userPrompt: string
  cancelled: boolean
  maxOutputTokens: number | undefined
}

/** Stub AnalysisLlm — mirrors StubLlm in test/hint-engine.test.ts. Records
 *  every call and whether it was cancelled; feeds back queued token arrays
 *  (each entry is normally one full JSON response string). Never touches
 *  the network. */
class StubAnalysisLlm {
  readonly calls: Rec[] = []
  nextTokens: string[][] = []
  /** When true, `generate()` throws — used to prove the engine never even
   *  reaches the LLM when the feature flag is off (DoD: "flag OFF 時 network
   *  呼び出し 0 件"). */
  failIfCalled = false

  generate(
    systemPrompt: string,
    userPrompt: string,
    onToken: (tok: string) => void,
    opts: AnalysisStreamOptions = {}
  ): Generation {
    if (this.failIfCalled) {
      throw new Error('AnalysisLlm.generate() must never be called with the feature flag off')
    }
    const rec: Rec = {
      systemPrompt,
      userPrompt,
      cancelled: false,
      maxOutputTokens: opts.maxOutputTokens
    }
    this.calls.push(rec)
    const toks = this.nextTokens.shift() ?? []
    if (toks.length > 0) opts.onFirstToken?.()
    for (const tok of toks) onToken(tok)
    return {
      cancel: () => {
        rec.cancelled = true
      },
      done: Promise.resolve(),
      isCancelled: () => rec.cancelled
    }
  }
}

function jsonResponse(obj: unknown): string[] {
  return [JSON.stringify(obj)]
}

function setup(opts?: { enabled?: boolean; customerBriefContent?: string | null }): {
  engine: AnalysisEngine
  llm: StubAnalysisLlm
  state: TranscriptState
  kb: KnowledgeBase
  results: Analysis[]
} {
  const llm = new StubAnalysisLlm()
  const kb = new KnowledgeBase()
  const state = new TranscriptState('sys', 'pb', 12)
  const results: Analysis[] = []
  const engine = new AnalysisEngine(llm, kb, state, (a) => results.push(a), {
    enabled: opts?.enabled ?? true,
    customerBriefContent: opts?.customerBriefContent ?? null
  })
  return { engine, llm, state, kb, results }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AnalysisEngine cancel-previous (mirrors HintEngine — the design, not a bug)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('10 successive settled THEM turn-ends => exactly one generation survives, nine are cancelled', () => {
    const { engine, llm } = setup()
    for (let i = 0; i < 10; i++) {
      engine.onTurnEnd('THEM', `prospect turn number ${i}`)
      vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    }
    expect(llm.calls).toHaveLength(10)
    expect(llm.calls.filter((c) => c.cancelled)).toHaveLength(9)
    expect(llm.calls.filter((c) => !c.cancelled)).toHaveLength(1)
    expect(llm.calls[9]?.cancelled).toBe(false)
  })

  it('never queues: a rapid burst of turn-ends within the debounce window coalesces to a single call', () => {
    const { engine, llm } = setup()
    for (let i = 0; i < 10; i++) {
      engine.onTurnEnd('THEM', `fast turn ${i}`)
      vi.advanceTimersByTime(10) // all inside one 1500ms debounce window
    }
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.cancelled).toBe(false)
  })

  it('ME turns never trigger analysis (settled PROSPECT turn-end only)', () => {
    const { engine, llm } = setup()
    engine.onTurnEnd('ME', 'the rep is talking, not the prospect')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    expect(llm.calls).toHaveLength(0)
  })

  it('an empty settled turn never triggers analysis', () => {
    const { engine, llm } = setup()
    engine.onTurnEnd('THEM', '   ')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    expect(llm.calls).toHaveLength(0)
  })

  it('shutdown cancels the in-flight generation and clears the pending debounce', () => {
    const { engine, llm } = setup()
    engine.onTurnEnd('THEM', 'something being said now')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    engine.shutdown()
    expect(llm.calls[0]?.cancelled).toBe(true)
  })
})

describe('AnalysisEngine closed output schema (zod) — non-conforming responses are dropped', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a valid, closed-schema response reaches the sink, stamped with asOfTurn', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'we are worried about the price')
    llm.nextTokens = [
      jsonResponse({ stage: 'objection', suggested_questions: ['What budget range works?'] })
    ]
    engine.onTurnEnd('THEM', 'we are worried about the price')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      stage: 'objection',
      suggestedQuestions: ['What budget range works?'],
      asOfTurn: 1
    })
  })

  it('accepts exactly 3 suggested_questions — the boundary is inclusive', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [
      jsonResponse({
        stage: 'discovery',
        suggested_questions: ['a', 'b', 'c']
      })
    ]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(1)
    expect(results[0]?.suggestedQuestions).toEqual(['a', 'b', 'c'])
  })

  it('drops a response with more than 3 suggested_questions', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [
      jsonResponse({
        stage: 'discovery',
        suggested_questions: ['a', 'b', 'c', 'd']
      })
    ]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })

  it('drops a response with a stage outside the closed enum', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [jsonResponse({ stage: 'prospect-state-emotional', suggested_questions: [] })]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })

  it('drops malformed (non-JSON) output entirely', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [['not json at all']]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })

  it('drops a response carrying a free-form field not in the closed schema by ignoring extras, but still requires the required fields', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [jsonResponse({ suggested_questions: ['x'] })] // missing required "stage"
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })
})

describe('AnalysisEngine no-sentiment guard (spec.md §1 non-goals, extends Task 3.4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ANALYSIS_SYSTEM_PROMPT explicitly forbids inferring/mentioning emotion, sentiment, stress, or personality', () => {
    const lower = ANALYSIS_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/never infer or mention/i)
    expect(lower).toContain('emotion')
    expect(lower).toContain('sentiment')
    expect(lower).toContain('stress')
    expect(lower).toContain('personality')
  })

  it('ANALYSIS_SYSTEM_PROMPT frames output as legitimate persuasion and prohibits deceptive/urgency/vulnerability tactics', () => {
    const lower = ANALYSIS_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('persuasion')
    expect(lower).toMatch(/deceptive/)
    expect(lower).toMatch(/urgency/)
    expect(lower).toMatch(/vulnerab/)
  })

  it('containsSentimentVocabulary matches EN sentiment/emotion words', () => {
    expect(containsSentimentVocabulary('they seem frustrated about the price')).toBe(true)
    expect(containsSentimentVocabulary('the prospect sounds anxious')).toBe(true)
    expect(containsSentimentVocabulary('ask about their budget timeline')).toBe(false)
  })

  it('containsSentimentVocabulary matches PL sentiment/emotion words', () => {
    expect(containsSentimentVocabulary('klient wydaje się zdenerwowany')).toBe(true)
    expect(containsSentimentVocabulary('zapytaj o budżet na ten rok')).toBe(false)
  })

  it('OUTPUT path: a response whose suggested_questions contains sentiment vocabulary is dropped, not rendered', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [
      jsonResponse({
        stage: 'objection',
        suggested_questions: ['Acknowledge that they seem frustrated and ask why']
      })
    ]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })

  it('OUTPUT path: a response whose next_steps contains PL sentiment vocabulary is dropped', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [
      jsonResponse({
        stage: 'closing',
        suggested_questions: [],
        next_steps: ['Uspokoić zdenerwowanego klienta']
      })
    ]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })

  // Reviewer note (Task 6.4 review round): spec.md §1 prohibits FOUR
  // categories — emotion / sentiment / stress / personality. An earlier
  // version of SENTIMENT_OUTPUT_PATTERNS covered only the first three,
  // letting a personality-profiling suggestion straight through the output
  // guard. These two cases pin all four categories on the output path.
  it('containsSentimentVocabulary matches EN/PL personality vocabulary', () => {
    expect(containsSentimentVocabulary('appeal to their analytical personality type')).toBe(true)
    expect(containsSentimentVocabulary('they read as a classic introvert')).toBe(true)
    expect(containsSentimentVocabulary('dopasuj ofertę do jego osobowości')).toBe(true)
    expect(containsSentimentVocabulary('ask about their renewal timeline')).toBe(false)
  })

  it("OUTPUT path: a response whose suggested_questions profiles the prospect's personality is dropped", async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'turn')
    llm.nextTokens = [
      jsonResponse({
        stage: 'discovery',
        suggested_questions: ['Appeal to their analytical personality type with data-heavy proof']
      })
    ]
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results).toHaveLength(0)
  })
})

describe('AnalysisEngine cloud-send feature flag (default OFF)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flag OFF => engine is fully inert: zero network/LLM calls even on a real settled prospect turn-end', () => {
    const llm = new StubAnalysisLlm()
    llm.failIfCalled = true
    const kb = new KnowledgeBase()
    const state = new TranscriptState('sys', 'pb', 12)
    const results: Analysis[] = []
    const engine = new AnalysisEngine(llm, kb, state, (a) => results.push(a), { enabled: false })

    engine.onTurnEnd('THEM', 'we are worried about the price')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS * 5)

    expect(llm.calls).toHaveLength(0)
    expect(results).toHaveLength(0)
  })

  it('resolveAnalysisEnabledFlag defaults to false (fail-closed) for unset/invalid values', () => {
    expect(resolveAnalysisEnabledFlag(undefined)).toBe(false)
    expect(resolveAnalysisEnabledFlag('')).toBe(false)
    expect(resolveAnalysisEnabledFlag('true')).toBe(false)
    expect(resolveAnalysisEnabledFlag('yes')).toBe(false)
    expect(resolveAnalysisEnabledFlag('0')).toBe(false)
  })

  it('resolveAnalysisEnabledFlag is true only for the explicit "1" value', () => {
    expect(resolveAnalysisEnabledFlag('1')).toBe(true)
  })
})

describe('AnalysisEngine "as of turn N" stamp (display stamp, not a global monotonic counter)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stamps the analysis with the rolling-window turn count at generation time', async () => {
    const { engine, llm, state, results } = setup()
    state.settle('THEM', 'first prospect turn')
    state.settle('ME', 'rep reply')
    state.settle('THEM', 'second prospect turn')
    llm.nextTokens = [jsonResponse({ stage: 'discovery', suggested_questions: [] })]
    engine.onTurnEnd('THEM', 'second prospect turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    await flushMicrotasks()
    expect(results[0]?.asOfTurn).toBe(3)
  })
})

describe('AnalysisEngine input scope (only rolling window + top-K KB + brief leave the device)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the user prompt carries the selected customer brief content when one is configured', () => {
    const llm = new StubAnalysisLlm()
    const kb = new KnowledgeBase()
    const state = new TranscriptState('sys', 'pb', 12)
    state.settle('THEM', 'turn')
    const engine = new AnalysisEngine(llm, kb, state, () => {}, {
      enabled: true,
      customerBriefContent: 'Acme Corp — mid-market SaaS, expansion motion.'
    })
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    expect(llm.calls[0]?.userPrompt).toContain('Acme Corp — mid-market SaaS, expansion motion.')
  })
})

describe('AnalysisEngine hard per-call token cap (spec.md §7 "A hard per-call token cap applies")', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // A large `maxTurns` here means TranscriptState itself never evicts a
  // turn (that cap is orthogonal — spec.md §3's "grow then reset"), so any
  // truncation observed below is provably AnalysisEngine's OWN
  // ANALYSIS_MAX_PROMPT_CHARS cap at work, not TranscriptState's retention
  // window doing the job for it.
  function setupUnbounded(): {
    engine: AnalysisEngine
    llm: StubAnalysisLlm
    state: TranscriptState
  } {
    const llm = new StubAnalysisLlm()
    const kb = new KnowledgeBase()
    const state = new TranscriptState('sys', 'pb', 5000)
    const engine = new AnalysisEngine(llm, kb, state, () => {}, { enabled: true })
    return { engine, llm, state }
  }

  it('bounds an oversized assembled prompt before send — never exceeds ANALYSIS_MAX_PROMPT_CHARS', () => {
    const { engine, llm, state } = setupUnbounded()
    // Grossly oversized rolling window: far beyond ANALYSIS_MAX_PROMPT_CHARS
    // on its own, so the cap must actually engage (not just happen to be a
    // no-op because the fixture was already small).
    for (let i = 0; i < 200; i++) {
      state.settle('THEM', `prospect turn number ${i} with some more filler text to pad it out`)
    }
    engine.onTurnEnd('THEM', 'final prospect turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.userPrompt.length).toBeLessThanOrEqual(ANALYSIS_MAX_PROMPT_CHARS)
  })

  it('truncates the OLDEST rolling-window content first, keeping the newest turn intact', () => {
    const { engine, llm, state } = setupUnbounded()
    state.settle('THEM', 'UNIQUE-OLDEST-MARKER-must-not-survive-truncation')
    for (let i = 0; i < 200; i++) {
      state.settle('THEM', `prospect turn number ${i} with some more filler text to pad it out`)
    }
    state.settle('THEM', 'UNIQUE-NEWEST-MARKER-must-survive-truncation')
    engine.onTurnEnd('THEM', 'UNIQUE-NEWEST-MARKER-must-survive-truncation')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    const prompt = llm.calls[0]?.userPrompt ?? ''
    expect(prompt.length).toBeLessThanOrEqual(ANALYSIS_MAX_PROMPT_CHARS)
    expect(prompt).toContain('UNIQUE-NEWEST-MARKER-must-survive-truncation')
    expect(prompt).not.toContain('UNIQUE-OLDEST-MARKER-must-not-survive-truncation')
  })

  it('forwards ANALYSIS_MAX_OUTPUT_TOKENS as maxOutputTokens on every call', () => {
    const { engine, llm, state } = setup()
    state.settle('THEM', 'turn')
    engine.onTurnEnd('THEM', 'turn')
    vi.advanceTimersByTime(ANALYSIS_DEBOUNCE_MS)
    expect(llm.calls[0]?.maxOutputTokens).toBe(ANALYSIS_MAX_OUTPUT_TOKENS)
  })
})
