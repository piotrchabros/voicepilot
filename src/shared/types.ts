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

/** Which transport produced this suggestion — spec.md §3: "per-stage timestamps
 *  tagged with transport on every suggestion". */
export type SuggestionTransport = 'system' | 'file' | 'twilio'

/** Per-stage latency timestamps for one suggestion, relative to `frame_in`
 *  (matches MetricMsg.ms's existing "relative to frame_in" contract below). */
export interface SuggestionTiming {
  readonly transport: SuggestionTransport
  readonly stages: Partial<Record<BenchStage, number>>
}

export interface Hint {
  readonly text: string
  readonly source: HintSource
  /** Optional: attached when the producer wires a StageClock (pipeline/timing.ts).
   *  Absent means no instrumentation was configured — non-breaking wire shape. */
  readonly timing?: SuggestionTiming
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
  /** Soniox WS endpoint (EU region, spec.md §4.1). Boot-asserted before use. */
  readonly sonioxWsUrl: string
  readonly llamaBase: string
  readonly systemPrompt: string
  readonly staticContext: string
  readonly playbookYaml: string
  readonly maxTurns: number
  readonly bench: boolean
  /** Operator-selected customer-brief basename (spec.md §7, Plans.md Task
   *  6.7): chosen once, pre-Start, on the consent screen — no mid-call
   *  switching. Absent (not empty-string) when "none" was selected, the
   *  default. Content loading (via `loadCustomerBrief`) and injection into
   *  the analysis prompt is the (future) 6.4 AnalysisEngine's job; this
   *  field only carries the selected name through init. */
  readonly customerBrief?: string
  /** `knowledge/**\/*.md` directory (spec.md §7, Plans.md Task 6.1/6.4): the
   *  Phase-6 AnalysisEngine loads it once at init via `KnowledgeBase.load()`.
   *  A missing/empty path yields an empty KB — never a crash. */
  readonly knowledgeDir?: string
  /** `customers/<name>.md` directory (spec.md §7, Plans.md Task 6.1/6.4/6.7),
   *  paired with `customerBrief`'s basename so the AnalysisEngine can load
   *  the selected brief's content via `loadCustomerBrief()`. Only a
   *  filesystem path crosses this boundary — brief content itself is
   *  loaded fresh on the pipeline side, never pre-read into InitMsg. */
  readonly customersDir?: string
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

/** Which failure surface a health event came from. */
export type HealthSource = 'sidecar' | 'soniox' | 'device'

/** main/pipeline -> overlay: a health-affecting event (sidecar exit, device
 *  loss, Soniox disconnect...). `ok:false` means degraded/broken; `ok:true`
 *  means recovered. Previously these only reached the log — this is the wire
 *  shape that lets the renderer show a banner instead (spec.md Task 2.4). */
export interface HealthMsg {
  readonly type: 'health'
  readonly ok: boolean
  readonly source: HealthSource
  readonly detail: string
}

/** Closed set of conversation stages for the Phase-6 analysis side panel
 *  (spec.md §7 "Closed output schema", Plans.md Task 6.4). SSOT here — the
 *  wire shape (AnalysisMsg below) and the pipeline's zod validation
 *  (analysis-engine.ts's `ANALYSIS_STAGES`) both derive from this same set,
 *  so a value outside it is a type error at either end. */
export type AnalysisStage = 'discovery' | 'demo' | 'objection' | 'closing' | 'other'

/** One best-effort analysis result (spec.md §7; Plans.md Task 6.4/6.5) —
 *  closed schema, NO free-form prospect-state field. Must stay
 *  plain-serializable JSON (no class instances, no functions, no `Date`
 *  objects) so it survives today's `utilityProcess.postMessage()`
 *  structured-clone AND a JSON-over-WebSocket bridge in Phase 5.1 unchanged
 *  (spec.md §7, Plans.md Task 6.5). `asOfTurn` stamps the rolling-window turn
 *  count at generation time (a display value, not a global monotonic
 *  counter — see TranscriptState.renderRollingWindow). */
export interface Analysis {
  readonly stage: AnalysisStage
  readonly suggestedQuestions: readonly string[]
  readonly nextSteps?: readonly string[]
  readonly asOfTurn: number
}

/** pipeline -> main: a best-effort analysis result for the (future, Task 6.6)
 *  side panel. Plain-serializable JSON only — see `Analysis` above.
 *  Optional consumer: main may have no `onAnalysis` handler wired yet
 *  (Plans.md Task 6.5) without this ever being an error case. */
export interface AnalysisMsg {
  readonly type: 'analysis'
  readonly analysis: Analysis
}

export type FromPipeline = HintMsg | MetricMsg | LogMsg | ReadyMsg | HealthMsg | AnalysisMsg

/** Transport-B consent state (spec.md §4 item 2 / Plans.md Task 4.1): whether
 *  the operator has affirmed consent for this call yet. Single source of
 *  truth for the literal union — shared by main's `ConsentGate` and
 *  renderer's `consent-view.ts` so neither side can drift from the other. */
export type ConsentState = 'pending' | 'affirmed'

/** main -> renderer: the Transport-B consent announcement to show on screen,
 *  and whether it's the unresolved placeholder (spec.md §4 item 2 / §5,
 *  Plans.md Task 4.1). Sent once per overlay load, alongside `overlay:ready`. */
export interface ConsentRequiredMsg {
  readonly type: 'consent-required'
  readonly announcement: string
  readonly isPlaceholder: boolean
  /** Gate state at send time. The renderer initializes from this rather than
   *  assuming 'pending' — otherwise a reload mid-call (after the operator
   *  already affirmed) would wrongly re-show the prompt and drop the
   *  persistent REC indicator (reviewer note, Plans.md Task 4.1). */
  readonly state: ConsentState
  /** Available `customers/<name>.md` brief basenames for the pre-Start
   *  consent-screen dropdown (spec.md §7, Plans.md Task 6.7). Empty when the
   *  `customers/` dir is missing/empty — the dropdown then shows only
   *  "none", the safe default. */
  readonly customerBriefs: readonly string[]
}

// ---- renderer API (exposed via preload contextBridge) ------------------------

export interface CopilotBridge {
  onHint(cb: (hint: Hint) => void): () => void
  /** Renderer -> main: a health event (sidecar exit / device loss / Soniox
   *  disconnect) to reflect as a banner. */
  onHealth(cb: (health: HealthMsg) => void): () => void
  /** main -> renderer: a best-effort analysis result for the (future, Task
   *  6.6) side panel. Mirrors `onHint` exactly (spec.md §7, Plans.md Task
   *  6.5) — nothing else crosses the bridge for this channel. */
  onAnalysis(cb: (analysis: Analysis) => void): () => void
  /** main -> renderer: the consent announcement script to render, and
   *  whether the operator still needs to affirm before capture can start
   *  (spec.md §4 item 2 / Plans.md Task 4.1). */
  onConsentRequired(cb: (msg: ConsentRequiredMsg) => void): () => void
  /** Renderer -> main: the operator affirms consent for this call, carrying
   *  the pre-Start customer-brief dropdown selection (`null` = "none", the
   *  default). Selected once, at affirm time — no mid-call switching
   *  (spec.md §7, Plans.md Task 6.7). */
  affirmConsent(customerBrief: string | null): void
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
