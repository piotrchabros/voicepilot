import { describe, expect, it, vi } from 'vitest'
import type { Analysis, FromPipeline } from '@shared/types'
import { buildAnalysisSink } from '../src/pipeline/index'

// Task 6.5 (Plans.md): AnalysisEngine's sink (constructed in pipeline/index.ts's
// init()) must forward every analysis result to `send({ type: 'analysis',
// analysis })`, on top of the existing debug-gated `formatAnalysisLog` call
// (Task 6.4). `buildAnalysisSink` is the pure seam — same extraction pattern
// as `formatAnalysisLog`/`sendInitWhenReady`/`routeFromPipelineMessage` — so
// the wiring is unit-testable without a live `parentPort`/full `init()`.

describe('buildAnalysisSink (engine-sink -> send wiring, Task 6.5)', () => {
  const analysis: Analysis = {
    stage: 'discovery',
    suggestedQuestions: ['What matters most to you?'],
    asOfTurn: 5
  }

  it('sends an AnalysisMsg wrapping the analysis unchanged', () => {
    const sent: FromPipeline[] = []
    const sink = buildAnalysisSink(false, (msg) => sent.push(msg), vi.fn())

    sink(analysis)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ type: 'analysis', analysis })
  })

  it('never logs analysis content when debug is off, but still sends', () => {
    const sent: FromPipeline[] = []
    const log = vi.fn()
    const sink = buildAnalysisSink(false, (msg) => sent.push(msg), log)

    sink(analysis)

    expect(log).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it('logs analysis content only when debug is explicitly on, and still sends', () => {
    const sent: FromPipeline[] = []
    const log = vi.fn()
    const sink = buildAnalysisSink(true, (msg) => sent.push(msg), log)

    sink(analysis)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('discovery'))
    expect(sent).toHaveLength(1)
  })
})
