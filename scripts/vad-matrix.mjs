// Probe Silero VAD call variants to find why probs stay ~0.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ort = require('onnxruntime-node')

const buf = readFileSync(process.argv[2] ?? '/tmp/say.wav')
let ds = 12,
  dl = 0,
  off = 12
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4)
  const size = buf.readUInt32LE(off + 4)
  if (id === 'data') {
    ds = off + 8
    dl = size
    break
  }
  off += 8 + size + (size % 2)
}
const n = Math.min(dl, buf.length - ds) >> 1
const base = new Float32Array(n)
for (let i = 0; i < n; i++) base[i] = buf.readInt16LE(ds + i * 2) / 32768

const session = await ort.InferenceSession.create(join(homedir(), 'models', 'silero_vad.onnx'))

async function run(amp, srDims) {
  let state = new Float32Array(256)
  const sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), srDims)
  let maxP = 0
  for (let o = 0; o + 512 <= n; o += 512) {
    const f = new Float32Array(512)
    for (let i = 0; i < 512; i++) f[i] = Math.max(-1, Math.min(1, base[o + i] * amp))
    const input = new ort.Tensor('float32', f, [1, 512])
    const st = new ort.Tensor('float32', state, [2, 1, 128])
    let out
    try {
      out = await session.run({ input, state: st, sr })
    } catch (e) {
      return `ERROR: ${e.message}`
    }
    const [pn, sn] = session.outputNames
    const p = out[pn].data[0]
    state = out[sn].data
    if (p > maxP) maxP = p
  }
  return maxP.toFixed(3)
}

for (const srDims of [[1], []]) {
  for (const amp of [1, 4, 16]) {
    console.log(`srDims=[${srDims}] amp=${amp}  ->  maxProb=${await run(amp, srDims)}`)
  }
}
