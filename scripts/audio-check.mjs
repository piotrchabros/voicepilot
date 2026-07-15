// Use sherpa's own readWave (no hand-rolled parser). Feed the SAME audio to both
// the STT (zipformer) and the VAD. If STT transcribes but VAD doesn't fire, the
// VAD model is the problem; if both fail, the audio is the problem.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const M = join(homedir(), 'models')

const wave = sherpa.readWave(process.argv[2] ?? '/tmp/say.wav')
const samples = wave.samples
console.log(
  `readWave: ${samples.length} samples @ ${wave.sampleRate}Hz  mean|amp|=${(samples.reduce((a, b) => a + Math.abs(b), 0) / samples.length).toFixed(4)}`
)

// --- STT ---
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
const stream = rec.createStream()
stream.acceptWaveform({ samples, sampleRate: wave.sampleRate })
while (rec.isReady(stream)) rec.decode(stream)
console.log(`STT transcript: "${rec.getResult(stream).text}"`)

// --- VAD ---
const vad = new sherpa.Vad(
  {
    sileroVad: {
      model: join(M, 'silero_vad.onnx'),
      threshold: 0.5,
      minSilenceDuration: 0.25,
      minSpeechDuration: 0.1,
      windowSize: 512
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu'
  },
  30
)
let segs = 0
for (let o = 0; o + 512 <= samples.length; o += 512) {
  vad.acceptWaveform(new Float32Array(samples.subarray(o, o + 512)))
  while (!vad.isEmpty()) {
    segs++
    vad.pop()
  }
}
console.log(`VAD segments: ${segs}`)
