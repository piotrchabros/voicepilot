import { describe, expect, it, vi } from 'vitest'
import type { Analysis, FromPipeline, HealthMsg, Hint, LogMsg } from '@shared/types'
import { routeFromPipelineMessage } from '../src/main/pipeline-host'

// Task 6.5 (Plans.md): `AnalysisMsg` routing from the pipeline utilityProcess
// to main — mirrors the existing 'hint' case exactly (see pipeline-host.ts's
// `child.on('message')` switch). Extracted as a pure seam, same pattern as
// `sendInitWhenReady` in pipeline-host-init.test.ts, so the routing table is
// unit-testable without a live `utilityProcess`.

function makeDeps() {
  return {
    onHint: vi.fn<(hint: Hint) => void>(),
    onLog: vi.fn<(log: LogMsg) => void>(),
    onHealth: vi.fn<(health: HealthMsg) => void>(),
    onAnalysis: vi.fn<(analysis: Analysis) => void>()
  }
}

describe('routeFromPipelineMessage', () => {
  it('routes an analysis message to deps.onAnalysis', () => {
    const deps = makeDeps()
    const log = vi.fn()
    const analysis: Analysis = { stage: 'demo', suggestedQuestions: [], asOfTurn: 2 }
    const msg: FromPipeline = { type: 'analysis', analysis }

    routeFromPipelineMessage(msg, deps, log)

    expect(deps.onAnalysis).toHaveBeenCalledTimes(1)
    expect(deps.onAnalysis).toHaveBeenCalledWith(analysis)
    expect(deps.onHint).not.toHaveBeenCalled()
    expect(deps.onHealth).not.toHaveBeenCalled()
    expect(deps.onLog).not.toHaveBeenCalled()
  })

  it('is a no-op when deps.onAnalysis is not wired (optional handler)', () => {
    const { onAnalysis: _omit, ...deps } = makeDeps()
    const log = vi.fn()
    const analysis: Analysis = { stage: 'demo', suggestedQuestions: [], asOfTurn: 2 }
    const msg: FromPipeline = { type: 'analysis', analysis }

    expect(() => routeFromPipelineMessage(msg, deps, log)).not.toThrow()
  })

  it('still routes hint messages to deps.onHint (no regression to the existing switch)', () => {
    const deps = makeDeps()
    const log = vi.fn()
    const hint: Hint = { text: 'ask about timeline', source: 'GENERATED' }
    const msg: FromPipeline = { type: 'hint', hint }

    routeFromPipelineMessage(msg, deps, log)

    expect(deps.onHint).toHaveBeenCalledWith(hint)
    expect(deps.onAnalysis).not.toHaveBeenCalled()
  })

  it('still routes health messages to deps.onHealth (no regression)', () => {
    const deps = makeDeps()
    const log = vi.fn()
    const health: HealthMsg = { type: 'health', ok: false, source: 'sidecar', detail: 'exited' }
    const msg: FromPipeline = health

    routeFromPipelineMessage(msg, deps, log)

    expect(deps.onHealth).toHaveBeenCalledWith(msg)
  })

  it('still routes log messages to deps.onLog (no regression)', () => {
    const deps = makeDeps()
    const log = vi.fn()
    const msg: FromPipeline = { type: 'log', level: 'info', msg: 'hello' }

    routeFromPipelineMessage(msg, deps, log)

    expect(deps.onLog).toHaveBeenCalledWith(msg)
  })

  it('logs an info line on ready, and ignores metric (no regression)', () => {
    const deps = makeDeps()
    const log = vi.fn()

    routeFromPipelineMessage({ type: 'ready' }, deps, log)
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('ready'))

    routeFromPipelineMessage({ type: 'metric', stage: 'frame_in', ms: 1 }, deps, log)
    expect(deps.onHint).not.toHaveBeenCalled()
    expect(deps.onLog).not.toHaveBeenCalled()
    expect(deps.onHealth).not.toHaveBeenCalled()
    expect(deps.onAnalysis).not.toHaveBeenCalled()
  })
})
