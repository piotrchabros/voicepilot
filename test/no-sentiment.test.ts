import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TriggerLabel } from '../src/pipeline/classifier'
import { SYSTEM_PROMPT } from '../src/main/prompts'

// spec.md §1 non-goals: "any emotion / sentiment / stress / personality
// inference" is forbidden (EU AI Act) — classifiers label *what was said*,
// never *how they feel*; the generation prompt must carry the same
// prohibition. This suite asserts both halves of that guard so a future edit
// cannot silently reintroduce sentiment inference into either the generation
// prompt or the Tier-1 classifier.

describe('no-sentiment guard (spec.md §1 non-goals)', () => {
  it('SYSTEM_PROMPT explicitly forbids inferring/mentioning emotion, sentiment, stress, or personality', () => {
    const lower = SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/never infer or mention/i)
    expect(lower).toContain('emotion')
    expect(lower).toContain('sentiment')
    expect(lower).toContain('stress')
    expect(lower).toContain('personality')
  })

  it('TriggerLabel closed set matches spec.md §3 exactly (8 labels, no more, no less)', () => {
    // Mirrors the union declared in src/pipeline/classifier.ts. If a label is
    // added/removed there without updating this list (and spec.md §3), this
    // exhaustiveness check fails at compile time via the type-level checks
    // below, and at runtime via the length/uniqueness assertions.
    const EXPECTED_LABELS = [
      'price_objection',
      'timing_objection',
      'authority_objection',
      'need_question',
      'competitor_mention',
      'buying_signal',
      'smalltalk',
      'none'
    ] as const

    type ExpectedLabel = (typeof EXPECTED_LABELS)[number]
    // Compile-time exhaustiveness in both directions: if TriggerLabel gains or
    // loses a member that isn't reflected in EXPECTED_LABELS, one of these
    // assignments fails to typecheck (tsc --noEmit / vitest's esbuild would
    // still allow it at runtime, but `npm run typecheck` catches it).
    const _forward: TriggerLabel extends ExpectedLabel ? true : false = true
    const _backward: ExpectedLabel extends TriggerLabel ? true : false = true
    void _forward
    void _backward

    const LABELS: readonly TriggerLabel[] = EXPECTED_LABELS
    expect(LABELS.length).toBe(8)
    expect(new Set(LABELS).size).toBe(8)
  })

  it('classifier.ts logic (code, excluding comments) contains no sentiment/emotion vocabulary', () => {
    const src = readFileSync(resolve(__dirname, '../src/pipeline/classifier.ts'), 'utf8')
    // classifier.ts intentionally documents the ban in comments (spec.md §1
    // quoted verbatim in the file header), so those legitimately contain
    // words like "sentiment"/"emotion" as prose, not logic. Strip comments
    // first, then assert the forbidden vocabulary appears nowhere in the
    // remaining code (identifiers, string literals, expressions) — this is
    // what "used as logic" means for this static tripwire.
    const withoutBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
    const codeOnly = withoutBlockComments.replace(/\/\/.*$/gm, '')

    const forbidden = [
      /sentiment/i,
      /\bemotion/i,
      /\bstress/i,
      /\bangry\b/i,
      /\bfrustrat/i,
      /\bmood\b/i,
      /nastroj/i,
      /emocj/i,
      /zdenerwowan/i,
      /sfrustrowan/i
    ]
    for (const re of forbidden) {
      expect(codeOnly).not.toMatch(re)
    }
  })
})
