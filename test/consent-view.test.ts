import { describe, expect, it } from 'vitest'
import { consentPromptViewFor, recIndicatorViewFor } from '../src/renderer/consent-view'

// Pure display-logic extraction (mirrors health-banner.ts's bannerStateFor
// pattern, spec.md Task 2.4): what the consent prompt / REC indicator should
// show for a given consent state, kept separate from overlay.ts (DOM +
// timers) so it's testable without jsdom (spec.md §5 / Plans.md Task 4.1).

describe('consentPromptViewFor', () => {
  it('is visible with the announcement text while pending', () => {
    expect(consentPromptViewFor('pending', 'Announcement text', false)).toEqual({
      visible: true,
      announcement: 'Announcement text',
      isPlaceholder: false
    })
  })

  it('carries the placeholder flag through untouched', () => {
    expect(
      consentPromptViewFor('pending', '[consent announcement pending legal review]', true)
    ).toEqual({
      visible: true,
      announcement: '[consent announcement pending legal review]',
      isPlaceholder: true
    })
  })

  it('is hidden once affirmed', () => {
    expect(consentPromptViewFor('affirmed', 'Announcement text', false)).toEqual({
      visible: false,
      announcement: 'Announcement text',
      isPlaceholder: false
    })
  })
})

describe('recIndicatorViewFor', () => {
  it('is hidden while consent is pending — no recording before affirmation', () => {
    expect(recIndicatorViewFor('pending')).toEqual({ visible: false })
  })

  it('is visible (persistent) once consent is affirmed', () => {
    expect(recIndicatorViewFor('affirmed')).toEqual({ visible: true })
  })
})
