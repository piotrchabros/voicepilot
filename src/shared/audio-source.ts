// The transport-agnostic seam described in spec.md §2. All audio transports
// (Twilio PSTN, system loopback via Electron, wav file replay) implement this
// interface; `CallSession` (the pipeline) knows nothing about transports.
//
// This is deliberately independent from `./types.ts` (the sidecar/main/pipeline
// wire shapes). Wiring the two together is a later task; this seam only needs
// to hold on its own.
//
// Frame format: Float32 @ 16kHz mono — the existing sidecar/VAD/STT contract.
// Deviation from `realtime-sales-assistant-plan.md`: NOT pcm_s16le at the seam;
// conversion to pcm_s16le happens once, inside the Soniox client, as today.

/** Which side of the conversation a frame belongs to. */
export type SpeakerRole = 'prospect' | 'rep'

/** One frame of audio, tagged by speaker. */
export interface AudioFrame {
  readonly speaker: SpeakerRole
  /** 16kHz mono PCM samples. */
  readonly pcm: Float32Array
  /** ms since capture start; monotonic **per speaker**, source-provided (not
   *  wall-clock). Two speakers' timelines are independently sample-count
   *  derived — comparing `t` across speakers is not meaningful; drift between
   *  them is a real, observable signal, not a bug to paper over. */
  readonly t: number
}

/**
 * `clean`: the transport delivers each speaker on its own leg (e.g. Twilio).
 * `mixed`: the transport delivers everyone-but-the-rep on one leg (e.g. system
 * loopback); diarization is deferred (spec.md §2 — a recorded decision, not a
 * silent default). Downstream consumers raise the Tier-1 confidence threshold
 * when `separation === 'mixed'`.
 */
export type Separation = 'clean' | 'mixed'

/** The seam: everything past this interface is transport-agnostic pipeline code. */
export interface AudioSource {
  readonly transport: 'twilio' | 'system' | 'file'
  readonly speakers: readonly SpeakerRole[]
  readonly separation: Separation

  start(): Promise<void>
  stop(): Promise<void>

  on(event: 'audio', handler: (frame: AudioFrame) => void): void
  on(event: 'end', handler: (reason: string) => void): void
  on(event: 'health', handler: (status: { ok: boolean; detail: string }) => void): void
}
