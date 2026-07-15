import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const M = join(homedir(), 'models')

const wave = sherpa.readWave(process.argv[2] ?? '/tmp/say.wav')
let peak = 0
for (const s of wave.samples) peak = Math.max(peak, Math.abs(s))
console.log(
  `samples=${wave.samples.length} sr=${wave.sampleRate} peak=${peak.toFixed(3)} mean|amp|=${(wave.samples.reduce((a, b) => a + Math.abs(b), 0) / wave.samples.length).toFixed(4)}`
)

function stt(samples) {
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(M, 'zipformer-streaming/encoder.onnx'),
        decoder: join(M, 'zipformer-streaming/decoder.onnx'),
        joiner: join(M, 'zipformer-streaming/joiner.onnx')
      },
      tokens: join(M, 'zipformer-streaming/tokens.txt'),
      numThreads: 2,
      provider: 'cpu'
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: false
  })
  const s = rec.createStream()
  s.acceptWaveform({ samples, sampleRate: 16000 })
  // tail padding so the streaming model flushes
  s.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 })
  s.inputFinished()
  while (rec.isReady(s)) rec.decode(s)
  return rec.getResult(s).text
}

for (const amp of [1, 3, 8]) {
  const amped = Float32Array.from(wave.samples, (x) => Math.max(-1, Math.min(1, x * amp)))
  console.log(`amp=${amp}: STT="${stt(amped)}"`)
}
