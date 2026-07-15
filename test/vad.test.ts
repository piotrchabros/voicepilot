import { describe, expect, it } from 'vitest'
import { HANGOVER_MS, SileroVad, type VadEvent } from '../src/pipeline/vad'
import { FRAME_MS } from '../src/shared/types'

// Drives the pure hysteresis + hangover state machine with synthetic
// probabilities — no ONNX model required.
function run(vad: SileroVad, probs: number[]): VadEvent[] {
  return probs.map((p) => vad.step(p))
}

describe('SileroVad hysteresis + hangover', () => {
  it('enters on >=0.5, stays speaking down to 0.35 (hysteresis)', () => {
    const vad = SileroVad.headless()
    expect(vad.step(0.4)).toBe('SILENCE') // below ENTER while idle
    expect(vad.step(0.5)).toBe('SPEECH_START') // ENTER
    expect(vad.step(0.4)).toBe('SPEECH') // 0.4 >= EXIT(0.35) keeps speaking
    expect(vad.step(0.35)).toBe('SPEECH') // exactly EXIT still speaking
  })

  it('fires TURN_END after exactly HANGOVER_FRAMES of sub-EXIT frames', () => {
    const vad = SileroVad.headless()
    vad.step(0.9) // SPEECH_START
    const hangoverFrames = Math.floor(HANGOVER_MS / FRAME_MS) // 7
    const silence = run(
      vad,
      Array.from({ length: hangoverFrames }, () => 0.1)
    )
    // First hangoverFrames-1 are SPEECH, the last is TURN_END.
    expect(silence.slice(0, hangoverFrames - 1).every((e) => e === 'SPEECH')).toBe(true)
    expect(silence[hangoverFrames - 1]).toBe('TURN_END')
  })

  it('a single loud frame mid-hangover resets the silence counter', () => {
    const vad = SileroVad.headless()
    vad.step(0.9) // SPEECH_START
    vad.step(0.1) // silent 1
    vad.step(0.1) // silent 2
    expect(vad.step(0.8)).toBe('SPEECH') // resets counter
    // Now it takes a full hangover again to end the turn.
    const hangoverFrames = Math.floor(HANGOVER_MS / FRAME_MS)
    const tail = run(
      vad,
      Array.from({ length: hangoverFrames }, () => 0.0)
    )
    expect(tail[hangoverFrames - 1]).toBe('TURN_END')
  })

  it('reset() returns to idle', () => {
    const vad = SileroVad.headless()
    vad.step(0.9)
    vad.reset()
    expect(vad.step(0.4)).toBe('SILENCE') // idle again, not SPEECH
  })
})
