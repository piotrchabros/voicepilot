import { OnlineRecognizer, type OnlineStream } from 'sherpa-onnx-node'
import type { SttEngine } from './stt-engine'

/**
 * Streaming Zipformer transducer via sherpa-onnx-node. Truly incremental — emits
 * revised text every frame, no 30s window, no chunk-stitching hacks. Port of
 * SherpaStt.java.
 *
 * Model (multilingual, includes Polish — verify against your own recordings):
 *   https://github.com/k2-fsa/sherpa-onnx/releases -> a streaming zipformer whose
 *   language list covers pl. Needs encoder.onnx, decoder.onnx, joiner.onnx, tokens.txt.
 *
 * NOTE: the Node binding surface moves. If the config keys or method names below
 * stop resolving, check node_modules/sherpa-onnx-node/streaming-asr.js — the
 * concepts (recognizer -> stream -> acceptWaveform -> decode -> getResult) are
 * stable even when the names aren't.
 */
export class SherpaStt implements SttEngine {
  private readonly recognizer: OnlineRecognizer
  private stream: OnlineStream

  constructor(modelDir: string) {
    this.recognizer = new OnlineRecognizer({
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${modelDir}/encoder.onnx`,
          decoder: `${modelDir}/decoder.onnx`,
          joiner: `${modelDir}/joiner.onnx`
        },
        tokens: `${modelDir}/tokens.txt`,
        numThreads: 2,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search',
      // Let Silero own endpointing. Two components racing to decide when the turn
      // ended is a bug you'll spend a week not finding.
      enableEndpoint: false
    })
    this.stream = this.recognizer.createStream()
  }

  accept(frame: Float32Array): void {
    this.stream.acceptWaveform({ samples: frame, sampleRate: 16_000 })
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream)
    }
  }

  interim(): string {
    return this.recognizer.getResult(this.stream).text.trim()
  }

  finish(): Promise<string> {
    const text = this.interim()
    // Reset the stream for the next turn (the Node binding resets in place rather
    // than release + recreate).
    this.recognizer.reset(this.stream)
    return Promise.resolve(text)
  }

  close(): void {
    // The recognizer/stream are freed when they go out of scope; nothing explicit
    // to release in the current Node binding.
  }
}
