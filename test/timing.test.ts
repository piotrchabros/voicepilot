import { describe, expect, it } from 'vitest'
import { StageClock, stageDeltas } from '../src/pipeline/timing'

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
