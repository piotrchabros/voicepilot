// Feed a known 16k mono PCM16 wav through Silero VAD exactly as vad.ts does,
// and report the max probability. Isolates VAD inference from live capture.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ort = require('onnxruntime-node')

const wavPath = process.argv[2] ?? '/tmp/say.wav'
const buf = readFileSync(wavPath)

// Minimal PCM16 mono WAV -> Float32
let dataStart = 12
let dataLen = 0
let off = 12
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4)
  const size = buf.readUInt32LE(off + 4)
  if (id === 'data') {
    dataStart = off + 8
    dataLen = size
    break
  }
  off += 8 + size + (size % 2)
}
const n = Math.min(dataLen, buf.length - dataStart) >> 1
const samples = new Float32Array(n)
for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(dataStart + i * 2) / 32768
console.log(`loaded ${wavPath}: ${n} samples, mean|amp|=${(samples.reduce((a, b) => a + Math.abs(b), 0) / n).toFixed(4)}`)

const session = await ort.InferenceSession.create(join(homedir(), 'models', 'silero_vad.onnx'), {
  intraOpNumThreads: 1,
})
console.log('outputs:', session.outputNames)

let state = new Float32Array(2 * 1 * 128)
const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [1])
let maxProb = 0
let framesOverHalf = 0
const probs = []

for (let o = 0; o + 512 <= n; o += 512) {
  const frame = samples.subarray(o, o + 512)
  const input = new ort.Tensor('float32', Float32Array.from(frame), [1, 512])
  const st = new ort.Tensor('float32', state, [2, 1, 128])
  const out = await session.run({ input, state: st, sr })
  const [probName, stateName] = session.outputNames
  const p = out[probName].data[0]
  state = out[stateName].data
  probs.push(p)
  if (p > maxProb) maxProb = p
  if (p >= 0.5) framesOverHalf++
}

console.log(`frames=${probs.length} maxProb=${maxProb.toFixed(3)} framesOver0.5=${framesOverHalf}`)
console.log('first 20 probs:', probs.slice(0, 20).map((p) => p.toFixed(2)).join(' '))
console.log(maxProb >= 0.5 ? '\n✅ VAD DETECTS SPEECH — inference path works' : '\n❌ VAD never crosses 0.5 — VAD inference is broken')
