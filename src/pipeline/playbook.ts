import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { TriggerLabel } from './classifier'

/**
 * The instant layer. Character-trigram cosine over your own objection list.
 * Verbatim port of Playbook.java, now schema-driven (spec.md §3): playbook
 * entries live as YAML `{ id, trigger, headline, line, detail? }` with a
 * `phrases` list, one file or a directory of files under `playbook/`.
 *
 * Trigrams, not words, because Polish inflection will eat a bag-of-words matcher
 * alive: "drogo" / "drogie" / "za drogi" are three different tokens and the same
 * objection. Trigrams see straight through that. Keep it trigrams. Matching key
 * is `phrases` (the trigger phrase(s) an entry should fire on) — a single entry
 * may declare several inflected/variant phrases; the best-scoring phrase wins.
 */

/** The valid closed label set (classifier.ts is the single source of truth). */
const TRIGGER_LABELS: ReadonlySet<TriggerLabel> = new Set([
  'price_objection',
  'timing_objection',
  'authority_objection',
  'need_question',
  'competitor_mention',
  'buying_signal',
  'smalltalk',
  'none'
])

/** One playbook play as authored in YAML. */
export interface PlaybookEntryInput {
  readonly id: string
  readonly trigger: TriggerLabel
  readonly headline: string
  readonly line: string
  readonly detail?: string
  readonly phrases: readonly string[]
}

/** What `nearestPlay()` hands back to a caller — no trigram internals leak out. */
export interface PlaybookPlay {
  readonly id: string
  readonly headline: string
  readonly line: string
  readonly detail: string | undefined
}

interface PhraseGram {
  readonly grams: Map<string, number>
  readonly norm: number
}

interface Entry {
  readonly id: string
  readonly trigger: TriggerLabel
  readonly headline: string
  readonly line: string
  readonly detail: string | undefined
  readonly phraseGrams: readonly PhraseGram[]
}

const MIN_SCORE = 0.25 // below this, show nothing rather than noise
const RECOMMENDED_MAX_HEADLINE_WORDS = 6

export class Playbook {
  private readonly entries: Entry[] = []

  /**
   * Load from a single YAML file path or a directory of `*.yaml`/`*.yml`
   * files (every file's `entries` are merged). Missing directory/file yields
   * a warn + empty playbook, matching the legacy tsv-not-found behavior.
   */
  static load(yamlPathOrDir: string): Playbook {
    if (!existsSync(yamlPathOrDir)) {
      return new Playbook()
    }
    if (statSync(yamlPathOrDir).isDirectory()) {
      const files = readdirSync(yamlPathOrDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
      const p = new Playbook()
      for (const file of files) {
        p.addYamlText(readFileSync(join(yamlPathOrDir, file), 'utf8'))
      }
      return p
    }
    return Playbook.fromYaml(readFileSync(yamlPathOrDir, 'utf8'))
  }

  /**
   * Parse YAML text directly, OR — if given an existing directory/file path —
   * load from disk (directory: merge every `*.yaml`/`*.yml` file inside it).
   */
  static fromYaml(yamlTextOrDir: string): Playbook {
    if (looksLikePath(yamlTextOrDir) && existsSync(yamlTextOrDir)) {
      return Playbook.load(yamlTextOrDir)
    }
    const p = new Playbook()
    p.addYamlText(yamlTextOrDir)
    return p
  }

  private addYamlText(yamlText: string): void {
    if (yamlText.trim().length === 0) return
    const doc = parseYaml(yamlText) as { entries?: unknown } | null
    const rawEntries = doc?.entries
    if (rawEntries === undefined || rawEntries === null) return
    if (!Array.isArray(rawEntries)) {
      throw new Error('playbook yaml: "entries" must be a list')
    }
    for (const raw of rawEntries) {
      this.entries.push(toEntry(validateEntry(raw)))
    }
  }

  /**
   * New API: nearest playbook play as structured data (id/headline/line/detail).
   * Empty-safe: an unmatched turn returns null, which beats showing garbage.
   */
  nearestPlay(text: string): PlaybookPlay | null {
    const q = trigrams(text)
    const qn = norm(q)
    if (qn === 0) return null

    let best: Entry | null = null
    let bestScore = MIN_SCORE
    for (const e of this.entries) {
      for (const pg of e.phraseGrams) {
        const s = cosine(q, qn, pg.grams, pg.norm)
        if (s > bestScore) {
          bestScore = s
          best = e
        }
      }
    }
    if (best === null) return null
    return { id: best.id, headline: best.headline, line: best.line, detail: best.detail }
  }

  /**
   * Legacy string API, kept for callers that haven't migrated to the
   * structured `{ headline, line, detail? }` shape yet. Combines
   * `${headline} — ${line}` the same way hint-engine.ts's RETRIEVED sink does.
   */
  nearest(text: string): string | null {
    const play = this.nearestPlay(text)
    return play === null ? null : `${play.headline} — ${play.line}`
  }
}

/** A crude "is this a filesystem path, not raw YAML text" heuristic: no
 *  newlines and no YAML-ish leading structure. Directory/file loads always go
 *  through `Playbook.load`, so this only needs to steer single-line paths. */
function looksLikePath(s: string): boolean {
  return (
    !s.includes('\n') && !s.trimStart().startsWith('-') && !s.trimStart().startsWith('entries:')
  )
}

function validateEntry(raw: unknown): PlaybookEntryInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('playbook yaml: entry must be an object')
  }
  const r = raw as Record<string, unknown>
  if (typeof r['id'] !== 'string' || r['id'].length === 0) {
    throw new Error('playbook yaml: entry missing required field "id"')
  }
  if (typeof r['trigger'] !== 'string' || r['trigger'].length === 0) {
    throw new Error(`playbook yaml: entry "${r['id']}" missing required field "trigger"`)
  }
  if (!TRIGGER_LABELS.has(r['trigger'] as TriggerLabel)) {
    throw new Error(
      `playbook yaml: entry "${r['id']}" has unknown trigger label "${String(r['trigger'])}" — must be one of ${[...TRIGGER_LABELS].join(', ')}`
    )
  }
  if (typeof r['headline'] !== 'string' || r['headline'].length === 0) {
    throw new Error(`playbook yaml: entry "${r['id']}" missing required field "headline"`)
  }
  if (typeof r['line'] !== 'string' || r['line'].length === 0) {
    throw new Error(`playbook yaml: entry "${r['id']}" missing required field "line"`)
  }
  if (
    !Array.isArray(r['phrases']) ||
    r['phrases'].length === 0 ||
    !r['phrases'].every((p) => typeof p === 'string' && p.length > 0)
  ) {
    throw new Error(
      `playbook yaml: entry "${r['id']}" missing required non-empty string list "phrases"`
    )
  }
  const wordCount = r['headline'].trim().split(/\s+/).filter(Boolean).length
  if (wordCount > RECOMMENDED_MAX_HEADLINE_WORDS) {
    // Recommendation, not a hard rule (spec.md §5 "Headline ≤6 words") — warn only.
    console.warn(
      `playbook yaml: entry "${r['id']}" headline is ${wordCount} words, recommended <= ${RECOMMENDED_MAX_HEADLINE_WORDS}`
    )
  }
  const detail = typeof r['detail'] === 'string' ? r['detail'] : undefined
  return {
    id: r['id'],
    trigger: r['trigger'] as TriggerLabel,
    headline: r['headline'],
    line: r['line'],
    ...(detail !== undefined ? { detail } : {}),
    phrases: r['phrases'] as readonly string[]
  }
}

function toEntry(input: PlaybookEntryInput): Entry {
  return {
    id: input.id,
    trigger: input.trigger,
    headline: input.headline,
    line: input.line,
    detail: input.detail,
    phraseGrams: input.phrases.map((phrase) => {
      const grams = trigrams(phrase)
      return { grams, norm: norm(grams) }
    })
  }
}

// Shared char-trigram cosine primitives — re-exported so other per-section
// retrieval consumers (e.g. src/pipeline/knowledge.ts, spec.md §7) reuse the
// exact same Polish-inflection-robust matching instead of re-implementing it.
export function trigrams(s: string): Map<string, number> {
  const n =
    ' ' +
    s
      .toLowerCase()
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

export function norm(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v * v
  return Math.sqrt(s)
}

export function cosine(
  a: Map<string, number>,
  an: number,
  b: Map<string, number>,
  bn: number
): number {
  if (an === 0 || bn === 0) return 0
  // iterate the smaller side
  const small = a.size <= b.size ? a : b
  const big = small === a ? b : a
  let dot = 0
  for (const [k, v] of small) {
    const o = big.get(k)
    if (o !== undefined) dot += v * o
  }
  return dot / (an * bn)
}
