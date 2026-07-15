import { describe, expect, it } from 'vitest'
import type { HealthMsg } from '@shared/types'
import { bannerStateFor } from '../src/renderer/health-banner'

// Pure display-logic extraction (spec.md Task 2.4): the renderer's health
// banner text/visibility is derived here so it can be pinned without jsdom.
describe('bannerStateFor', () => {
  it('shows a warning pill with the detail text when ok:false', () => {
    const health: HealthMsg = {
      type: 'health',
      ok: false,
      source: 'soniox',
      detail: 'ws error: closed'
    }
    expect(bannerStateFor(health)).toEqual({ visible: true, text: '⚠ ws error: closed' })
  })

  it('hides the pill when ok:true (recovery)', () => {
    const health: HealthMsg = { type: 'health', ok: true, source: 'soniox', detail: 'connected' }
    expect(bannerStateFor(health)).toEqual({ visible: false, text: '' })
  })

  it('includes the source-specific detail verbatim for sidecar/device sources too', () => {
    expect(
      bannerStateFor({
        type: 'health',
        ok: false,
        source: 'sidecar',
        detail: 'capture sidecar ended unexpectedly (exit)'
      })
    ).toEqual({ visible: true, text: '⚠ capture sidecar ended unexpectedly (exit)' })
    expect(
      bannerStateFor({
        type: 'health',
        ok: false,
        source: 'device',
        detail: '[mic-denied] microphone permission denied'
      })
    ).toEqual({ visible: true, text: '⚠ [mic-denied] microphone permission denied' })
  })
})
