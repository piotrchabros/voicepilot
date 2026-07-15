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
 * incidental trigram overlap floor (~0.2) that unrelated small-talk-adjacent
 * sentences can hit by chance, and below the weakest true-positive fixture
 * (~0.48) — see test/classifier.test.ts. */
const CLEAN_THRESHOLD = 0.35
/**
 * Under 'mixed' separation (system loopback — everyone-but-the-rep, no
 * diarization) the input is noisier, so a match must be more decisive before
 * we act on it. spec.md §2: "Mixed input raises the Tier-1 confidence
 * threshold (diarization deferred; decision recorded, not silent)".
 */
const MIXED_THRESHOLD = 0.55

/**
 * Ordered rule table. Order matters only as a tie-breaker convention (first
 * label to reach the winning score wins); scores are still compared
 * numerically below, so a later rule with a stronger match still wins.
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
      'na razie'
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
      'w przyszlym roku'
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
      'bierzemy to',
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

  let bestLabel: Exclude<TriggerLabel, 'none'> | null = null
  let bestScore = 0

  for (const rule of RULES) {
    for (const phrase of rule.phrases) {
      const normalizedPhrase = normalize(phrase)
      // Exact substring match on folded text is a strong, cheap signal
      // (handles verbatim/near-verbatim PL objections).
      let score = 0
      if (normalizedText.includes(normalizedPhrase)) {
        score = 1
      } else {
        const p = trigrams(phrase)
        const pn = normOf(p)
        score = cosine(q, qn, p, pn)
      }
      if (score > bestScore) {
        bestScore = score
        bestLabel = rule.label
      }
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
