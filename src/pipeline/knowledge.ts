import { basename, join, relative } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cosine, norm, trigrams } from './playbook'

/**
 * Knowledge base loader + per-section retrieval (spec.md §7).
 *
 * `knowledge/**\/*.md` (sales-closing practices, strategy, sales-psychology
 * notes, product/service info) is chunked by `##` heading; retrieval is
 * char-trigram cosine per section, top-K — the same Polish-inflection
 * rationale as the playbook (§3). Embeddings stay rejected at this scale
 * (≤~200 sections); revisit only with recall evidence, as its own recorded
 * decision.
 *
 * `customers/<name>.md` briefs are a separate, always-injected concern:
 * loaded whole by explicit name via `loadCustomerBrief()`, never chunked,
 * never scored, never part of a `KnowledgeBase` retrieval pool, and never
 * copied into any derived store.
 */

/** One retrieved knowledge snippet — a whole `##` section plus its score. */
export interface KnowledgeSnippet {
  readonly file: string
  readonly heading: string
  readonly content: string
  readonly score: number
}

interface Section {
  readonly file: string
  readonly heading: string
  readonly content: string
  readonly grams: Map<string, number>
  readonly gnorm: number
}

// Mirrors playbook.ts's MIN_SCORE pattern: below this, show nothing rather
// than a noisy near-miss section.
const MIN_SCORE = 0.25

/**
 * EU AI Act (spec.md §7 "KB content rule"): psychology notes may describe
 * techniques and language, never instructions to detect or exploit the
 * prospect's — or the rep's — emotional state (Art 5(1)(f): rep-side
 * emotion inference is the workplace tripwire). This is a closed pattern
 * list. Growing it is a recorded product decision, same bar as spec.md —
 * do not extend it ad hoc from inside a loader call site.
 */
const EMOTION_INFERENCE_PATTERNS: readonly RegExp[] = [
  // Polish
  /wyczuj\s+(jego\s+|jej\s+|ich\s+)?(emocj|nastr[oó]j|ton)/i,
  /rozpoznaj\s+(jego\s+|jej\s+|ich\s+)?emocj/i,
  /wykryj\s+(jego\s+|jej\s+|ich\s+)?(emocj|nastr[oó]j|frustracj|stres|zdenerwowani)/i,
  /oce[nń]\s+(jego\s+|jej\s+|ich\s+)?(nastr[oó]j|stan\s+emocjonalny)/i,
  /profiluj\s+(jego\s+|jej\s+|ich\s+)?(emocj|osobowo[śs][ćc])/i,
  // English
  /read\s+(their|his|her|the)\s+(tone|mood|emotion|emotional state)/i,
  /detect\s+(frustration|emotion|mood|sentiment|stress)/i,
  /infer\s+(emotion|mood|sentiment|feelings|emotional state)/i,
  /gauge\s+(mood|emotion|sentiment)/i,
  /sense\s+(frustration|emotion|mood)/i,
  /(emotion|mood|sentiment)\s+(scoring|score|profiling)/i
]

function isDenylisted(content: string): boolean {
  return EMOTION_INFERENCE_PATTERNS.some((re) => re.test(content))
}

/** Split markdown text into `## `-delimited sections. Text before the first
 *  `## ` heading (title, preamble) is not a section and is dropped — chunk
 *  granularity is the `##` heading, per spec.md §7. */
function chunkMarkdown(text: string): Array<{ heading: string; content: string }> {
  const lines = text.split(/\r?\n/)
  const sections: Array<{ heading: string; content: string }> = []
  let currentHeading: string | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (currentHeading !== null) {
      const content = buffer.join('\n').trim()
      if (content.length > 0) {
        sections.push({ heading: currentHeading, content })
      }
    }
    buffer = []
  }

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m?.[1] !== undefined) {
      flush()
      currentHeading = m[1]
    } else if (currentHeading !== null) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

/** Recursively collect every `*.md` file under `dir` (knowledge/**\/*.md). */
function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkMarkdownFiles(full))
    } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

export class KnowledgeBase {
  private readonly sections: Section[] = []

  /**
   * Load every `knowledge/**\/*.md` file, chunk by `##` heading, and run
   * the emotion-inference denylist lint on each section. A missing `dir`
   * yields a warn + empty knowledge base — never a crash (mirrors
   * playbook.ts's empty-safe behavior).
   */
  static load(dir: string): KnowledgeBase {
    const kb = new KnowledgeBase()
    if (!existsSync(dir)) {
      console.warn(`knowledge base: directory not found: ${dir} — loading empty`)
      return kb
    }
    const files = walkMarkdownFiles(dir)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(dir, file)
      for (const { heading, content } of chunkMarkdown(text)) {
        if (isDenylisted(content)) {
          // Log only file + heading — never the rejected content itself.
          console.warn(`knowledge base: section rejected by denylist lint: ${rel} § ${heading}`)
          continue
        }
        const grams = trigrams(content)
        kb.sections.push({ file: rel, heading, content, grams, gnorm: norm(grams) })
      }
    }
    return kb
  }

  /** Number of retrievable sections currently loaded. */
  get size(): number {
    return this.sections.length
  }

  /**
   * Per-section top-K retrieval via char-trigram cosine (same rationale as
   * playbook.ts §3): Polish-inflection-robust, no vector store needed at
   * ≤~200 sections. Below `MIN_SCORE`, a section is excluded rather than
   * returned as a noisy near-miss.
   */
  search(query: string, topK = 3): KnowledgeSnippet[] {
    const q = trigrams(query)
    const qn = norm(q)
    if (qn === 0) return []

    const scored: KnowledgeSnippet[] = []
    for (const s of this.sections) {
      const score = cosine(q, qn, s.grams, s.gnorm)
      if (score > MIN_SCORE) {
        scored.push({ file: s.file, heading: s.heading, content: s.content, score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(0, topK))
  }
}

/**
 * Load a `customers/<name>.md` brief whole, by explicit operator-selected
 * name (spec.md §7). This is deliberately outside `KnowledgeBase`: briefs
 * are always-injected, never retrieved, never scored, and never copied into
 * any derived store. Missing directory/file returns `null` and warns —
 * never throws (personal-data-bearing content must never appear in the
 * warn message).
 */
export function loadCustomerBrief(customersDir: string, name: string): string | null {
  if (!existsSync(customersDir)) {
    console.warn(`customer briefs: directory not found: ${customersDir}`)
    return null
  }
  // basename() guards against path traversal via a crafted `name`.
  const safeName = basename(name)
  const filePath = join(customersDir, `${safeName}.md`)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    console.warn(`customer brief not found: ${safeName}`)
    return null
  }
  return readFileSync(filePath, 'utf8')
}
