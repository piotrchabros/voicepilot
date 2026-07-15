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

  // Defensive/spec-pinning: hintDisplayFor splits on the *first* ' — '
  // occurrence in the whole `${headline} — ${line}` string (hint-engine.ts's
  // wire format). This is the contract, not an accident — but it means an
  // entry whose `headline` field itself contains an em-dash (e.g. a playbook
  // author writing "Budget — timing mismatch" as one headline) does NOT
  // round-trip: the first em-dash it hits — inside the headline — is
  // (wrongly, from that author's intent) treated as the headline/line
  // separator, truncating the headline early and pushing the rest of it into
  // `line`. Pinned here as current behavior, not a recommendation.
  // playbook.ts's `validateEntry` doesn't currently reject em-dashes inside a
  // `headline` field; if this ambiguity becomes a real authoring problem, add
  // that guard there (reject/escape em-dash in `headline`) rather than
  // changing the first-index split here, since the wire format itself has no
  // other way to know where a headline ends.
  it('splits at the first em-dash — even when that happens to fall inside text a playbook author intended as one headline', () => {
    expect(
      hintDisplayFor({
        text: 'Budget — timing mismatch — Ask which quarter the budget actually resets.',
        source: 'RETRIEVED'
      })
    ).toEqual({
      headline: 'Budget',
      line: 'timing mismatch — Ask which quarter the budget actually resets.'
    })
  })
})
