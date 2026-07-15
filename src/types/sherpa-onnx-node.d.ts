// Minimal ambient types for the subset of sherpa-onnx-node this project uses.
// The package ships no .d.ts; the binding surface moves, so keep this narrow —
// only what stt.ts actually calls. See node_modules/sherpa-onnx-node/*.js.
declare module 'sherpa-onnx-node' {
  export interface TransducerModelConfig {
    encoder: string
    decoder: string
    joiner: string
  }

  export interface OnlineModelConfig {
    transducer: TransducerModelConfig
    tokens: string
    numThreads?: number
    provider?: string
    debug?: number | boolean
    modelType?: string
  }

  export interface FeatureConfig {
    sampleRate?: number
    featureDim?: number
  }

  export interface OnlineRecognizerConfig {
    featConfig?: FeatureConfig
    modelConfig: OnlineModelConfig
    decodingMethod?: string
    enableEndpoint?: boolean | number
  }

  export interface Waveform {
    samples: Float32Array
    sampleRate: number
  }

  export interface OnlineResult {
    text: string
    tokens?: string[]
  }

  export class OnlineStream {
    acceptWaveform(obj: Waveform): void
    inputFinished(): void
  }

  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    isEndpoint(stream: OnlineStream): boolean
    reset(stream: OnlineStream): void
    getResult(stream: OnlineStream): OnlineResult
  }
}
