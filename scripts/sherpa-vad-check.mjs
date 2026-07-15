// Decisive oracle: run the SAME silero model through sherpa-onnx-node's Vad.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const buf = readFileSync(process.argv[2] ?? '/tmp/say.wav')
let ds = 12, dl = 0, off = 12
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4)
  const size = buf.readUInt32LE(off + 4)
  if (id === 'data') { ds = off + 8; dl = size; break }
  off += 8 + size + (size % 2)
}
const n = Math.min(dl, buf.length - ds) >> 1
const samples = new Float32Array(n)
for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(ds + i * 2) / 32768

const vad = new sherpa.Vad(
  {
    sileroVad: {
      model: join(homedir(), 'models', 'silero_vad.onnx'),
      threshold: 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.1,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
  30,
)

const WIN = 512
let segments = 0
for (let o = 0; o + WIN <= n; o += WIN) {
  vad.acceptWaveform(new Float32Array(samples.subarray(o, o + WIN)))
  while (!vad.isEmpty()) {
    const seg = vad.front()
    segments++
    console.log(`segment ${segments}: start≈${(seg.start / 16000).toFixed(2)}s len≈${(seg.samples.length / 16000).toFixed(2)}s`)
    vad.pop()
  }
}
console.log(segments > 0 ? `\n✅ sherpa Vad detected ${segments} speech segment(s) — MODEL IS GOOD` : '\n❌ sherpa Vad found no speech either — model/file problem')
