import { describe, expect, it } from 'vitest'
import { hintDisplayFor } from '../src/renderer/hint-view'

// Pure display-logic extraction (spec.md §5 "headline ≤6 words + one line",
// Plans.md Task 4.2): how a Hint's flat text should split into the
// headline/line visual hierarchy, mirroring hint-engine.ts's
// `${headline} — ${line}` wire format for RETRIEVED suggestions.

describe('hintDisplayFor', () => {
  it('splits RETRIEVED text into headline + line at the em-dash separator', () => {
    expect(
      hintDisplayFor({
        text: 'Price objection — Anchor on total cost of ownership, not sticker price.',
        source: 'RETRIEVED'
      })
    ).toEqual({
      headline: 'Price objection',
      line: 'Anchor on total cost of ownership, not sticker price.'
    })
  })

  it('renders GENERATED text as a single line, never split', () => {
    expect(
      hintDisplayFor({
        text: 'Ask what budget range they already cleared internally.',
        source: 'GENERATED'
      })
    ).toEqual({
      single: 'Ask what budget range they already cleared internally.'
    })
  })

  it('falls back to single-line for RETRIEVED text with no separator (defensive)', () => {
    expect(hintDisplayFor({ text: 'No separator here', source: 'RETRIEVED' })).toEqual({
      single: 'No separator here'
    })
  })

  it('trims surrounding whitespace before splitting', () => {
    expect(hintDisplayFor({ text: '  Headline — Line  ', source: 'RETRIEVED' })).toEqual({
      headline: 'Headline',
      line: 'Line'
    })
  })
})
