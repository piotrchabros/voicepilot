import { InferenceSession, Tensor } from 'onnxruntime-node'
import { FRAME_MS, FRAME_SAMPLES } from '@shared/types'

/**
 * Silero VAD v5 on ONNX Runtime. ~1ms per 32ms frame on one CPU core. Port of
 * SileroVad.java.
 *
 * Model: https://github.com/snakers4/silero-vad -> silero_vad.onnx (v5).
 *
 * v5 signature (v4 differs — separate h/c inputs, so don't mix them up):
 *   in : input (1,512) float, state (2,1,128) float, sr (1,) int64
 *   out: output (1,1) float, stateN (2,1,128) float
 */
export type VadEvent = 'SILENCE' | 'SPEECH_START' | 'SPEECH' | 'TURN_END'

// Hysteresis. Speech is easy to enter, hard to leave — clipping the tail of a
// word costs you more than a few frames of trailing silence.
const ENTER = 0.5
const EXIT = 0.35

/**
 * How long silence must persist before we call the turn over. This single number
 * DOMINATES the whole latency budget — it is added, in full, to every hint. Keep
 * it exposed and obvious; do not bury it in a config object.
 */
export const HANGOVER_MS = 250
const HANGOVER_FRAMES = Math.floor(HANGOVER_MS / FRAME_MS) // 7

const STATE_LEN = 2 * 1 * 128

export class SileroVad {
  private readonly session: InferenceSession
  private state: Float32Array = new Float32Array(STATE_LEN)
  private readonly sr = new Tensor('int64', BigInt64Array.from([16000n]), [1])

  private speaking = false
  private silentFrames = 0

  /** Last speech probability — exposed for debug/level diagnostics. */
  lastProb = 0

  private constructor(session: InferenceSession) {
    this.session = session
  }

  static async create(modelPath: string): Promise<SileroVad> {
    const session = await InferenceSession.create(modelPath, {
      intraOpNumThreads: 1, // it's tiny; more threads is pure overhead
      interOpNumThreads: 1
    })
    return new SileroVad(session)
  }

  /** Construct without a model — for unit-testing the pure step() state machine. */
  static headless(): SileroVad {
    return new SileroVad(null as unknown as InferenceSession)
  }

  /** @param frame 512 samples of 16kHz mono float PCM */
  async accept(frame: Float32Array): Promise<VadEvent> {
    return this.step(await this.probability(frame))
  }

  /**
   * Pure hysteresis + hangover state machine, split out from ONNX inference so it
   * is testable without the model. Given a speech probability, advance state and
   * return the event. Same logic as SileroVad.java.
   */
  step(p: number): VadEvent {
    if (!this.speaking) {
      if (p >= ENTER) {
        this.speaking = true
        this.silentFrames = 0
        return 'SPEECH_START'
      }
      return 'SILENCE'
    }

    if (p >= EXIT) {
      this.silentFrames = 0
      return 'SPEECH'
    }

    if (++this.silentFrames >= HANGOVER_FRAMES) {
      this.speaking = false
      this.silentFrames = 0
      return 'TURN_END'
    }
    return 'SPEECH'
  }

  private async probability(frame: Float32Array): Promise<number> {
    if (frame.length !== FRAME_SAMPLES) {
      throw new Error(`VAD expects ${FRAME_SAMPLES}-sample frames, got ${frame.length}`)
    }
    const input = new Tensor('float32', frame, [1, FRAME_SAMPLES])
    const state = new Tensor('float32', this.state, [2, 1, 128])

    const out = await this.session.run({ input, state, sr: this.sr })
    // Access positionally to match the Java code and survive output renames.
    const [probName, stateName] = this.session.outputNames as [string, string]
    const prob = out[probName]!.data as Float32Array
    // Carry recurrent state forward.
    this.state = out[stateName]!.data as Float32Array
    this.lastProb = prob[0]!
    return this.lastProb
  }

  reset(): void {
    this.state = new Float32Array(STATE_LEN)
    this.speaking = false
    this.silentFrames = 0
  }
}
