import { describe, expect, it } from 'vitest'
import type { Analysis } from '@shared/types'
import { panelViewModelFor, stageLabelFor, STALE_THRESHOLD_MS } from '../src/renderer/panel-view'

// Pure display-logic extraction for the analysis panel (spec.md §5/§7,
// Plans.md Task 6.6) — mirrors hint-view.ts's/consent-view.ts's existing
// pure-seam pattern so this is testable without jsdom.

const BASE_ANALYSIS: Analysis = {
  stage: 'objection',
  suggestedQuestions: ['What is driving the hesitation?', 'Who else needs to sign off?'],
  asOfTurn: 7
}

describe('panelViewModelFor', () => {
  it('renders the honest "analysis disabled" empty state when the flag is off', () => {
    const vm = panelViewModelFor({
      analysis: null,
      analysisEnabled: false,
      receivedAtMs: null,
      nowMs: 1_000
    })
    expect(vm).toEqual({
      empty: true,
      emptyReason: 'disabled',
      cloudActive: false,
      stale: false,
      suggestedQuestions: []
    })
  })

  it('renders "analysis disabled" even if a stale analysis object were somehow passed while the flag is off', () => {
    // Defensive: the flag check must win over an (impossible in practice,
    // but not type-forbidden) non-null analysis — never show stale content
    // as if the feature were live.
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: false,
      receivedAtMs: 1_000,
      nowMs: 1_000
    })
    expect(vm.empty).toBe(true)
    expect(vm.emptyReason).toBe('disabled')
    expect(vm.cloudActive).toBe(false)
  })

  it('renders the "awaiting analysis" empty state when enabled but nothing has arrived yet', () => {
    const vm = panelViewModelFor({
      analysis: null,
      analysisEnabled: true,
      receivedAtMs: null,
      nowMs: 1_000
    })
    expect(vm).toEqual({
      empty: true,
      emptyReason: 'awaiting',
      cloudActive: true,
      stale: false,
      suggestedQuestions: []
    })
  })

  it('renders a fresh analysis with the honest "as of turn N (retained)" stamp, not stale', () => {
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: true,
      receivedAtMs: 1_000,
      nowMs: 2_000 // 1s later, well under the threshold
    })
    expect(vm.empty).toBe(false)
    expect(vm.cloudActive).toBe(true)
    expect(vm.stale).toBe(false)
    expect(vm.stageLabel).toBe('Objection')
    expect(vm.suggestedQuestions).toEqual(BASE_ANALYSIS.suggestedQuestions)
    expect(vm.nextSteps).toBeUndefined()
    expect(vm.asOfTurnLabel).toBe('as of turn 7 (retained)')
  })

  it('includes nextSteps only when present on the analysis (exactOptionalPropertyTypes-safe)', () => {
    const withSteps: Analysis = { ...BASE_ANALYSIS, nextSteps: ['Send the pricing sheet'] }
    const vm = panelViewModelFor({
      analysis: withSteps,
      analysisEnabled: true,
      receivedAtMs: 0,
      nowMs: 0
    })
    expect(vm.nextSteps).toEqual(['Send the pricing sheet'])
  })

  it('defensively caps suggestedQuestions at 3, even if the wire payload somehow carried more', () => {
    // Belt-and-suspenders (reviewer finding, Task 6.6 fix): AnalysisOutputSchema
    // (analysis-engine.ts) already enforces .max(3) upstream, but the panel is
    // a second, independent consumer of the Analysis wire type and must not
    // rely on that guarantee alone.
    const tooMany: Analysis = {
      ...BASE_ANALYSIS,
      suggestedQuestions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']
    }
    const vm = panelViewModelFor({
      analysis: tooMany,
      analysisEnabled: true,
      receivedAtMs: 0,
      nowMs: 0
    })
    expect(vm.suggestedQuestions).toEqual(['Q1', 'Q2', 'Q3'])
  })

  it('leaves suggestedQuestions untouched when already within the 3-item cap', () => {
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: true,
      receivedAtMs: 0,
      nowMs: 0
    })
    expect(vm.suggestedQuestions).toEqual(BASE_ANALYSIS.suggestedQuestions)
  })

  it('greys out (stale: true) once the time threshold since receipt has elapsed', () => {
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: true,
      receivedAtMs: 0,
      nowMs: STALE_THRESHOLD_MS + 1
    })
    expect(vm.stale).toBe(true)
  })

  it('is not stale exactly at the threshold boundary (strictly greater-than)', () => {
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: true,
      receivedAtMs: 0,
      nowMs: STALE_THRESHOLD_MS
    })
    expect(vm.stale).toBe(false)
  })

  it('honors a custom staleThresholdMs override', () => {
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: true,
      receivedAtMs: 0,
      nowMs: 5_000,
      staleThresholdMs: 1_000
    })
    expect(vm.stale).toBe(true)
  })

  it('treats a null receivedAtMs as never stale (defensive — should not happen alongside a non-null analysis)', () => {
    const vm = panelViewModelFor({
      analysis: BASE_ANALYSIS,
      analysisEnabled: true,
      receivedAtMs: null,
      nowMs: 1_000_000
    })
    expect(vm.stale).toBe(false)
  })
})

describe('stageLabelFor', () => {
  it('maps every closed AnalysisStage value to a stable, human label', () => {
    expect(stageLabelFor('discovery')).toBe('Discovery')
    expect(stageLabelFor('demo')).toBe('Demo')
    expect(stageLabelFor('objection')).toBe('Objection')
    expect(stageLabelFor('closing')).toBe('Closing')
    expect(stageLabelFor('other')).toBe('Other')
  })
})
