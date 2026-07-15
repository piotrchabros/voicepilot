import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { streamFrames } from '../src/pipeline/frame-stream'

// Exercises the pure frame-supply wrapper `--bench` now uses, without the
// electron-only pipeline stages (vad/stt/llama-client) that `--bench` also
// drives — see `src/main/bench.ts` and `src/pipeline/frame-stream.ts`.

function makeWavPcm16(samples: number[], sampleRate = 16000, channels = 1): Buffer {
  const dataLen = samples.length * 2
  const buf = Buffer.alloc(44 + dataLen)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
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

const tmpDir = mkdtempSync(join(tmpdir(), 'frame-stream-test-'))
const FRAME_COUNT = 2
const wavPath = join(tmpDir, 'fixture.wav')
writeFileSync(
  wavPath,
  makeWavPcm16(Array.from({ length: 512 * FRAME_COUNT }, (_, i) => Math.sin(i / 20) * 0.5))
)
const missingPath = join(tmpDir, 'missing.wav')

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('streamFrames', () => {
  it('yields all frames in order, non-realtime', async () => {
    const frames = []
    for await (const frame of streamFrames(wavPath, { realtime: false })) {
      frames.push(frame)
    }
    expect(frames).toHaveLength(FRAME_COUNT)
    expect(frames.map((f) => f.t)).toEqual([0, 32])
    for (const f of frames) {
      expect(f.pcm).toBeInstanceOf(Float32Array)
    }
  })

  it('throws when the underlying source reports a health failure', async () => {
    async function drainMissing(): Promise<void> {
      for await (const _frame of streamFrames(missingPath, { realtime: false })) {
        // no-op: fixture has no frames before health failure
      }
    }
    await expect(drainMissing()).rejects.toThrow(/FileAudioSource health failure/)
  })
})
