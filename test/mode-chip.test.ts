import { describe, expect, it } from 'vitest'
import { modeLabelFor } from '../src/renderer/mode-chip'

// Pure display-logic extraction (spec.md §5 "Transport chrome: mode
// selector", Plans.md Task 4.2): the label the always-on mode chip shows for
// a given transport.

describe('modeLabelFor', () => {
  it('labels the current (and only) v1 transport as System audio', () => {
    expect(modeLabelFor('system')).toBe('System audio')
  })

  it('labels file replay distinctly from live capture', () => {
    expect(modeLabelFor('file')).toBe('File replay')
  })

  it('labels twilio as PSTN, ready for Transport A', () => {
    expect(modeLabelFor('twilio')).toBe('PSTN')
  })
})
