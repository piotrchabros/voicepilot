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

    it('(b) t is monotonic non-decreasing across frames', async () => {
      const { source, drive } = await factory()
      const frames: AudioFrame[] = []
      source.on('audio', (f) => frames.push(f))
      await source.start()
      await drive()
      await source.stop()

      for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!.t).toBeGreaterThanOrEqual(frames[i - 1]!.t)
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

    it('(f) allows registering a health handler without throwing', async () => {
      const { source } = await factory()

      expect(() => {
        source.on('health', () => {})
      }).not.toThrow()
    })
  })
}
