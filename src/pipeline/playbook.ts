import { readFileSync } from 'node:fs'

/**
 * The instant layer. Character-trigram cosine over your own objection list.
 * Verbatim port of Playbook.java.
 *
 * Trigrams, not words, because Polish inflection will eat a bag-of-words matcher
 * alive: "drogo" / "drogie" / "za drogi" are three different tokens and the same
 * objection. Trigrams see straight through that. Keep it trigrams.
 *
 * Format (playbook.tsv), one per line:
 *   trigger phrase <TAB> hint to display
 */
interface Entry {
  readonly trigger: string
  readonly hint: string
  readonly grams: Map<string, number>
  readonly norm: number
}

const MIN_SCORE = 0.25 // below this, show nothing rather than noise

export class Playbook {
  private readonly entries: Entry[] = []

  static load(tsvPath: string): Playbook {
    return Playbook.parse(readFileSync(tsvPath, 'utf8'))
  }

  static parse(tsv: string): Playbook {
    const p = new Playbook()
    for (const line of tsv.split('\n')) {
      if (line.trim().length === 0 || line.startsWith('#')) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const trigger = line.slice(0, tab)
      const hint = line.slice(tab + 1).trim()
      const grams = trigrams(trigger)
      p.entries.push({ trigger, hint, grams, norm: norm(grams) })
    }
    return p
  }

  /** Empty-safe: an unmatched turn returns null, which beats showing garbage. */
  nearest(text: string): string | null {
    const q = trigrams(text)
    const qn = norm(q)
    if (qn === 0) return null

    let best: Entry | null = null
    let bestScore = MIN_SCORE
    for (const e of this.entries) {
      const s = cosine(q, qn, e.grams, e.norm)
      if (s > bestScore) {
        bestScore = s
        best = e
      }
    }
    return best ? best.hint : null
  }
}

function trigrams(s: string): Map<string, number> {
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

function norm(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v * v
  return Math.sqrt(s)
}

function cosine(a: Map<string, number>, an: number, b: Map<string, number>, bn: number): number {
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
