import type { Hint } from '@shared/types'

// Pure display-logic extraction (mirrors bannerStateFor / consentPromptViewFor):
// how a Hint's flat `text` should be split for the visual hierarchy spec.md §5
// asks for — "headline ≤6 words + one line" — kept separate from overlay.ts
// (DOM) so it's testable without jsdom.
//
// hint-engine.ts (retrieval layer) always emits RETRIEVED text as
// `${headline} — ${line}`; GENERATED text is a single free-form string with no
// such structure. This function is the one place that knows the separator, so
// overlay.ts never has to re-parse hint.text itself.
//
// Detail-on-tap (spec.md §5 "detail on tap") is out of scope for this pass:
// the overlay window is click-through by design (main toggles
// setIgnoreMouseEvents only for the consent prompt, Plans.md Task 4.1), so
// there is nothing to tap yet. Revisit once/if the hint pill grows real
// pointer targets.
export interface HintDisplay {
  /** Bold/larger headline line — set only when the source text carries the
   *  `headline — line` structure (RETRIEVED). */
  readonly headline?: string
  /** Thin/smaller detail line accompanying `headline`. */
  readonly line?: string
  /** Single-line display — GENERATED, or RETRIEVED text with no separator
   *  (defensive: still render something rather than drop the hint). */
  readonly single?: string
}

const HEADLINE_SEPARATOR = ' — '

export function hintDisplayFor(hint: Hint): HintDisplay {
  const text = hint.text.trim()
  if (hint.source === 'RETRIEVED') {
    const sepIndex = text.indexOf(HEADLINE_SEPARATOR)
    if (sepIndex >= 0) {
      return {
        headline: text.slice(0, sepIndex),
        line: text.slice(sepIndex + HEADLINE_SEPARATOR.length)
      }
    }
  }
  return { single: text }
}
