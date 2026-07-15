import { describe, expect, it } from 'vitest'
import { audioEndToHealthMsg, audioHealthToMsg } from '../src/main/health-events'

// pipeline-host.ts wires SystemAudioSource's health/end events to the overlay
// via a HealthMsg — but pipeline-host.ts imports electron, so the wire-shape
// conversion is pulled out into pure functions here (spec.md Task 2.4).
describe('audioHealthToMsg (SystemAudioSource health -> HealthMsg)', () => {
  it('classifies a sidecar-missing detail as source "sidecar"', () => {
    const msg = audioHealthToMsg({
      ok: false,
      detail: '[sidecar-missing] capture sidecar not built'
    })
    expect(msg).toEqual({
      type: 'health',
      ok: false,
      source: 'sidecar',
      detail: '[sidecar-missing] capture sidecar not built'
    })
  })

  it('classifies a mic-denied detail as source "device"', () => {
    const msg = audioHealthToMsg({ ok: false, detail: '[mic-denied] microphone permission denied' })
    expect(msg).toEqual({
      type: 'health',
      ok: false,
      source: 'device',
      detail: '[mic-denied] microphone permission denied'
    })
  })

  it('classifies a screen-denied detail as source "device"', () => {
    const msg = audioHealthToMsg({
      ok: false,
      detail: '[screen-denied] screen recording permission denied'
    })
    expect(msg.source).toBe('device')
  })

  it('classifies a sc-stopped detail as source "device" (mid-session stream loss)', () => {
    const msg = audioHealthToMsg({
      ok: false,
      detail: '[sc-stopped] ScreenCaptureKit stream stopped'
    })
    expect(msg.source).toBe('device')
  })

  it('passes through ok:true unchanged', () => {
    const msg = audioHealthToMsg({ ok: true, detail: 'recovered' })
    expect(msg.ok).toBe(true)
  })
})

describe('audioEndToHealthMsg (SystemAudioSource "end" event -> HealthMsg | null)', () => {
  it('produces a sidecar health(ok:false) for an unexpected exit', () => {
    const msg = audioEndToHealthMsg('exit')
    expect(msg).toEqual({
      type: 'health',
      ok: false,
      source: 'sidecar',
      detail: 'capture sidecar ended unexpectedly (exit)'
    })
  })

  it('produces no health event for an intentional stop() (reason "stopped")', () => {
    const msg = audioEndToHealthMsg('stopped')
    expect(msg).toBeNull()
  })
})
