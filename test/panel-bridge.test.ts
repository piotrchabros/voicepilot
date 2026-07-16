import { describe, expect, it, vi } from 'vitest'
import type { Analysis, PanelInitMsg } from '@shared/types'
import { buildPanelBridge } from '../src/main/preload-panel'

// Task 6.6 (Plans.md): the analysis panel window's narrow preload surface —
// same pure-seam pattern as preload-bridge.test.ts's buildCopilotBridge
// coverage, so the bridge object's shape is unit-testable without a live
// `contextBridge`.

interface FakeIpcRenderer {
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}

function fakeIpc(): FakeIpcRenderer {
  return { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }
}

describe('buildPanelBridge — onAnalysis', () => {
  it('subscribes on the analysis channel, mirroring CopilotBridge.onAnalysis exactly', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)

    bridge.onAnalysis(vi.fn())

    expect(ipc.on).toHaveBeenCalledWith('analysis', expect.any(Function))
  })

  it('forwards the received analysis payload to the callback, unwrapped', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)

    const cb = vi.fn()
    bridge.onAnalysis(cb)

    const analysis: Analysis = { stage: 'discovery', suggestedQuestions: [], asOfTurn: 1 }
    const listener = ipc.on.mock.calls.find(([channel]) => channel === 'analysis')?.[1] as (
      e: unknown,
      a: Analysis
    ) => void
    listener(undefined, analysis)

    expect(cb).toHaveBeenCalledWith(analysis)
  })

  it('returns an unsubscribe function that removes exactly the analysis listener', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)

    const unsubscribe = bridge.onAnalysis(vi.fn())
    unsubscribe()

    expect(ipc.removeListener).toHaveBeenCalledWith('analysis', expect.any(Function))
  })
})

describe('buildPanelBridge — onPanelInit', () => {
  it('subscribes on the panel-init channel and forwards the payload unwrapped', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)

    const cb = vi.fn()
    bridge.onPanelInit(cb)
    expect(ipc.on).toHaveBeenCalledWith('panel-init', expect.any(Function))

    const msg: PanelInitMsg = { type: 'panel-init', analysisEnabled: true }
    const listener = ipc.on.mock.calls.find(([channel]) => channel === 'panel-init')?.[1] as (
      e: unknown,
      m: PanelInitMsg
    ) => void
    listener(undefined, msg)

    expect(cb).toHaveBeenCalledWith(msg)
  })
})

describe('buildPanelBridge — refreshNow / ready', () => {
  it('sends panel:refresh with no arguments', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)

    bridge.refreshNow()

    expect(ipc.send).toHaveBeenCalledWith('panel:refresh')
  })

  it('sends panel:ready with no arguments', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)

    bridge.ready()

    expect(ipc.send).toHaveBeenCalledWith('panel:ready')
  })
})

describe('buildPanelBridge — narrow surface', () => {
  it('never subscribes to hint/health/consent channels — only analysis and panel-init', () => {
    const ipc = fakeIpc()
    const bridge = buildPanelBridge(ipc as never)
    bridge.onAnalysis(vi.fn())
    bridge.onPanelInit(vi.fn())

    const channels = ipc.on.mock.calls.map(([channel]) => channel)
    expect(channels.sort()).toEqual(['analysis', 'panel-init'])
  })
})
