// Standalone model-load sanity check (no Electron, no permissions).
// Loads the Silero VAD and the streaming zipformer directly via the native
// addons to confirm the downloaded files are valid.
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const MODELS = join(homedir(), 'models')

let ok = true

// 1. Silero VAD via onnxruntime-node
try {
  const ort = require('onnxruntime-node')
  const s = await ort.InferenceSession.create(join(MODELS, 'silero_vad.onnx'), {
    intraOpNumThreads: 1,
  })
  console.log('✅ silero_vad.onnx loaded; inputs=', s.inputNames, 'outputs=', s.outputNames)
} catch (e) {
  ok = false
  console.error('❌ silero load failed:', e.message)
}

// 2. Streaming zipformer via sherpa-onnx-node
try {
  const sherpa = require('sherpa-onnx-node')
  const dir = join(MODELS, 'zipformer-streaming')
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(dir, 'encoder.onnx'),
        decoder: join(dir, 'decoder.onnx'),
        joiner: join(dir, 'joiner.onnx'),
      },
      tokens: join(dir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: false,
  })
  const stream = rec.createStream()
  // Feed a little silence to make sure the graph runs end to end.
  stream.acceptWaveform({ samples: new Float32Array(1600), sampleRate: 16000 })
  while (rec.isReady(stream)) rec.decode(stream)
  console.log('✅ zipformer loaded + decoded a frame; interim="' + rec.getResult(stream).text + '"')
} catch (e) {
  ok = false
  console.error('❌ zipformer load failed:', e.message)
}

console.log(ok ? '\nALL MODELS OK ✅' : '\nSOME MODELS FAILED ❌')
process.exit(ok ? 0 : 1)
