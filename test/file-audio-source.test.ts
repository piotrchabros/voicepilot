import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioFrame } from '@shared/audio-source'
import { FRAME_MS } from '@shared/types'
import { FileAudioSource } from '../src/pipeline/file-audio-source'
import { type AudioSourceHarness, describeAudioSourceContract } from './audio-source-contract'

/** Minimal PCM16 mono WAV writer, mirroring `test/wav.test.ts`'s helper —
 *  kept local so this file drives its own fixtures independently. */
function makeWavPcm16(samples: number[], sampleRate = 16000, channels = 1): Buffer {
  const dataLen = samples.length * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * 2, 28)
  buf.writeUInt16LE(channels * 2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataLen, 40)
  samples.forEach((s, i) =>
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32768))), 44 + i * 2)
  )
  return buf
}

const tmpDir = mkdtempSync(join(tmpdir(), 'file-audio-source-test-'))

/** 3 full 512-sample frames + a partial tail (dropped by `toFrames`). */
const FRAME_COUNT = 3
const TOTAL_SAMPLES = 512 * FRAME_COUNT + 100

function sineSamples(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.sin(i / 20) * 0.5)
  return out
}

const validWavPath = join(tmpDir, 'valid.wav')
writeFileSync(validWavPath, makeWavPcm16(sineSamples(TOTAL_SAMPLES)))

const missingWavPath = join(tmpDir, 'does-not-exist.wav')

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

async function factory(): Promise<AudioSourceHarness & { source: FileAudioSource }> {
  const source = new FileAudioSource(validWavPath, { realtime: false })
  return {
    source,
    drive: () =>
      new Promise<void>((resolve) => {
        source.on('end', () => resolve())
      }),
    triggerHealth: () => {
      // Real trigger path: start a second FileAudioSource pointed at a file
      // that does not exist, and forward its genuine `health` event onto the
      // instance under test (spec.md §2's on('health') is a real event, not
      // a stub — see audio-source-contract.ts test (f)).
      const broken = new FileAudioSource(missingWavPath, { realtime: false })
      broken.on('health', (status) => source.reportHealth(status))
      void broken.start()
    }
  }
}

describeAudioSourceContract('file', factory)

describe('FileAudioSource (file-specific behavior)', () => {
  it('reports transport "file", declared speaker, and clean separation', async () => {
    const source = new FileAudioSource(validWavPath, { speaker: 'rep', realtime: false })
    expect(source.transport).toBe('file')
    expect(source.speakers).toEqual(['rep'])
    expect(source.separation).toBe('clean')
  })

  it('defaults speaker to "prospect" when unspecified', async () => {
    const source = new FileAudioSource(validWavPath, { realtime: false })
    expect(source.speakers).toEqual(['prospect'])
  })

  it('emits exactly floor(samples/512) frames for the fixture wav', async () => {
    const source = new FileAudioSource(validWavPath, { realtime: false })
    const frames: number[] = []
    source.on('audio', (f) => frames.push(f.t))
    await source.start()
    await new Promise<void>((resolve) => source.on('end', () => resolve()))
    await source.stop()

    expect(frames.length).toBe(FRAME_COUNT)
  })

  it('assigns t as an arithmetic sequence, frameIndex * 32ms apart', async () => {
    const source = new FileAudioSource(validWavPath, { realtime: false })
    const timestamps: number[] = []
    source.on('audio', (f) => timestamps.push(f.t))
    await source.start()
    await new Promise<void>((resolve) => source.on('end', () => resolve()))
    await source.stop()

    expect(timestamps).toEqual([0, 32, 64])
  })

  it('emits a health failure (not a thrown error) when the wav file is missing', async () => {
    const source = new FileAudioSource(missingWavPath, { realtime: false })
    const statuses: Array<{ ok: boolean; detail: string }> = []
    let endReason = ''
    source.on('health', (s) => statuses.push(s))
    source.on('end', (reason) => {
      endReason = reason
    })

    await source.start()

    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.ok).toBe(false)
    expect(statuses[0]?.detail).toContain(missingWavPath)
    expect(endReason).toBe('missing-file')
  })
})

// `realtime: true` is the default and the mode `--bench` actually uses
// (`src/main/bench.ts` via `streamFrames`), so its `setTimeout`-paced
// `driveRealtime` path needs its own coverage — the contract suite above
// always drives `realtime: false` for speed.
describe('FileAudioSource (realtime driving, default mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits correctly shaped frames at the natural (realtime) cadence', async () => {
    const source = new FileAudioSource(validWavPath) // realtime defaults to true
    const frames: AudioFrame[] = []
    source.on('audio', (f) => frames.push(f))

    await source.start()
    await vi.advanceTimersByTimeAsync(FRAME_COUNT * FRAME_MS)
    await source.stop()

    expect(frames.length).toBe(FRAME_COUNT)
    for (const f of frames) {
      expect(f.pcm).toBeInstanceOf(Float32Array)
      for (const sample of f.pcm) {
        expect(Number.isFinite(sample)).toBe(true)
      }
      expect(typeof f.t).toBe('number')
      expect(Number.isFinite(f.t)).toBe(true)
    }
  })

  it('assigns t as an arithmetic sequence, FRAME_MS apart, at realtime cadence', async () => {
    const source = new FileAudioSource(validWavPath, { realtime: true })
    const timestamps: number[] = []
    source.on('audio', (f) => timestamps.push(f.t))

    await source.start()
    await vi.advanceTimersByTimeAsync(FRAME_COUNT * FRAME_MS)
    await source.stop()

    expect(timestamps).toEqual([0, FRAME_MS, 2 * FRAME_MS])
  })

  it('emits "end" exactly once at realtime cadence', async () => {
    const source = new FileAudioSource(validWavPath, { realtime: true })
    let endCount = 0
    source.on('end', () => {
      endCount++
    })

    await source.start()
    await vi.advanceTimersByTimeAsync(FRAME_COUNT * FRAME_MS + FRAME_MS)
    await source.stop()

    expect(endCount).toBe(1)
  })

  it('stop() racing an in-flight realtime drive cuts off remaining frames', async () => {
    const control = new FileAudioSource(validWavPath, { realtime: true })
    const controlFrames: AudioFrame[] = []
    control.on('audio', (f) => controlFrames.push(f))
    await control.start()
    await vi.advanceTimersByTimeAsync(FRAME_COUNT * FRAME_MS)
    await control.stop()

    const subject = new FileAudioSource(validWavPath, { realtime: true })
    const subjectFrames: AudioFrame[] = []
    subject.on('audio', (f) => subjectFrames.push(f))
    await subject.start() // frame 0 emitted synchronously
    await subject.stop() // must cut off before the next scheduled setTimeout fires
    await vi.advanceTimersByTimeAsync(FRAME_COUNT * FRAME_MS)

    expect(subjectFrames.length).toBeLessThan(controlFrames.length)
  })
})
