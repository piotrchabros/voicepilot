import { describe, expect, it } from 'vitest'
import { parseWav, toFrames, toMono16k } from '../src/pipeline/wav'

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
  samples.forEach((s, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32768))), 44 + i * 2))
  return buf
}

describe('wav reader', () => {
  it('parses PCM16 mono 16k and preserves samples', () => {
    const wav = parseWav(makeWavPcm16([0, 0.5, -0.5, 1, -1]))
    expect(wav.sampleRate).toBe(16000)
    expect(wav.channels).toBe(1)
    expect(wav.samples[1]).toBeCloseTo(0.5, 2)
    expect(wav.samples[2]).toBeCloseTo(-0.5, 2)
  })

  it('toMono16k is identity for mono 16k', () => {
    const mono = toMono16k(parseWav(makeWavPcm16([0.1, 0.2, 0.3])))
    expect(Array.from(mono).map((x) => +x.toFixed(2))).toEqual([0.1, 0.2, 0.3])
  })

  it('downmixes stereo and resamples 48k -> ~16k', () => {
    // 6 interleaved stereo samples @48k => 3 frames; resample to 16k => ~1 frame.
    const stereo = makeWavPcm16([0.2, 0.4, 0.2, 0.4, 0.2, 0.4], 48000, 2)
    const mono = toMono16k(parseWav(stereo))
    expect(mono.length).toBe(1) // floor(3 * 16000/48000)
    expect(mono[0]).toBeCloseTo(0.3, 2) // (0.2 + 0.4)/2
  })

  it('toFrames yields 512-sample frames and drops the partial tail', () => {
    const mono = new Float32Array(512 * 2 + 100)
    expect(toFrames(mono)).toHaveLength(2)
  })
})
