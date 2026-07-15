import { describe, expect, it } from 'vitest'
import type { AudioFrame, AudioSource, Separation, SpeakerRole } from '@shared/audio-source'
import { type AudioSourceHarness, describeAudioSourceContract } from './audio-source-contract'

/** One buffered frame, as supplied to `MemoryAudioSource`. */
interface MemoryFrameSpec {
  speaker: SpeakerRole
  pcm: Float32Array
  t: number
}

type AudioHandler = (frame: AudioFrame) => void
type EndHandler = (reason: string) => void
type HealthHandler = (status: { ok: boolean; detail: string }) => void

/**
 * Minimal in-memory `AudioSource` test double: replays a fixed frame sequence.
 * Test-only — production doubles live behind `FileAudioSource` (wav replay).
 */
class MemoryAudioSource implements AudioSource {
  readonly transport = 'file' as const
  readonly speakers: readonly SpeakerRole[]
  readonly separation: Separation

  private readonly frames: readonly MemoryFrameSpec[]
  private readonly audioHandlers: AudioHandler[] = []
  private readonly endHandlers: EndHandler[] = []
  private readonly healthHandlers: HealthHandler[] = []
  private stopped = false
  private ended = false

  constructor(
    frames: readonly MemoryFrameSpec[],
    opts?: { speakers?: readonly SpeakerRole[]; separation?: Separation }
  ) {
    this.frames = frames
    this.speakers = opts?.speakers ?? ['prospect', 'rep']
    this.separation = opts?.separation ?? 'clean'
  }

  async start(): Promise<void> {
    // No-op: MemoryAudioSource has nothing to open. Frame delivery is driven
    // explicitly by `drive()` (the contract's `drive` hook).
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.emitEnd('stopped')
  }

  on(event: 'audio', handler: AudioHandler): void
  on(event: 'end', handler: EndHandler): void
  on(event: 'health', handler: HealthHandler): void
  on(event: 'audio' | 'end' | 'health', handler: AudioHandler | EndHandler | HealthHandler): void {
    if (event === 'audio') this.audioHandlers.push(handler as AudioHandler)
    else if (event === 'end') this.endHandlers.push(handler as EndHandler)
    else this.healthHandlers.push(handler as HealthHandler)
  }

  /** Test-only driver: delivers every buffered frame (unless `stop()` has
   *  already fired), then ends. Each frame delivery crosses a microtask
   *  boundary so a `stop()` racing the drive can actually cut it short. */
  async drive(): Promise<void> {
    for (const spec of this.frames) {
      if (this.stopped) return
      await Promise.resolve()
      if (this.stopped) return
      const frame: AudioFrame = { speaker: spec.speaker, pcm: spec.pcm, t: spec.t }
      for (const h of this.audioHandlers) h(frame)
    }
    this.emitEnd('drained')
  }

  private emitEnd(reason: string): void {
    if (this.ended) return
    this.ended = true
    for (const h of this.endHandlers) h(reason)
  }
}

function defaultFrames(): MemoryFrameSpec[] {
  return [
    { speaker: 'prospect', pcm: new Float32Array([0.1, -0.2, 0.3]), t: 0 },
    { speaker: 'rep', pcm: new Float32Array([0.05, 0.15]), t: 32 },
    { speaker: 'prospect', pcm: new Float32Array([-0.1, 0.2]), t: 64 }
  ]
}

async function factory(): Promise<AudioSourceHarness & { source: MemoryAudioSource }> {
  const source = new MemoryAudioSource(defaultFrames())
  return { source, drive: () => source.drive() }
}

describeAudioSourceContract('memory', factory)

describe('MemoryAudioSource (test double, additional coverage)', () => {
  it('stop() called mid-drive halts further frame delivery', async () => {
    const source = new MemoryAudioSource(defaultFrames())
    const received: AudioFrame[] = []
    source.on('audio', (f) => received.push(f))

    await source.start()
    const drivePromise = source.drive()
    await source.stop() // races the in-flight drive() before its first microtask boundary
    await drivePromise

    expect(received.length).toBeLessThan(defaultFrames().length)
  })

  it('reports the declared transport, speakers, and separation', async () => {
    const source = new MemoryAudioSource(defaultFrames(), {
      speakers: ['prospect'],
      separation: 'mixed'
    })

    expect(source.transport).toBe('file')
    expect(source.speakers).toEqual(['prospect'])
    expect(source.separation).toBe('mixed')
  })
})
