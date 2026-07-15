// Shared parameterized contract suite for `AudioSource` implementations
// (spec.md §2). Every concrete AudioSource (MemoryAudioSource used here,
// FileAudioSource, the future TwilioAudioSource / SystemAudioSource) must
// satisfy this suite unchanged — that is what makes the seam a seam.
//
// This file is intentionally not named `*.test.ts` so vitest's `test/**/*.test.ts`
// include glob does not try to run it directly; it is imported and invoked by
// the `*.test.ts` files that instantiate a concrete AudioSource.

import { describe, expect, it } from 'vitest'
import type { AudioFrame, AudioSource, SpeakerRole } from '@shared/audio-source'

/** What a factory hands back: the source under test, and a way to drive it
 *  through a full audio-emitting lifecycle (frames -> end) for this suite. */
export interface AudioSourceHarness {
  source: AudioSource
  /** Drives the source from first frame through its natural end. */
  drive: () => Promise<void>
  /**
   * Triggers a synthetic `health` event on the source under test.
   *
   * Typed as optional only so a factory signature reads naturally; every real
   * `AudioSource` factory MUST provide this — health reporting is part of the
   * seam contract (spec.md §2's `on('health')` describes a real event, not a
   * stub), so test (f) below treats a missing hook as a contract violation,
   * not a skip.
   */
  triggerHealth?: () => void
}

const VALID_SPEAKERS: ReadonlySet<SpeakerRole> = new Set(['prospect', 'rep'])
const VALID_SEPARATIONS = new Set(['clean', 'mixed'])

export function describeAudioSourceContract(
  name: string,
  factory: () => Promise<AudioSourceHarness>
): void {
  describe(`AudioSource contract: ${name}`, () => {
    it('(a) emits frames shaped correctly: pcm is a finite Float32Array, t is a number', async () => {
      const { source, drive } = await factory()
      const frames: AudioFrame[] = []
      source.on('audio', (f) => frames.push(f))
      await source.start()
      await drive()
      await source.stop()

      expect(frames.length).toBeGreaterThan(0)
      for (const f of frames) {
        expect(f.pcm).toBeInstanceOf(Float32Array)
        for (const sample of f.pcm) {
          expect(Number.isFinite(sample)).toBe(true)
        }
        expect(typeof f.t).toBe('number')
        expect(Number.isFinite(f.t)).toBe(true)
      }
    })

    it('(b) t is monotonic non-decreasing per speaker (spec.md §2: independently sample-count-derived per speaker, not a shared timeline)', async () => {
      const { source, drive } = await factory()
      const frames: AudioFrame[] = []
      source.on('audio', (f) => frames.push(f))
      await source.start()
      await drive()
      await source.stop()

      const lastTBySpeaker = new Map<SpeakerRole, number>()
      for (const f of frames) {
        const last = lastTBySpeaker.get(f.speaker)
        if (last !== undefined) {
          expect(f.t).toBeGreaterThanOrEqual(last)
        }
        lastTBySpeaker.set(f.speaker, f.t)
      }
    })

    it('(c) emits "end" exactly once', async () => {
      const { source, drive } = await factory()
      let endCount = 0
      source.on('end', () => {
        endCount++
      })
      await source.start()
      await drive()
      await source.stop()

      expect(endCount).toBe(1)
    })

    it('(d) emits no audio frames after stop()', async () => {
      const { source, drive } = await factory()
      let stopped = false
      const framesAfterStop: AudioFrame[] = []
      source.on('audio', (f) => {
        if (stopped) framesAfterStop.push(f)
      })
      await source.start()
      await drive()
      await source.stop()
      stopped = true
      // give any wrongly-queued async emission a chance to (incorrectly) fire
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(framesAfterStop).toHaveLength(0)
    })

    it('(e) exposes defined speakers and separation', async () => {
      const { source } = await factory()

      expect(source.speakers.length).toBeGreaterThan(0)
      for (const s of source.speakers) {
        expect(VALID_SPEAKERS.has(s)).toBe(true)
      }
      expect(VALID_SEPARATIONS.has(source.separation)).toBe(true)
    })

    it('(f) emits a well-shaped health status when triggered', async () => {
      const harness = await factory()
      const { source, triggerHealth } = harness

      if (!triggerHealth) {
        // Not a skip: every real AudioSource must expose a health-reporting
        // path (spec.md §2's on('health')). A factory that omits triggerHealth
        // is a contract violation, so this fails loudly instead of quietly
        // passing an assertion-free smoke check.
        throw new Error(
          `AudioSource contract violation (${name}): factory must provide triggerHealth() ` +
            'so this suite can exercise a real health event, not just registration.'
        )
      }

      const statuses: Array<{ ok: boolean; detail: string }> = []
      source.on('health', (s) => statuses.push(s))

      triggerHealth()

      expect(statuses.length).toBeGreaterThan(0)
      for (const s of statuses) {
        expect(typeof s.ok).toBe('boolean')
        expect(typeof s.detail).toBe('string')
      }
    })

    it('(g) stop() racing an in-flight drive() cuts off remaining frames', async () => {
      // Establish the undisturbed frame count via a fresh, fully-driven instance.
      const control = await factory()
      const controlFrames: AudioFrame[] = []
      control.source.on('audio', (f) => controlFrames.push(f))
      await control.source.start()
      await control.drive()
      await control.source.stop()

      // Race stop() against a second, fresh instance's in-flight drive().
      const subject = await factory()
      const subjectFrames: AudioFrame[] = []
      subject.source.on('audio', (f) => subjectFrames.push(f))
      await subject.source.start()
      const drivePromise = subject.drive()
      await subject.source.stop() // must actually cut the drive short
      await drivePromise

      expect(subjectFrames.length).toBeLessThan(controlFrames.length)
    })
  })
}
