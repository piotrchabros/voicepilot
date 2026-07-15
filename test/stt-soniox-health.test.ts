import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fake `ws` so we can fire real 'open'/'error' events at SonioxStt and assert
// the onHealth callback actually fires with the right payload — not just that
// the wiring compiles (spec.md Task 2.4: events must really fire).
vi.mock('ws', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter } = require('node:events')
  class FakeWebSocket extends EventEmitter {
    sent: unknown[] = []
    url: string
    constructor(url: string) {
      super()
      this.url = url
      ;(FakeWebSocket as unknown as { instances: FakeWebSocket[] }).instances.push(this)
    }
    send(data: unknown): void {
      this.sent.push(data)
    }
    close(): void {
      this.emit('close')
    }
  }
  ;(FakeWebSocket as unknown as { instances: FakeWebSocket[] }).instances = []
  return { default: FakeWebSocket }
})

async function fakeInstances(): Promise<
  Array<{ emit: (event: string, ...args: unknown[]) => void }>
> {
  const mod = (await import('ws')) as unknown as {
    default: { instances: Array<{ emit: (event: string, ...args: unknown[]) => void }> }
  }
  return mod.default.instances
}

beforeEach(async () => {
  const mod = (await import('ws')) as unknown as { default: { instances: unknown[] } }
  mod.default.instances = []
})

describe('SonioxStt onHealth (real ws event injection)', () => {
  it('reports ok:true when the socket opens (connected)', async () => {
    const { SonioxStt } = await import('../src/pipeline/stt-soniox')
    const events: Array<{ ok: boolean; detail: string }> = []
    const stt = new SonioxStt({
      apiKey: 'k',
      wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      onHealth: (ok, detail) => events.push({ ok, detail })
    })

    stt.accept(new Float32Array(512)) // triggers lazy connect()
    const instances = await fakeInstances()
    expect(instances).toHaveLength(1)
    instances[0]?.emit('open')

    expect(events).toEqual([{ ok: true, detail: 'connected' }])
    stt.close()
  })

  it('reports ok:false with the error message when the socket errors (disconnect)', async () => {
    const { SonioxStt } = await import('../src/pipeline/stt-soniox')
    const events: Array<{ ok: boolean; detail: string }> = []
    const stt = new SonioxStt({
      apiKey: 'k',
      wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      onHealth: (ok, detail) => events.push({ ok, detail })
    })

    stt.accept(new Float32Array(512))
    const instances = await fakeInstances()
    instances[0]?.emit('error', new Error('socket hang up'))

    expect(events).toEqual([{ ok: false, detail: 'ws error: socket hang up' }])
    stt.close()
  })
})
