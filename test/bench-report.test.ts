import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuggestionTiming } from '@shared/types'
import {
  type AnalysisSample,
  compareCardPaths,
  FakeAnalysisLlm,
  report,
  reportAnalysis,
  reportCardPathComparison
} from '../src/main/bench'

// Pure aggregation/print path of --bench (Task 3.3): exercised with fixture
// SuggestionTiming[] so it doesn't need real models/wav — that part of
// runBench() stays integration-only.

describe('bench report() — Hint.timing-based aggregation with transport tag', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints n/p50/p95 per stage plus a transport column', () => {
    const timings: SuggestionTiming[] = [
      {
        transport: 'file',
        stages: {
          frame_in: 0,
          vad_out: 4,
          stt_interim: 20,
          speculate_fired: 220,
          first_token: 270,
          painted: 272
        }
      },
      {
        transport: 'file',
        stages: {
          frame_in: 0,
          vad_out: 6,
          stt_interim: 24,
          speculate_fired: 224,
          first_token: 280,
          painted: 283
        }
      }
    ]

    report(timings)
    const table = logs.join('\n')

    expect(table).toContain('frame_in -> vad_out')
    expect(table).toContain('vad_out -> stt_interim')
    expect(table).toContain('stt_interim -> speculate')
    expect(table).toContain('speculate -> first_token')
    expect(table).toContain('first_token -> painted')
    // transport column present on every row
    const dataRows = logs.filter((l) => l.includes('->'))
    expect(dataRows).toHaveLength(5)
    for (const row of dataRows) expect(row.trim().endsWith('file')).toBe(true)
  })

  it('n=0 stages print em-dash placeholders, not crashes', () => {
    report([])
    const table = logs.join('\n')
    expect(table).toContain('—')
  })

  it('mixed transports get separate (stage, transport) rows, never averaged together', () => {
    const timings: SuggestionTiming[] = [
      { transport: 'file', stages: { frame_in: 0, vad_out: 4 } },
      { transport: 'system', stages: { frame_in: 0, vad_out: 6 } }
    ]
    report(timings)
    const table = logs.join('\n')
    // Never joins transports into a single tag on one row.
    expect(table).not.toContain('file,system')

    const vadRows = logs.filter((l) => l.includes('frame_in -> vad_out'))
    expect(vadRows).toHaveLength(2)
    const fileRow = vadRows.find((r) => r.trim().endsWith('file'))
    const systemRow = vadRows.find((r) => r.trim().endsWith('system'))
    expect(fileRow).toBeDefined()
    expect(systemRow).toBeDefined()
    // Each transport's own n=1 sample, not pooled n=2.
    expect(fileRow).toMatch(/\b1\b/)
    expect(systemRow).toMatch(/\b1\b/)
  })
})

// Task 6.9: analysis latency p50/p95 + tokens/call, reported SEPARATELY from
// BenchStage/report() above (spec.md §7 "Bench reports analysis p50/p95 and
// tokens/call separately from BenchStage") — FakeAnalysisLlm never touches
// the network (mirrors FakeCloudClient in test/cloud-llm-client.test.ts),
// letting --bench drive AnalysisEngine's cancel-previous/timing code paths
// deterministically without a real cloud LLM.
describe('FakeAnalysisLlm (deterministic, network-free analysis double for --bench)', () => {
  it('records one AnalysisSample per settled (non-cancelled) generate() call', async () => {
    const llm = new FakeAnalysisLlm({ latencyMs: 10, tokensPerCall: 40 })
    const gen = llm.generate('SYS', 'USER-PROMPT', () => {}, { maxOutputTokens: 300 })
    await gen.done
    expect(llm.samples).toHaveLength(1)
    expect(llm.samples[0]?.latencyMs).toBe(10)
    expect(llm.samples[0]?.promptChars).toBe('SYS'.length + 'USER-PROMPT'.length)
    expect(llm.samples[0]?.outputTokens).toBe(40)
  })

  it('caps recorded outputTokens at the caller-supplied maxOutputTokens (6.4 hard per-call cap accounting)', async () => {
    const llm = new FakeAnalysisLlm({ latencyMs: 5, tokensPerCall: 500 })
    const gen = llm.generate('sys', 'user', () => {}, { maxOutputTokens: 30 })
    await gen.done
    expect(llm.samples[0]?.outputTokens).toBe(30)
  })

  it('a cancelled generation records no sample and never fires onToken (mirrors cancel-previous)', async () => {
    const llm = new FakeAnalysisLlm({ latencyMs: 50 })
    const onTokenCalls: string[] = []
    const gen = llm.generate('sys', 'user', (tok) => onTokenCalls.push(tok))
    gen.cancel()
    await gen.done
    expect(llm.samples).toHaveLength(0)
    expect(onTokenCalls).toHaveLength(0)
    expect(gen.isCancelled()).toBe(true)
  })

  it('done never rejects, including after cancel (same contract as CloudLlmClient)', async () => {
    const llm = new FakeAnalysisLlm({ latencyMs: 1 })
    const gen = llm.generate('sys', 'user', () => {})
    gen.cancel()
    await expect(gen.done).resolves.toBeUndefined()
  })
})

describe('reportAnalysis() — p50/p95 latency + tokens/call, printed as a SEPARATE section from BenchStage', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '))
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints n, p50(ms), p95(ms), and avg tokens/call for a set of samples', () => {
    const samples: AnalysisSample[] = [
      { latencyMs: 200, promptChars: 1000, outputTokens: 40 },
      { latencyMs: 240, promptChars: 1200, outputTokens: 45 },
      { latencyMs: 900, promptChars: 1500, outputTokens: 50 }
    ]
    reportAnalysis(samples)
    const table = logs.join('\n')
    expect(table).toMatch(/\b3\b/) // n = 3
    expect(table).toContain('analysis')
    // p95 of [200,240,900] with the same nearest-rank method as report()'s
    // pct() (index = floor(0.95*3) = 2) is the max sample, 900.
    expect(table).toMatch(/900\.0/)
  })

  it('n=0 prints an em-dash placeholder row, not a crash', () => {
    reportAnalysis([])
    const table = logs.join('\n')
    expect(table).toContain('—')
  })
})

describe('compareCardPaths() — hint p50/p95 with analysis(fake) enabled vs disabled must stay within noise threshold', () => {
  function timing(stages: Partial<Record<string, number>>): SuggestionTiming {
    return { transport: 'file', stages: stages as SuggestionTiming['stages'] }
  }

  it('flags "unchanged" when every shared stage delta is under the noise threshold', () => {
    const withAnalysis = [
      timing({
        frame_in: 0,
        vad_out: 4,
        stt_interim: 20,
        speculate_fired: 220,
        first_token: 271,
        painted: 273
      })
    ]
    const withoutAnalysis = [
      timing({
        frame_in: 0,
        vad_out: 4,
        stt_interim: 20,
        speculate_fired: 220,
        first_token: 270,
        painted: 272
      })
    ]
    const result = compareCardPaths(withAnalysis, withoutAnalysis, 5)
    expect(result.unchanged).toBe(true)
    expect(result.rows.length).toBeGreaterThan(0)
  })

  it('flags "changed" when a shared stage delta exceeds the noise threshold', () => {
    const withAnalysis = [
      timing({
        frame_in: 0,
        vad_out: 4,
        stt_interim: 20,
        speculate_fired: 220,
        first_token: 400,
        painted: 410
      })
    ]
    const withoutAnalysis = [
      timing({
        frame_in: 0,
        vad_out: 4,
        stt_interim: 20,
        speculate_fired: 220,
        first_token: 270,
        painted: 272
      })
    ]
    const result = compareCardPaths(withAnalysis, withoutAnalysis, 5)
    expect(result.unchanged).toBe(false)
  })

  it('a stage missing from BOTH runs (e.g. no llama-server reachable) is not counted as a regression', () => {
    const withAnalysis = [timing({ frame_in: 0, vad_out: 4, stt_interim: 20 })]
    const withoutAnalysis = [timing({ frame_in: 0, vad_out: 6, stt_interim: 22 })]
    const result = compareCardPaths(withAnalysis, withoutAnalysis, 5)
    expect(result.unchanged).toBe(true)
    const speculateRow = result.rows.find((r) => r.label === 'stt_interim->speculate_fired')
    expect(speculateRow?.deltaP50).toBeNull()
  })

  it('reportCardPathComparison() prints a table plus a final unchanged/changed verdict line', () => {
    let logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '))
    })
    const result = compareCardPaths(
      [timing({ frame_in: 0, vad_out: 4 })],
      [timing({ frame_in: 0, vad_out: 5 })],
      5
    )
    reportCardPathComparison(result)
    const table = logs.join('\n')
    expect(table.toLowerCase()).toMatch(/unchanged/)
    spy.mockRestore()
    logs = []
  })
})
