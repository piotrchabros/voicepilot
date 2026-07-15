// `AudioSource` implementation that replays a wav file (spec.md §2). Wraps
// the existing `wav.ts` reader/resampler/framer and emits `AudioFrame`s at a
// natural cadence, so downstream pipeline code (VAD/STT debounce, llama slot
// timing) behaves the way it would against a live transport.
//
// Two drive modes:
//  - `realtime: true` (default): frames are paced with `setTimeout` at the
//    frame's natural duration (`FRAME_MS`, ~32ms @16kHz/512 samples) — used
//    by `--bench` so per-stage timing measurements reflect real cadence.
//  - `realtime: false`: frames are emitted back-to-back (yielding a
//    microtask between each, so `stop()` can still race an in-flight drive)
//    — used by tests, which don't want to wait out real wall-clock time.

import { existsSync, readFileSync } from 'node:fs'
import type { AudioFrame, AudioSource, Separation, SpeakerRole } from '@shared/audio-source'
import { FRAME_MS } from '@shared/types'
import { parseWav, toFrames, toMono16k } from './wav'

type HealthStatus = { ok: boolean; detail: string }
type AudioHandler = (frame: AudioFrame) => void
type EndHandler = (reason: string) => void
type HealthHandler = (status: HealthStatus) => void

export interface FileAudioSourceOptions {
  /** Which speaker this file represents. Default: `'prospect'`. */
  speaker?: SpeakerRole
  /**
   * Pace frame delivery at the file's natural cadence via `setTimeout`.
   * Default: `true`. Set `false` to drive frames as fast as the event loop
   * allows (test-only — still yields a microtask per frame so `stop()` can
   * race an in-flight drive, per the `AudioSource` contract).
   */
  realtime?: boolean
}

/** Wraps `wav.ts` to satisfy the `AudioSource` seam (spec.md §2). */
export class FileAudioSource implements AudioSource {
  readonly transport = 'file' as const
  readonly speakers: readonly SpeakerRole[]
  readonly separation: Separation = 'clean'

  private readonly wavPath: string
  private readonly realtime: boolean
  private readonly audioHandlers: AudioHandler[] = []
  private readonly endHandlers: EndHandler[] = []
  private readonly healthHandlers: HealthHandler[] = []
  private stopped = false
  private ended = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(wavPath: string, opts?: FileAudioSourceOptions) {
    this.wavPath = wavPath
    this.speakers = [opts?.speaker ?? 'prospect']
    this.realtime = opts?.realtime ?? true
  }

  async start(): Promise<void> {
    if (!existsSync(this.wavPath)) {
      this.reportHealth({ ok: false, detail: `wav file not found: ${this.wavPath}` })
      this.emitEnd('missing-file')
      return
    }

    let frames: Float32Array[]
    try {
      const mono = toMono16k(parseWav(readFileSync(this.wavPath)))
      frames = toFrames(mono)
    } catch (err) {
      this.reportHealth({
        ok: false,
        detail: `failed to read wav ${this.wavPath}: ${(err as Error).message}`
      })
      this.emitEnd('read-error')
      return
    }

    if (this.realtime) {
      this.driveRealtime(frames)
    } else {
      this.driveImmediate(frames)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
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

  /**
   * Reports a health status to registered handlers. The real trigger path is
   * internal (a failed wav read during `start()`), but this is exposed
   * publicly so it is a genuine, callable part of the seam rather than a
   * private implementation detail — e.g. a test harness can drive a second,
   * intentionally-broken `FileAudioSource` and forward its real `health`
   * event here to exercise the contract on the instance under test.
   */
  reportHealth(status: HealthStatus): void {
    for (const h of this.healthHandlers) h(status)
  }

  /** Emits frames back-to-back, yielding a microtask between each so a
   *  racing `stop()` can still cut the drive short (contract test (g)). */
  private driveImmediate(frames: Float32Array[]): void {
    void (async () => {
      for (let i = 0; i < frames.length; i++) {
        if (this.stopped) return
        await Promise.resolve()
        if (this.stopped) return
        this.emitFrame(frames[i]!, i)
      }
      this.emitEnd('drained')
    })()
  }

  /** Emits frames at the file's natural cadence (`FRAME_MS` apart). */
  private driveRealtime(frames: Float32Array[]): void {
    const step = (i: number): void => {
      if (this.stopped) return
      if (i >= frames.length) {
        this.emitEnd('drained')
        return
      }
      this.emitFrame(frames[i]!, i)
      this.timer = setTimeout(() => step(i + 1), FRAME_MS)
    }
    step(0)
  }

  private emitFrame(pcm: Float32Array, index: number): void {
    const frame: AudioFrame = { speaker: this.speakers[0]!, pcm, t: index * FRAME_MS }
    for (const h of this.audioHandlers) h(frame)
  }

  private emitEnd(reason: string): void {
    if (this.ended) return
    this.ended = true
    for (const h of this.endHandlers) h(reason)
  }
}
