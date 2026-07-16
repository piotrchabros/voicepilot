import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/types'
import { buildCopilotBridge } from '../src/main/preload'

// Task 6.5 (Plans.md): `CopilotBridge.onAnalysis` must mirror `onHint`
// exactly — subscribe/unsubscribe via `ipcRenderer.on`/`removeListener` on a
// single fixed channel, nothing else crossing the bridge. `preload.ts` calls
// `contextBridge.exposeInMainWorld` at module scope (a real Electron API,
// unavailable outside a preload context) — `buildCopilotBridge` is the pure
// seam that lets the bridge object's shape be unit-tested without it, same
// pattern as `sendInitWhenReady`/`routeFromPipelineMessage`.

interface FakeIpcRenderer {
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function fakeIpc(): FakeIpcRenderer {
  return { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }
}

describe('buildCopilotBridge — onAnalysis (Task 6.5)', () => {
  it('subscribes on the analysis channel exactly like onHint subscribes on hint', () => {
    const ipc = fakeIpc()
    const bridge = buildCopilotBridge(ipc as never)

    const cb = vi.fn()
    bridge.onAnalysis(cb)

    expect(ipc.on).toHaveBeenCalledWith('analysis', expect.any(Function))
  })

  it('forwards the received analysis payload to the callback, unwrapped', () => {
    const ipc = fakeIpc()
    const bridge = buildCopilotBridge(ipc as never)

    const cb = vi.fn()
    bridge.onAnalysis(cb)

    const analysis: Analysis = { stage: 'closing', suggestedQuestions: [], asOfTurn: 4 }
    const listener = ipc.on.mock.calls.find(([channel]) => channel === 'analysis')?.[1] as (
      e: unknown,
      a: Analysis
    ) => void
    listener(undefined, analysis)

    expect(cb).toHaveBeenCalledWith(analysis)
  })

  it('returns an unsubscribe function that removes exactly the analysis listener', () => {
    const ipc = fakeIpc()
    const bridge = buildCopilotBridge(ipc as never)

    const unsubscribe = bridge.onAnalysis(vi.fn())
    unsubscribe()

    expect(ipc.removeListener).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener.mock.calls[0]?.[0]).toBe('analysis')
  })

  it('does not touch any other bridge channel (hint/health/consent unaffected)', () => {
    const ipc = fakeIpc()
    const bridge = buildCopilotBridge(ipc as never)
    bridge.onAnalysis(vi.fn())

    const channels = ipc.on.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual(['analysis'])
  })
})
