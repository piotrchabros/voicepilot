import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SuggestionTiming } from '@shared/types'
import { report } from '../src/main/bench'

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
