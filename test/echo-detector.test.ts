import { describe, expect, it } from 'vitest'
import { EchoDetector } from '../src/pipeline/echo-detector'

// spec.md §5.4: mic x loopback correlation warns when the rep is not on a
// headset (their voice leaks from mic into the loopback/prospect channel).
// These synthetic-energy tests never touch real audio — they drive the
// per-frame energy envelope directly so the correlation math is pinned
// without an audio fixture.

const FRAME_SAMPLES = 512

/** A frame whose mean-squared energy is exactly `level`. */
function frameOfEnergy(level: number): Float32Array {
  const frame = new Float32Array(FRAME_SAMPLES)
  const amp = Math.sqrt(level)
  frame.fill(amp)
  return frame
}

/** Deterministic pseudo-random generator (LCG) — no shared seed pattern with its pair, no flakiness. */
function makeNoise(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return (s % 1000) / 1000
  }
}

describe('EchoDetector (mic x loopback correlation)', () => {
  it('flags suspected=true when both legs carry the same energy envelope (echo leak)', () => {
    const detector = new EchoDetector()
    // Same envelope on both legs (an on/off speech pattern repeated) — this is
    // exactly what an unheadsetted rep's leaking voice looks like on both legs.
    // Long enough to clear warm-up plus CONSECUTIVE_REQUIRED periodic checks.
    let last = { suspected: false, correlation: 0 }
    for (let i = 0; i < 90; i++) {
      const level = i % 4 < 2 ? 0.8 : 0.05
      detector.accept('rep', frameOfEnergy(level))
      last = detector.accept('prospect', frameOfEnergy(level))
    }

    expect(last.suspected).toBe(true)
    expect(last.correlation).toBeGreaterThan(0.6)
  })

  it('does not flag independent, uncorrelated energy on each leg', () => {
    const detector = new EchoDetector()
    const noiseA = makeNoise(12345)
    const noiseB = makeNoise(98765)

    let last = { suspected: false, correlation: 0 }
    for (let i = 0; i < 200; i++) {
      detector.accept('rep', frameOfEnergy(noiseA()))
      last = detector.accept('prospect', frameOfEnergy(noiseB()))
    }

    expect(last.suspected).toBe(false)
  })

  it('does not flag when one leg is entirely silent', () => {
    const detector = new EchoDetector()

    let last = { suspected: false, correlation: 0 }
    for (let i = 0; i < 90; i++) {
      const level = i % 4 < 2 ? 0.8 : 0.05
      detector.accept('rep', frameOfEnergy(level))
      last = detector.accept('prospect', frameOfEnergy(0)) // silent loopback leg
    }

    expect(last.suspected).toBe(false)
  })

  it('does not flag on a single correlated spike (hysteresis)', () => {
    const detector = new EchoDetector()
    // Warm both legs with independent noise so real history exists, then
    // inject only a short correlated burst — far shorter than what
    // CONSECUTIVE_REQUIRED periodic checks would need — before returning to
    // independent noise.
    const noiseA = makeNoise(555)
    const noiseB = makeNoise(777)

    for (let i = 0; i < 25; i++) {
      detector.accept('rep', frameOfEnergy(noiseA()))
      detector.accept('prospect', frameOfEnergy(noiseB()))
    }

    // Short correlated burst: 2 frames, nowhere near enough to accumulate
    // CONSECUTIVE_REQUIRED periodic high-correlation checks.
    let last = { suspected: false, correlation: 0 }
    for (const level of [0.9, 0.1]) {
      detector.accept('rep', frameOfEnergy(level))
      last = detector.accept('prospect', frameOfEnergy(level))
    }
    expect(last.suspected).toBe(false)

    // Return to independent noise — should stay unsuspected.
    for (let i = 0; i < 40; i++) {
      detector.accept('rep', frameOfEnergy(noiseA()))
      last = detector.accept('prospect', frameOfEnergy(noiseB()))
    }
    expect(last.suspected).toBe(false)
  })
})
