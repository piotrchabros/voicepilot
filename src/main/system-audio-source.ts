import type { AudioFrame, AudioSource, Separation, SpeakerRole } from '@shared/audio-source'
import { FRAME_MS, LEG_MIC, LEG_SYSTEM, type Leg } from '@shared/types'
import { Sidecar, type SidecarDeps } from './sidecar'

// Wraps the existing capture sidecar (`./sidecar.ts`) behind the `AudioSource`
// seam (spec.md §2). This adapter owns the leg -> speaker mapping and the
// sample-count-derived timeline; the pipeline downstream of this seam knows
// nothing about legs, PCM records, or the sidecar process.

type AudioHandler = (frame: AudioFrame) => void
type EndHandler = (reason: string) => void
type HealthStatus = { ok: boolean; detail: string }
type HealthHandler = (status: HealthStatus) => void

/** The subset of `Sidecar`'s public surface this adapter depends on — narrow
 *  enough that tests can inject a fake without spawning a real process. */
export interface SidecarLike {
  start(): boolean
  stop(): void
}

/** Builds the sidecar (or a fake standing in for it) from the deps this
 *  adapter wires up. Defaults to the real `Sidecar`; tests override this. */
export type SidecarFactory = (deps: SidecarDeps) => SidecarLike

/** Pure leg -> speaker mapping: mic (0x00) is the rep, system loopback (0x01)
 *  is everyone-but-the-rep (spec.md §2). Extracted so the mapping — and its
 *  round-trip inverse below — can be unit-tested independent of the sidecar
 *  wiring, and reused wherever this seam is translated back to the wire
 *  protocol (e.g. `pipeline-host.ts`). */
export function speakerForLeg(leg: Leg): SpeakerRole {
  return leg === LEG_MIC ? 'rep' : 'prospect'
}

/** Inverse of `speakerForLeg`: speaker -> leg, for code that needs to
 *  translate an `AudioFrame` back into the sidecar/pipeline wire protocol. */
export function legForSpeaker(speaker: SpeakerRole): Leg {
  return speaker === 'rep' ? LEG_MIC : LEG_SYSTEM
}

export interface SystemAudioSourceOptions {
  /** Path to the capture sidecar binary (see `sidecarBinary()` in `./config`). */
  binary: string
  /** Defaults to `(deps) => new Sidecar(deps)`. Inject a fake for tests. */
  sidecarFactory?: SidecarFactory
}

/**
 * `AudioSource` adapter over the Swift capture sidecar. Leg 0x00 (mic) is the
 * rep; leg 0x01 (system loopback) is everyone-but-the-rep, reported as
 * `separation: 'mixed'` per spec.md §2 (diarization deferred, not a silent
 * default). `t` is derived from each leg's own frame counter × 32ms (the
 * Silero window duration) — sample-count derived, never wall-clock.
 */
export class SystemAudioSource implements AudioSource {
  readonly transport = 'system' as const
  readonly speakers: readonly SpeakerRole[] = ['rep', 'prospect']
  readonly separation: Separation = 'mixed'

  private readonly binary: string
  private readonly sidecarFactory: SidecarFactory
  private sidecar: SidecarLike | null = null

  private stopped = false
  private ended = false
  private repFrameCount = 0
  private prospectFrameCount = 0

  private readonly audioHandlers: AudioHandler[] = []
  private readonly endHandlers: EndHandler[] = []
  private readonly healthHandlers: HealthHandler[] = []

  constructor(opts: SystemAudioSourceOptions) {
    this.binary = opts.binary
    this.sidecarFactory = opts.sidecarFactory ?? ((deps) => new Sidecar(deps))
  }

  async start(): Promise<void> {
    const deps: SidecarDeps = {
      binary: this.binary,
      onFrame: (leg, samples) => this.handleFrame(leg, samples),
      onLog: (level, msg, code) => this.handleLog(level, msg, code),
      onExit: () => this.handleExit()
    }
    this.sidecar = this.sidecarFactory(deps)
    this.sidecar.start()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.sidecar?.stop()
    this.emitEnd('stopped')
  }

  on(event: 'audio', handler: AudioHandler): void
  on(event: 'end', handler: EndHandler): void
  on(event: 'health', handler: HealthHandler): void
  on(event: 'audio' | 'end' | 'health', handler: AudioHandler | EndHandler | HealthHandler): void {
    if (event === 'audio') this.audioHandlers.push(handler as AudioHandler)
    else if (event === 'end') this.endHandlers.push(handler as EndHandler)
    else this.healthHandlers.push(handler as HealthHandler)
  }

  private handleFrame(leg: Leg, samples: ArrayBuffer): void {
    if (this.stopped) return
    const speaker: SpeakerRole = speakerForLeg(leg)
    const t = speaker === 'rep' ? this.repFrameCount * FRAME_MS : this.prospectFrameCount * FRAME_MS
    if (speaker === 'rep') this.repFrameCount++
    else this.prospectFrameCount++

    const frame: AudioFrame = { speaker, pcm: new Float32Array(samples), t }
    for (const h of this.audioHandlers) h(frame)
  }

  private handleLog(level: string, msg: string, code?: string): void {
    // Once we've been stopped, a trailing sc-stopped/exit-race log from the
    // sidecar is expected shutdown noise, not a health regression — reporting
    // it as health(ok:false) would be a false alarm after an intentional stop.
    if (this.stopped) return
    if (level !== 'error') return
    const detail = code ? `[${code}] ${msg}` : msg
    for (const h of this.healthHandlers) h({ ok: false, detail })
  }

  private handleExit(): void {
    this.emitEnd('exit')
  }

  private emitEnd(reason: string): void {
    if (this.ended) return
    this.ended = true
    for (const h of this.endHandlers) h(reason)
  }
}
