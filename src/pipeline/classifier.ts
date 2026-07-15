/**
 * Tier-1 trigger classifier (spec.md §3). Runs on SETTLED prospect turns as a
 * gate + telemetry label, never as the trigger for painting a card (that stays
 * speculative/instant per spec.md §3 "Speculative suggestion is kept").
 *
 * Label set is a CLOSED set (spec.md §3). Do not add labels here without
 * updating spec.md first — this list is the single source of truth other
 * modules (playbook trigger routing, no-sentiment guard tests) key off of.
 *
 * spec.md §1 non-goals: "any emotion / sentiment / stress / personality
 * inference (EU AI Act) — classifiers label *what was said*, never *how they
 * feel*". Nothing in this file may reason about tone, emotional state,
 * stress level, or personality — only lexical/topical category of the
 * utterance. Do not add sentiment/stress features here.
 *
 * Polish-first keyword/regex rules, char-trigram normalized the same way
 * playbook.ts is (see playbook.ts header): trigrams, not words, because
 * Polish inflection ("drogo" / "drogie" / "za drogi") would defeat a
 * bag-of-words matcher. Pure function, zero deps, synchronous.
 */

export type TriggerLabel =
  | 'price_objection'
  | 'timing_objection'
  | 'authority_objection'
  | 'need_question'
  | 'competitor_mention'
  | 'buying_signal'
  | 'smalltalk'
  | 'none'

export interface Classification {
  readonly label: TriggerLabel
  readonly confidence: number
}

export interface ClassifyOpts {
  readonly separation?: 'clean' | 'mixed'
}

/** Confidence threshold under normal ('clean') separation. Tuned above the
 * incidental trigram overlap floor (~0.2 for unrelated small-talk-adjacent
 * sentences, ~0.38 for negated sentences that still share trigrams with an
 * unrelated label after the negation guard zeroes out their own label — see
 * "nie jest wcale za drogie" in test/classifier.test.ts) and below the
 * weakest true-positive fixture (~0.48). */
const CLEAN_THRESHOLD = 0.42
/**
 * Under 'mixed' separation (system loopback — everyone-but-the-rep, no
 * diarization) the input is noisier, so a match must be more decisive before
 * we act on it. spec.md §2: "Mixed input raises the Tier-1 confidence
 * threshold (diarization deferred; decision recorded, not silent)".
 */
const MIXED_THRESHOLD = 0.55

/**
 * Ordered rule table. Rule/phrase order is NOT the tie-breaker (see
 * `pickBetter` below): when two phrases score equally, the longer phrase
 * wins because it is the more specific (less accidental) match. This matters
 * because plain substring hits all score exactly 1 — array order alone would
 * otherwise let a short, generic phrase from an earlier rule beat a longer,
 * more specific phrase from a later rule.
 */
interface Rule {
  readonly label: Exclude<TriggerLabel, 'none'>
  readonly phrases: readonly string[]
}

const RULES: readonly Rule[] = [
  {
    label: 'smalltalk',
    phrases: [
      'dzień dobry',
      'dobry wieczor',
      'jak sie masz',
      'jak leci',
      'milo mi',
      'piekna pogoda',
      'ladna pogoda',
      'dziekuje bardzo',
      'dziekuje za rozmowe',
      'do uslyszenia',
      'do widzenia',
      // NOT bare "na razie": that generic farewell is a substring of
      // brush-offs like "na razie nie" (timing_objection) and would win a
      // same-score tie by array order. Only match an unambiguous, fuller
      // farewell phrase here.
      'to na razie, dzieki'
    ]
  },
  {
    label: 'price_objection',
    phrases: [
      'za drogie',
      'za drogo',
      'za drogi',
      'drogo to jest',
      'zbyt drogie',
      'zbyt kosztowne',
      'nie stac nas',
      'poza budzetem',
      'przekracza budzet',
      'wysoka cena',
      'duzy koszt',
      'obnizyc cene',
      'jaki rabat'
    ]
  },
  {
    label: 'timing_objection',
    phrases: [
      'nie teraz',
      'moze pozniej',
      'za miesiac',
      'w przyszlym',
      'jeszcze nie jestesmy gotowi',
      'nie jestesmy gotowi',
      'wroccie za',
      'zadzwon za',
      'nie w tym momencie',
      'na razie nie',
      'pozniej porozmawiamy',
      'w przyszlym kwartale',
      'w przyszlym roku',
      // Stalling variant of "bierzemy to" (buying_signal): "we'll take it
      // under consideration" is a delay, not a commitment.
      'bierzemy to pod uwage'
    ]
  },
  {
    label: 'authority_objection',
    phrases: [
      'skonsultowac z szefem',
      'skonsultowac z moim szefem',
      'z przelozonym',
      'porozmawiac z przelozonym',
      'decyzje podejmuje zarzad',
      'to nie moja decyzja',
      'to nie jest moja decyzja',
      'musze zapytac',
      'musze to przedyskutowac',
      'decyduje zarzad',
      'z dzialem zakupow'
    ]
  },
  {
    label: 'need_question',
    phrases: [
      'jak to dziala',
      'jak to bedzie dzialalo',
      'jak to bedzie dzialac',
      'czy to zadziala',
      'czy to obsluguje',
      'czy wspiera',
      'czy jest kompatybilne',
      'co to obejmuje',
      'jak to wyglada w praktyce',
      'czy moge zapytac'
    ]
  },
  {
    label: 'competitor_mention',
    phrases: [
      'konkurencja',
      'konkurenta',
      'konkurencyjne rozwiazanie',
      'inny dostawca',
      'innego dostawcy',
      'innym rozwiazaniem',
      'obecny dostawca',
      'aktualnie uzywamy',
      'obecnie korzystamy'
    ]
  },
  {
    label: 'buying_signal',
    phrases: [
      'jak mozemy zaczac',
      'kiedy mozemy zaczac',
      'kiedy mozemy wdrozyc',
      'jestem gotowy podpisac',
      'gotowi podpisac',
      'wysylajcie umowe',
      'wyslijcie umowe',
      // More specific than bare "bierzemy to" (which also matches the
      // stalling phrase "bierzemy to pod uwagę" that belongs to
      // timing_objection instead).
      'bierzemy to od razu',
      'chcemy to wdrozyc',
      'super, dzialamy',
      'jak wygladaja kolejne kroki'
    ]
  }
]

/** Strip diacritics + lowercase + collapse whitespace. Polish text only uses
 * a handful of accented letters, so a manual map avoids pulling in a
 * normalization dependency (this file must stay dependency-free). */
const DIACRITICS: Readonly<Record<string, string>> = {
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z'
}

function foldDiacritics(s: string): string {
  let out = ''
  for (const ch of s) out += DIACRITICS[ch] ?? ch
  return out
}

function normalize(s: string): string {
  return foldDiacritics(s.toLowerCase()).trim()
}

/** Char-trigram bag, same construction as playbook.ts's `trigrams()` — pads
 * with a leading/trailing space so short words still contribute grams. */
function trigrams(s: string): Map<string, number> {
  const n =
    ' ' +
    normalize(s)
      .replace(/[^\p{L}\p{Nd}]+/gu, ' ')
      .trim() +
    ' '
  const m = new Map<string, number>()
  for (let i = 0; i + 3 <= n.length; i++) {
    const g = n.substring(i, i + 3)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

function normOf(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v * v
  return Math.sqrt(s)
}

function cosine(a: Map<string, number>, an: number, b: Map<string, number>, bn: number): number {
  if (an === 0 || bn === 0) return 0
  const small = a.size <= b.size ? a : b
  const big = small === a ? b : a
  let dot = 0
  for (const [k, v] of small) {
    const o = big.get(k)
    if (o !== undefined) dot += v * o
  }
  return dot / (an * bn)
}

/**
 * Lightweight negation guard vocabulary (declared before COMPILED_PHRASES,
 * which needs NEGATION_WORDS to precompute `selfNegating`): a phrase match
 * is discarded if one of the NEGATION_WORDS appears within
 * NEGATION_LOOKBACK tokens immediately before the match, WITHOUT crossing a
 * clause boundary — a comma/period/question mark/exclamation mark, or a
 * contrastive conjunction (ale/lecz/jednak/wiec), ends the lookback window.
 * This keeps an unrelated negation in an earlier clause ("nie wiem, ale to
 * nie moja decyzja") from cancelling a match in the current one. Only
 * applied to exact-substring matches, where the match start index is known;
 * phrases that are themselves self-negating (see `CompiledPhrase.selfNegating`
 * below) skip this check entirely.
 */
const NEGATION_WORDS = new Set(['nie', 'wcale'])
const NEGATION_LOOKBACK = 3
const CLAUSE_BOUNDARY_PUNCT = /[,.?!]/
const CLAUSE_BOUNDARY_WORDS = new Set(['ale', 'lecz', 'jednak', 'wiec'])

interface CompiledPhrase {
  readonly label: Exclude<TriggerLabel, 'none'>
  readonly normalizedPhrase: string
  readonly length: number
  readonly grams: Map<string, number>
  readonly gramsNorm: number
  /** True when the phrase itself already contains a negation word (e.g.
   * "nie teraz", "to nie moja decyzja"). Such phrases are their OWN negation
   * and must never be run through `isNegated` — there is nothing further to
   * negate, and checking would only risk an unrelated "nie"/"wcale" earlier
   * in a different clause incorrectly cancelling a legitimate match. */
  readonly selfNegating: boolean
}

/**
 * Precomputed once at module load (not per `classifyTurn` call): each rule
 * phrase's normalized form and trigram bag. `classifyTurn` runs on every
 * settled prospect turn, so recomputing these constants per call would be
 * pure waste — the rule table never changes at runtime.
 */
const COMPILED_PHRASES: readonly CompiledPhrase[] = RULES.flatMap((rule) =>
  rule.phrases.map((phrase) => {
    const normalizedPhrase = normalize(phrase)
    const grams = trigrams(phrase)
    const phraseTokens = normalizedPhrase.split(/\s+/).filter(Boolean)
    return {
      label: rule.label,
      normalizedPhrase,
      length: normalizedPhrase.length,
      grams,
      gramsNorm: normOf(grams),
      selfNegating: phraseTokens.some((t) => NEGATION_WORDS.has(t))
    }
  })
)

function isNegated(normalizedText: string, matchIndex: number): boolean {
  const tokens = normalizedText.slice(0, matchIndex).split(/\s+/).filter(Boolean)

  // Find the start of the current clause: scan backward from the match and
  // stop at the nearest boundary (punctuation attached to a token, or a
  // contrastive conjunction token) — negation words before that boundary
  // belong to a different clause and must not count.
  let clauseStart = 0
  for (let i = tokens.length - 1; i >= 0; i--) {
    const raw = tokens[i]
    if (raw === undefined) continue
    const bare = raw.replace(/[,.?!]/g, '')
    if (CLAUSE_BOUNDARY_PUNCT.test(raw) || CLAUSE_BOUNDARY_WORDS.has(bare)) {
      clauseStart = i + 1
      break
    }
  }

  const window = tokens.slice(clauseStart).slice(-NEGATION_LOOKBACK)
  return window.some((token) => NEGATION_WORDS.has(token.replace(/[,.?!]/g, '')))
}

/** Tie-break rule: strictly higher score wins; on an exact tie, the longer
 * (more specific) phrase wins. Longer-phrase-wins only matters between two
 * substring hits (both score exactly 1) or two trigram-fallback hits that
 * happen to tie — either way "more specific match" is the correct tiebreak. */
function isBetter(score: number, length: number, bestScore: number, bestLength: number): boolean {
  if (score > bestScore) return true
  return score === bestScore && score > 0 && length > bestLength
}

/**
 * classifyTurn: pure, synchronous, dependency-free. Never infers emotion,
 * sentiment, stress, or personality — only a closed-set topical label
 * (spec.md §1, §3).
 */
export function classifyTurn(text: string, opts?: ClassifyOpts): Classification {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { label: 'none', confidence: 0 }

  const normalizedText = normalize(trimmed)
  const q = trigrams(trimmed)
  const qn = normOf(q)
  if (qn === 0) return { label: 'none', confidence: 0 }

  // Pass 1: exact-substring matches, so we know which labels the speaker
  // explicitly negated ("nie jest wcale za drogie"). A negated exact match
  // must also suppress trigram-fallback near-duplicates under the SAME
  // label in pass 2 (e.g. "za drogo" trigram-overlapping "za drogie" right
  // after it was negated) — otherwise the negation guard is defeated by a
  // slightly different wording of the very same phrase.
  const negatedLabels = new Set<Exclude<TriggerLabel, 'none'>>()
  for (const compiled of COMPILED_PHRASES) {
    if (compiled.selfNegating) continue
    const matchIndex = normalizedText.indexOf(compiled.normalizedPhrase)
    if (matchIndex !== -1 && isNegated(normalizedText, matchIndex)) {
      negatedLabels.add(compiled.label)
    }
  }

  let bestLabel: Exclude<TriggerLabel, 'none'> | null = null
  let bestScore = 0
  let bestLength = 0

  for (const compiled of COMPILED_PHRASES) {
    let score: number
    const matchIndex = normalizedText.indexOf(compiled.normalizedPhrase)
    if (matchIndex !== -1) {
      // Exact substring match on folded text is a strong, cheap signal
      // (handles verbatim/near-verbatim PL objections) — unless negated.
      // Self-negating phrases (e.g. "nie teraz") are never run through the
      // guard: they carry their own negation already.
      score = !compiled.selfNegating && isNegated(normalizedText, matchIndex) ? 0 : 1
    } else if (negatedLabels.has(compiled.label)) {
      score = 0
    } else {
      score = cosine(q, qn, compiled.grams, compiled.gramsNorm)
    }
    if (isBetter(score, compiled.length, bestScore, bestLength)) {
      bestScore = score
      bestLabel = compiled.label
      bestLength = compiled.length
    }
  }

  const threshold = opts?.separation === 'mixed' ? MIXED_THRESHOLD : CLEAN_THRESHOLD
  if (bestLabel === null || bestScore < threshold) {
    return { label: 'none', confidence: bestScore }
  }
  return { label: bestLabel, confidence: bestScore }
}

/**
 * Tier-2 suppression gate: smalltalk/none never trigger a suggestion.
 * Wiring into the suggestion pipeline is a later task; this is exported now
 * so that task can consume it directly instead of re-deriving the rule.
 */
export function shouldSuggest(c: Classification): boolean {
  return c.label !== 'smalltalk' && c.label !== 'none'
}
