// Minimal ambient types for the subset of onnxruntime-node this project uses.
// The installed package's `types` entry points at a .d.ts that isn't shipped, so
// declare only what vad.ts touches: InferenceSession.create/run and Tensor.
declare module 'onnxruntime-node' {
  export type TensorData = Float32Array | BigInt64Array

  export class Tensor {
    constructor(type: 'float32', data: Float32Array, dims: readonly number[])
    constructor(type: 'int64', data: BigInt64Array, dims: readonly number[])
    readonly data: TensorData
    readonly dims: readonly number[]
    readonly type: string
  }

  export interface SessionOptions {
    intraOpNumThreads?: number
    interOpNumThreads?: number
  }

  export type FeedsAndFetches = Record<string, Tensor>

  export class InferenceSession {
    static create(path: string, options?: SessionOptions): Promise<InferenceSession>
    run(feeds: Record<string, Tensor>): Promise<FeedsAndFetches>
    readonly inputNames: readonly string[]
    readonly outputNames: readonly string[]
  }
}
