// Types shared across the three process boundaries:
//   swift sidecar --stdout--> main --> utilityProcess (pipeline) --> main --> renderer
//
// Keep this the single source of truth for the wire shapes. The sidecar protocol
// (fixed 2049-byte records) is decoded in main; everything past that point is
// structured messages defined here.

/** Which capture leg a frame came from. The leg split IS the diarization. */
export const LEG_MIC = 0x00 // ME   — the user's microphone
export const LEG_SYSTEM = 0x01 // THEM — the far end (system audio)
export type Leg = typeof LEG_MIC | typeof LEG_SYSTEM

export type Speaker = 'ME' | 'THEM'

export function speakerOf(leg: Leg): Speaker {
  return leg === LEG_MIC ? 'ME' : 'THEM'
}

/** Silero v5 window. 512 samples @ 16kHz = 32ms. Not configurable — it is the model's window. */
export const FRAME_SAMPLES = 512
export const TARGET_RATE = 16_000
export const FRAME_MS = (FRAME_SAMPLES * 1000) / TARGET_RATE // 32

/** Each sidecar record: 1 leg byte + 512 Float32 LE. */
export const RECORD_BYTES = 1 + FRAME_SAMPLES * 4 // 2049

export type HintSource = 'RETRIEVED' | 'GENERATED'

export interface Hint {
  readonly text: string
  readonly source: HintSource
}

// ---- main <-> pipeline (utilityProcess) --------------------------------------

/** main -> pipeline: one 16kHz mono frame. `samples` ArrayBuffer is transferred. */
export interface FrameMsg {
  readonly type: 'frame'
  readonly leg: Leg
  readonly samples: ArrayBuffer // 512 Float32 LE
}

/** main -> pipeline: one-time init with all paths and prompt context. */
export interface InitMsg {
  readonly type: 'init'
  readonly sileroPath: string
  readonly zipformerDir: string
  /** Soniox API key. When set, the cloud Soniox engine replaces local zipformer. */
  readonly sonioxApiKey: string | null
  readonly sonioxLanguageHints: readonly string[]
  readonly llamaBase: string
  readonly systemPrompt: string
  readonly staticContext: string
  readonly playbookTsv: string
  readonly maxTurns: number
  readonly bench: boolean
}

/** main -> pipeline: lifecycle. */
export interface ControlMsg {
  readonly type: 'control'
  readonly action: 'shutdown'
}

export type ToPipeline = InitMsg | FrameMsg | ControlMsg

/** pipeline -> main: a hint to paint. */
export interface HintMsg {
  readonly type: 'hint'
  readonly hint: Hint
}

/** pipeline -> main: a stage-boundary timestamp sample for the bench harness. */
export interface MetricMsg {
  readonly type: 'metric'
  readonly stage: BenchStage
  readonly ms: number // high-res ms relative to frame_in
}

/** pipeline -> main: structured log line (kept off stdout to protect the sidecar stream). */
export interface LogMsg {
  readonly type: 'log'
  readonly level: 'info' | 'warn' | 'error'
  readonly msg: string
}

/** pipeline -> main: pipeline is ready (models + llama warm). */
export interface ReadyMsg {
  readonly type: 'ready'
}

export type FromPipeline = HintMsg | MetricMsg | LogMsg | ReadyMsg

// ---- renderer API (exposed via preload contextBridge) ------------------------

export interface CopilotBridge {
  onHint(cb: (hint: Hint) => void): () => void
  /** Renderer -> main: subscription is live, safe to send hints now. */
  ready(): void
}

// ---- bench -------------------------------------------------------------------

export type BenchStage =
  | 'frame_in'
  | 'vad_out'
  | 'stt_interim'
  | 'speculate_fired'
  | 'first_token'
  | 'painted'
