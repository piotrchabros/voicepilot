import { describe, expect, it } from 'vitest'
import type { SpeakerRole } from '@shared/audio-source'
import { LEG_MIC, LEG_SYSTEM, type Leg } from '@shared/types'
import type { SidecarDeps } from '../src/main/sidecar'
import {
  legForSpeaker,
  speakerForLeg,
  SystemAudioSource,
  type SidecarFactory,
  type SidecarLike
} from '../src/main/system-audio-source'
import { type AudioSourceHarness, describeAudioSourceContract } from './audio-source-contract'

/** Fake sidecar: never spawns a real process. Captures the deps the source
 *  wires up so the test can play back synthetic frames/logs/exit exactly the
 *  way the real `Sidecar` would call them. */
function makeFakeSidecarFactory(): {
  factory: SidecarFactory
  getDeps: () => SidecarDeps
  isStopped: () => boolean
} {
  let capturedDeps: SidecarDeps | null = null
  let stopped = false
  const factory: SidecarFactory = (deps: SidecarDeps): SidecarLike => {
    capturedDeps = deps
    return {
      start: () => true,
      stop: () => {
        stopped = true
      }
    }
  }
  return {
    factory,
    getDeps: () => {
      if (!capturedDeps)
        throw new Error('sidecar factory not invoked yet — call source.start() first')
      return capturedDeps
    },
    isStopped: () => stopped
  }
}

function makeSamples(value: number): ArrayBuffer {
  return new Float32Array(512).fill(value).buffer
}

async function factory(): Promise<AudioSourceHarness & { source: SystemAudioSource }> {
  const { factory: sidecarFactory, getDeps, isStopped } = makeFakeSidecarFactory()
  const source = new SystemAudioSource({ binary: '/fake/sidecar-bin', sidecarFactory })
  await source.start()
  const deps = getDeps()

  return {
    source,
    drive: async () => {
      const legs: Leg[] = [LEG_MIC, LEG_SYSTEM, LEG_MIC, LEG_SYSTEM, LEG_MIC]
      for (const [i, leg] of legs.entries()) {
        if (isStopped()) return
        await Promise.resolve()
        if (isStopped()) return
        deps.onFrame(leg, makeSamples(i * 0.1))
      }
      deps.onExit(0)
    },
    triggerHealth: () => deps.onLog('error', 'microphone permission denied', 'mic-denied')
  }
}

describeAudioSourceContract('system', factory)

describe('SystemAudioSource (adapter-specific behavior)', () => {
  it('reports transport "system", speakers rep+prospect, separation "mixed"', () => {
    const { factory: sidecarFactory } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })

    expect(source.transport).toBe('system')
    expect(source.speakers).toEqual(['rep', 'prospect'])
    expect(source.separation).toBe('mixed')
  })

  it('maps leg 0x00 (mic) -> speaker "rep" and leg 0x01 (system) -> speaker "prospect"', async () => {
    const { factory: sidecarFactory, getDeps } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    const deps = getDeps()

    const frames: Array<{ speaker: string }> = []
    source.on('audio', (f) => frames.push({ speaker: f.speaker }))

    deps.onFrame(LEG_MIC, makeSamples(0.1))
    deps.onFrame(LEG_SYSTEM, makeSamples(0.2))

    expect(frames).toEqual([{ speaker: 'rep' }, { speaker: 'prospect' }])
  })

  it('derives t from a per-speaker, sample-count-based frame counter (32ms per frame), not wall clock', async () => {
    const { factory: sidecarFactory, getDeps } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    const deps = getDeps()

    const frames: Array<{ speaker: string; t: number }> = []
    source.on('audio', (f) => frames.push({ speaker: f.speaker, t: f.t }))

    // Two legs advance independently: mic frame 0, system frame 0, mic frame 1,
    // system frame 1, mic frame 2 — each leg's own counter times 32ms/frame.
    deps.onFrame(LEG_MIC, makeSamples(0))
    deps.onFrame(LEG_SYSTEM, makeSamples(0))
    deps.onFrame(LEG_MIC, makeSamples(0))
    deps.onFrame(LEG_SYSTEM, makeSamples(0))
    deps.onFrame(LEG_MIC, makeSamples(0))

    expect(frames).toEqual([
      { speaker: 'rep', t: 0 },
      { speaker: 'prospect', t: 0 },
      { speaker: 'rep', t: 32 },
      { speaker: 'prospect', t: 32 },
      { speaker: 'rep', t: 64 }
    ])
  })

  it('converts sidecar onLog error codes (sidecar-missing / mic-denied / screen-denied / sc-stopped) into health(ok:false, detail)', async () => {
    const { factory: sidecarFactory, getDeps } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    const deps = getDeps()

    const statuses: Array<{ ok: boolean; detail: string }> = []
    source.on('health', (s) => statuses.push(s))

    deps.onLog('error', 'capture sidecar not built', 'sidecar-missing')
    deps.onLog('error', 'microphone permission denied', 'mic-denied')
    deps.onLog('error', 'screen recording permission denied', 'screen-denied')
    deps.onLog('error', 'ScreenCaptureKit stream stopped', 'sc-stopped')

    expect(statuses).toEqual([
      { ok: false, detail: '[sidecar-missing] capture sidecar not built' },
      { ok: false, detail: '[mic-denied] microphone permission denied' },
      { ok: false, detail: '[screen-denied] screen recording permission denied' },
      { ok: false, detail: '[sc-stopped] ScreenCaptureKit stream stopped' }
    ])
  })

  it('does not treat non-error-level logs as health events', async () => {
    const { factory: sidecarFactory, getDeps } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    const deps = getDeps()

    const statuses: Array<{ ok: boolean; detail: string }> = []
    source.on('health', (s) => statuses.push(s))

    deps.onLog('info', 'capture sidecar started')
    deps.onLog('warn', 'something noteworthy')

    expect(statuses).toHaveLength(0)
  })

  it('stop() calls sidecar.stop()', async () => {
    let stopCalled = false
    const sidecarFactory: SidecarFactory = (): SidecarLike => ({
      start: () => true,
      stop: () => {
        stopCalled = true
      }
    })
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    await source.stop()

    expect(stopCalled).toBe(true)
  })

  it('does not report health for an onLog error arriving after stop() (e.g. a trailing sc-stopped shutdown race)', async () => {
    const { factory: sidecarFactory, getDeps } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    const deps = getDeps()

    const statuses: Array<{ ok: boolean; detail: string }> = []
    source.on('health', (s) => statuses.push(s))

    await source.stop()
    deps.onLog('error', 'ScreenCaptureKit stream stopped', 'sc-stopped')

    expect(statuses).toHaveLength(0)
  })

  it('drops frames delivered directly via deps.onFrame after stop() (not just via a well-behaved drive())', async () => {
    const { factory: sidecarFactory, getDeps } = makeFakeSidecarFactory()
    const source = new SystemAudioSource({ binary: '/fake/bin', sidecarFactory })
    await source.start()
    const deps = getDeps()

    const frames: Array<{ speaker: string }> = []
    source.on('audio', (f) => frames.push({ speaker: f.speaker }))

    await source.stop()
    deps.onFrame(LEG_MIC, makeSamples(0.5))
    deps.onFrame(LEG_SYSTEM, makeSamples(0.5))

    expect(frames).toHaveLength(0)
  })

  describe('speakerForLeg / legForSpeaker (pure round-trip mapping)', () => {
    it('speakerForLeg: mic (0x00) -> rep, system (0x01) -> prospect', () => {
      expect(speakerForLeg(LEG_MIC)).toBe('rep')
      expect(speakerForLeg(LEG_SYSTEM)).toBe('prospect')
    })

    it('legForSpeaker: rep -> mic (0x00), prospect -> system (0x01)', () => {
      expect(legForSpeaker('rep')).toBe(LEG_MIC)
      expect(legForSpeaker('prospect')).toBe(LEG_SYSTEM)
    })

    it('round-trips: legForSpeaker(speakerForLeg(leg)) === leg for every leg', () => {
      const legs: Leg[] = [LEG_MIC, LEG_SYSTEM]
      for (const leg of legs) {
        expect(legForSpeaker(speakerForLeg(leg))).toBe(leg)
      }
    })

    it('round-trips: speakerForLeg(legForSpeaker(speaker)) === speaker for every speaker', () => {
      const speakers: SpeakerRole[] = ['rep', 'prospect']
      for (const speaker of speakers) {
        expect(speakerForLeg(legForSpeaker(speaker))).toBe(speaker)
      }
    })
  })
})
