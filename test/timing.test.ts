import { describe, expect, it } from 'vitest'
import type { VadEvent } from '../src/pipeline/vad'
import { shouldBeginTurn, StageClock, stageDeltas } from '../src/pipeline/timing'

/** Fake monotonic clock: each call returns the next queued value. */
function fakeClock(...ticks: number[]): () => number {
  const q = [...ticks]
  return () => {
    const next = q.shift()
    if (next === undefined) throw new Error('fakeClock exhausted')
    return next
  }
}

describe('StageClock (pure, DI clock)', () => {
  it('snapshot() is null before any turn begins', () => {
    const clock = new StageClock(fakeClock(0))
    expect(clock.snapshot()).toBeNull()
  })

  it('beginTurn tags the transport and seeds frame_in at 0', () => {
    const clock = new StageClock(fakeClock(100))
    clock.beginTurn('system')
    const snap = clock.snapshot()
    expect(snap).toEqual({ transport: 'system', stages: { frame_in: 0 } })
  })

  it('mark() records elapsed ms relative to the beginTurn baseline', () => {
    // 100 = beginTurn, 108 = vad_out, 140 = stt_interim
    const clock = new StageClock(fakeClock(100, 108, 140))
    clock.beginTurn('file')
    clock.mark('vad_out')
    clock.mark('stt_interim')
    expect(clock.snapshot()).toEqual({
      transport: 'file',
      stages: { frame_in: 0, vad_out: 8, stt_interim: 40 }
    })
  })

  it('mark() before any beginTurn is a no-op (no crash, no stage recorded)', () => {
    const clock = new StageClock(fakeClock(0))
    clock.mark('vad_out')
    expect(clock.snapshot()).toBeNull()
  })

  it('a second beginTurn resets the stage map (new turn, new baseline)', () => {
    const clock = new StageClock(fakeClock(100, 150, 500))
    clock.beginTurn('system')
    clock.mark('vad_out')
    clock.beginTurn('twilio')
    expect(clock.snapshot()).toEqual({ transport: 'twilio', stages: { frame_in: 0 } })
  })
})

describe('stageDeltas (pure aggregation helper)', () => {
  it('derives consecutive stage-to-stage deltas from a snapshot', () => {
    const deltas = stageDeltas({
      transport: 'system',
      stages: {
        frame_in: 0,
        vad_out: 5,
        stt_interim: 30,
        speculate_fired: 230,
        first_token: 280,
        painted: 285
      }
    })
    expect(deltas).toEqual([
      { label: 'frame_in->vad_out', transport: 'system', ms: 5 },
      { label: 'vad_out->stt_interim', transport: 'system', ms: 25 },
      { label: 'stt_interim->speculate_fired', transport: 'system', ms: 200 },
      { label: 'speculate_fired->first_token', transport: 'system', ms: 50 },
      { label: 'first_token->painted', transport: 'system', ms: 5 }
    ])
  })

  it('skips a pair when either endpoint stage is missing', () => {
    const deltas = stageDeltas({
      transport: 'file',
      stages: { frame_in: 0, vad_out: 5, stt_interim: 30 }
    })
    expect(deltas).toEqual([
      { label: 'frame_in->vad_out', transport: 'file', ms: 5 },
      { label: 'vad_out->stt_interim', transport: 'file', ms: 25 }
    ])
  })

  it('returns an empty array for a bare frame_in-only snapshot', () => {
    expect(stageDeltas({ transport: 'twilio', stages: { frame_in: 0 } })).toEqual([])
  })
})

describe('shouldBeginTurn (pure gate: only SPEECH_START resets the baseline)', () => {
  it('is true only for SPEECH_START, false for every other VAD event', () => {
    expect(shouldBeginTurn('SPEECH_START')).toBe(true)
    expect(shouldBeginTurn('SPEECH')).toBe(false)
    expect(shouldBeginTurn('SILENCE')).toBe(false)
    expect(shouldBeginTurn('TURN_END')).toBe(false)
  })
})

describe('frame-loop gating regression (Task 3.3 reviewer finding, critical)', () => {
  // Reproduces the exact bug: calling clock.beginTurn() unconditionally on
  // every frame (instead of gating on shouldBeginTurn(ev)) wipes the
  // baseline between when stt_interim is marked and when the debounced
  // speculate_fired/first_token eventually land — misattributing them to
  // whatever later frame happened to arrive in between. Both
  // pipeline/index.ts and bench.ts now share this exact loop shape:
  //   if (shouldBeginTurn(ev)) clock.beginTurn(transport)
  //   clock.mark('vad_out'); ... clock.mark('stt_interim')
  // and speculate_fired/first_token/painted are marked later, out-of-band,
  // by code that doesn't call beginTurn at all (HintEngine / bench's sink).
  function driveFrameLoop(clock: StageClock, events: readonly VadEvent[]): void {
    for (const ev of events) {
      if (shouldBeginTurn(ev)) clock.beginTurn('system')
      clock.mark('vad_out')
      if (ev === 'SPEECH_START' || ev === 'SPEECH') clock.mark('stt_interim')
    }
  }

  it('an intervening SPEECH frame between stt_interim and the debounced speculate_fired does NOT reset frame_in', () => {
    // ticks: SPEECH_START(0) -> vad_out -> stt_interim,
    //        SPEECH(32)       -> vad_out -> stt_interim  (this must NOT reset the baseline),
    //        ... 200ms debounce elapses ...
    //        speculate_fired marked at t=232, first_token at t=282 — both
    //        must stay relative to the ORIGINAL t=0 baseline, not t=32.
    const clock = new StageClock(fakeClock(0, 2, 5, 32, 34, 232, 282))
    driveFrameLoop(clock, ['SPEECH_START', 'SPEECH'])
    clock.mark('speculate_fired')
    clock.mark('first_token')

    const snap = clock.snapshot()
    expect(snap?.transport).toBe('system')
    expect(snap?.stages.frame_in).toBe(0)
    // If beginTurn had incorrectly re-fired on the second SPEECH frame (bug),
    // speculate_fired would be ~200ms (relative to t=32), not ~232ms.
    expect(snap?.stages.speculate_fired).toBe(232)
    expect(snap?.stages.first_token).toBe(282)
  })

  it('SILENCE frames never reset the baseline mid-turn', () => {
    // 0 = beginTurn (SPEECH_START), 1 = vad_out, 50 = stt_interim,
    // 300 = vad_out on the SILENCE frame (no stt_interim, no beginTurn),
    // 400 = speculate_fired, still relative to the original t=0 baseline.
    const clock = new StageClock(fakeClock(0, 1, 50, 300, 400))
    driveFrameLoop(clock, ['SPEECH_START', 'SILENCE'])
    clock.mark('speculate_fired')
    const snap = clock.snapshot()
    expect(snap?.stages.frame_in).toBe(0)
    expect(snap?.stages.speculate_fired).toBe(400)
  })

  it('a genuinely new turn (next SPEECH_START) does reset the baseline', () => {
    // First turn: beginTurn@1000, vad_out@1001, stt_interim@1050.
    // Second turn (new SPEECH_START): beginTurn@5000 (fresh baseline),
    // vad_out@5001 -> delta 1, stt_interim@5060.
    const clock = new StageClock(fakeClock(1000, 1001, 1050, 5000, 5001, 5060))
    driveFrameLoop(clock, ['SPEECH_START'])
    // New turn entirely — this SHOULD reset.
    driveFrameLoop(clock, ['SPEECH_START'])
    const snap = clock.snapshot()
    expect(snap?.stages.frame_in).toBe(0)
    expect(snap?.stages.vad_out).toBe(1)
  })
})
