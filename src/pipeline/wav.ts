import { FRAME_SAMPLES, TARGET_RATE } from '@shared/types'

// Minimal WAV reader for the bench harness. Handles PCM16 and IEEE float32,
// mono or stereo, any sample rate — downmixes to mono and linearly resamples to
// 16kHz. Pure (operates on a buffer) so it is unit-testable.

export interface Wav {
  sampleRate: number
  channels: number
  samples: Float32Array // interleaved, native float
}

export function parseWav(buf: Buffer): Wav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let audioFormat = 1
  let channels = 1
  let sampleRate = TARGET_RATE
  let bitsPerSample = 16
  let dataStart = -1
  let dataLen = 0

  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      audioFormat = buf.readUInt16LE(body)
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataStart = body
      dataLen = size
    }
    off = body + size + (size % 2) // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error('no data chunk')

  const end = Math.min(dataStart + dataLen, buf.length)
  const samples = decodeSamples(buf, dataStart, end, audioFormat, bitsPerSample)
  return { sampleRate, channels, samples }
}

function decodeSamples(
  buf: Buffer,
  start: number,
  end: number,
  audioFormat: number,
  bits: number
): Float32Array {
  if (audioFormat === 3 && bits === 32) {
    const n = (end - start) >> 2
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(start + i * 4)
    return out
  }
  if (audioFormat === 1 && bits === 16) {
    const n = (end - start) >> 1
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(start + i * 2) / 32768
    return out
  }
  throw new Error(`unsupported WAV: format=${audioFormat} bits=${bits} (want PCM16 or float32)`)
}

/** Downmix to mono and linearly resample to 16kHz. */
export function toMono16k(wav: Wav): Float32Array {
  const { channels, sampleRate, samples } = wav
  const frames = Math.floor(samples.length / channels)
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < channels; c++) acc += samples[i * channels + c] ?? 0
    mono[i] = acc / channels
  }
  if (sampleRate === TARGET_RATE) return mono

  const ratio = TARGET_RATE / sampleRate
  const outLen = Math.floor(frames * ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, frames - 1)
    const t = src - i0
    out[i] = (mono[i0] ?? 0) * (1 - t) + (mono[i1] ?? 0) * t
  }
  return out
}

/** Split a mono 16k signal into 512-sample frames (drops a trailing partial). */
export function toFrames(mono: Float32Array): Float32Array[] {
  const frames: Float32Array[] = []
  for (let off = 0; off + FRAME_SAMPLES <= mono.length; off += FRAME_SAMPLES) {
    frames.push(mono.subarray(off, off + FRAME_SAMPLES))
  }
  return frames
}
