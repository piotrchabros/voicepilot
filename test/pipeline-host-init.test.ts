import { describe, expect, it, vi } from 'vitest'
import type { InitMsg } from '@shared/types'
import { sendInitWhenReady } from '../src/main/pipeline-host'

// Reviewer finding on commit cc11c18 (Task 6.7, MAJOR A): pipeline-host.ts
// used to read `deps.getCustomerBrief()` synchronously inside
// `child.once('spawn')`, well before `postMessage(init)` actually fires
// (which waits on `llama.ensure()`) — and 'spawn' itself fires machine-fast,
// long before a human affirms consent, so a real operator's selection would
// typically never reach InitMsg.customerBrief. `sendInitWhenReady` is the
// pure orchestration seam (no Electron API calls) that proves the fix: the
// customer-brief getter is read once `llamaReady` resolves, not before.

const BASE: Omit<InitMsg, 'customerBrief'> = {
  type: 'init',
  sileroPath: '/models/silero_vad.onnx',
  zipformerDir: '/models/zipformer-streaming',
  sonioxApiKey: null,
  sonioxLanguageHints: ['pl', 'en'],
  sonioxWsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
  llamaBase: 'http://127.0.0.1:8080',
  systemPrompt: 'system prompt',
  staticContext: 'static context',
  playbookYaml: '',
  maxTurns: 20,
  bench: false
}

describe('sendInitWhenReady', () => {
  it('reads getCustomerBrief() at send time, not at construction time — a selection made after the pipeline spawns but before llama is ready is still included', async () => {
    let selected: string | null = null
    const sent: InitMsg[] = []
    let resolveLlama: (ok: boolean) => void = () => {}
    const llamaReady = new Promise<boolean>((resolve) => {
      resolveLlama = resolve
    })

    const promise = sendInitWhenReady({
      llamaReady,
      buildBaseInit: () => BASE,
      getCustomerBrief: () => selected,
      onLlamaNotReady: () => {},
      send: (init) => sent.push(init)
    })

    // Nothing sent yet — llamaReady hasn't resolved.
    expect(sent).toHaveLength(0)

    // Simulates the real-world timeline: the utilityProcess 'spawn' event
    // fires immediately, well before the operator affirms consent with a
    // brief selection. The selection only becomes available afterward, but
    // (typically) before llama-server finishes warming up.
    selected = 'acme'
    resolveLlama(true)
    await promise

    expect(sent).toHaveLength(1)
    expect(sent[0]?.customerBrief).toBe('acme')
  })

  it('omits customerBrief entirely when none was ever selected (none-path safety)', async () => {
    const sent: InitMsg[] = []
    await sendInitWhenReady({
      llamaReady: Promise.resolve(true),
      buildBaseInit: () => BASE,
      getCustomerBrief: () => null,
      onLlamaNotReady: () => {},
      send: (init) => sent.push(init)
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.customerBrief).toBeUndefined()
    expect('customerBrief' in (sent[0] as object)).toBe(false)
  })

  it('calls onLlamaNotReady when llama-server did not come up, but still sends init', async () => {
    const notReady = vi.fn()
    const sent: InitMsg[] = []
    await sendInitWhenReady({
      llamaReady: Promise.resolve(false),
      buildBaseInit: () => BASE,
      getCustomerBrief: () => null,
      onLlamaNotReady: notReady,
      send: (init) => sent.push(init)
    })

    expect(notReady).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
  })
})
