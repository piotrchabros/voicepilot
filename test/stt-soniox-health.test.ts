import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fake `ws` so we can fire real 'open'/'error'/'close'/'message' events at
// SonioxStt and assert the onHealth callback actually fires with the right
// payload — not just that the wiring compiles (spec.md Task 2.4: events must
// really fire, including the paths the first pass missed: a server-initiated
// close with no preceding 'error', and a protocol-level error_code response).
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
      this.emit('close', 1000)
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

  it('reports ok:false when the server closes the socket with no preceding error', async () => {
    const { SonioxStt } = await import('../src/pipeline/stt-soniox')
    const events: Array<{ ok: boolean; detail: string }> = []
    const stt = new SonioxStt({
      apiKey: 'k',
      wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      onHealth: (ok, detail) => events.push({ ok, detail })
    })

    stt.accept(new Float32Array(512))
    const instances = await fakeInstances()
    instances[0]?.emit('open')
    instances[0]?.emit('close', 1006) // abnormal server-initiated close, no 'error' fired

    expect(events).toEqual([
      { ok: true, detail: 'connected' },
      { ok: false, detail: 'ws closed: 1006' }
    ])
  })

  it('reports ok:false for a protocol-level error_code response (no ws error/close)', async () => {
    const { SonioxStt } = await import('../src/pipeline/stt-soniox')
    const events: Array<{ ok: boolean; detail: string }> = []
    const stt = new SonioxStt({
      apiKey: 'k',
      wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      onHealth: (ok, detail) => events.push({ ok, detail })
    })

    stt.accept(new Float32Array(512))
    const instances = await fakeInstances()
    instances[0]?.emit('open')
    instances[0]?.emit(
      'message',
      Buffer.from(JSON.stringify({ error_code: 'invalid_audio', error_message: 'bad frame' }))
    )

    expect(events).toEqual([
      { ok: true, detail: 'connected' },
      { ok: false, detail: 'invalid_audio: bad frame' }
    ])
    stt.close()
  })

  it('does not report a health event for an intentional close() (session teardown)', async () => {
    const { SonioxStt } = await import('../src/pipeline/stt-soniox')
    const events: Array<{ ok: boolean; detail: string }> = []
    const stt = new SonioxStt({
      apiKey: 'k',
      wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      onHealth: (ok, detail) => events.push({ ok, detail })
    })

    stt.accept(new Float32Array(512))
    const instances = await fakeInstances()
    instances[0]?.emit('open')
    stt.close() // triggers hangup() -> ws.close() -> fake emits 'close'

    expect(events).toEqual([{ ok: true, detail: 'connected' }])
  })

  it('does not report a health event for the lazy idle hangup (housekeep) — not a failure', async () => {
    vi.useFakeTimers()
    try {
      const { SonioxStt } = await import('../src/pipeline/stt-soniox')
      const events: Array<{ ok: boolean; detail: string }> = []
      const stt = new SonioxStt({
        apiKey: 'k',
        wsUrl: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
        onHealth: (ok, detail) => events.push({ ok, detail })
      })

      stt.accept(new Float32Array(512))
      const instances = await fakeInstances()
      instances[0]?.emit('open')

      // Idle past IDLE_CLOSE_MS (30s); housekeeper polls every 5s.
      await vi.advanceTimersByTimeAsync(35_000)

      expect(events).toEqual([{ ok: true, detail: 'connected' }])
      stt.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
