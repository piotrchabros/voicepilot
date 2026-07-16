import { describe, expect, it } from 'vitest'
import type { Analysis, AnalysisMsg, FromPipeline } from '@shared/types'

// Task 6.5 (spec.md §7 / Phase-5 WS-bridge compatibility): `AnalysisMsg` must
// be plain-serializable JSON — no class instances, no functions, no `Date`
// objects — so it survives a `utilityProcess.postMessage()` structured-clone
// today AND a JSON-over-WebSocket bridge in Phase 5.1 unchanged. A JSON
// round-trip (`JSON.parse(JSON.stringify(x))`) that produces a
// deep-equal value is exactly that guarantee.

describe('AnalysisMsg wire shape (spec.md §7, Plans.md Task 6.5)', () => {
  const analysis: Analysis = {
    stage: 'objection',
    suggestedQuestions: ['What budget range are you working with?', 'Who else is involved?'],
    nextSteps: ['Send a follow-up proposal'],
    asOfTurn: 7
  }

  it('Analysis round-trips through JSON unchanged (plain-serializable)', () => {
    const roundTripped = JSON.parse(JSON.stringify(analysis)) as Analysis
    expect(roundTripped).toEqual(analysis)
  })

  it('AnalysisMsg round-trips through JSON unchanged (plain-serializable)', () => {
    const msg: AnalysisMsg = { type: 'analysis', analysis }
    const roundTripped = JSON.parse(JSON.stringify(msg)) as AnalysisMsg
    expect(roundTripped).toEqual(msg)
  })

  it('omits nextSteps cleanly when absent — no `undefined` leaking into the wire shape', () => {
    const noNextSteps: Analysis = {
      stage: 'discovery',
      suggestedQuestions: [],
      asOfTurn: 1
    }
    const roundTripped = JSON.parse(JSON.stringify(noNextSteps)) as Analysis
    expect(roundTripped).toEqual(noNextSteps)
    expect('nextSteps' in roundTripped).toBe(false)
  })

  it('is assignable into the FromPipeline union', () => {
    const msg: FromPipeline = { type: 'analysis', analysis }
    expect(msg.type).toBe('analysis')
  })
})
