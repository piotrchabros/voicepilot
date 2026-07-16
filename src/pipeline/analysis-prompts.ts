import type { KnowledgeSnippet } from './knowledge'

/**
 * Prompt context for the Phase-6 AnalysisEngine (spec.md §7; Plans.md Task
 * 6.4). Kept inside src/pipeline (not src/main) — same rule as
 * TranscriptState/HintEngine — because AnalysisEngine must survive the
 * Phase-5 Fastify lift (transport-agnostic, no Electron imports).
 */

// spec.md §1 non-goals: "any emotion / sentiment / stress / personality
// inference" is forbidden (EU AI Act) — the analysis prompt must carry the
// same prohibition already enforced on the hint-generation prompt
// (src/main/prompts.ts SYSTEM_PROMPT, "Never infer or mention..." line) and
// on the Tier-1 classifier (src/pipeline/classifier.ts). spec.md §7 also
// requires this guard a SECOND time, on the output path (see
// SENTIMENT_OUTPUT_PATTERNS below) — prompt-only guards fail on model
// drift, so the engine re-checks every response before rendering it.
export const ANALYSIS_SYSTEM_PROMPT = `You are a sales-call analysis assistant. You receive a rolling window of a live transcript, top-K excerpts from a knowledge base, and (optionally) a customer brief.
Respond with ONLY a single JSON object matching this schema — no prose, no markdown fences, no extra keys:
{"stage": "discovery" | "demo" | "objection" | "closing" | "other", "suggested_questions": string[] (at most 3), "next_steps": string[] (optional)}
Frame every suggestion as legitimate persuasion and objection handling. Never suggest deceptive claims, false urgency, or tactics that exploit the prospect's vulnerabilities.
Never infer or mention the prospect's emotions, sentiment, stress, or personality. Base every field only on WHAT was said.
If nothing useful applies, output {"stage": "other", "suggested_questions": []}.
`

/**
 * Closed list (PL+EN) mirroring the sentiment/emotion vocabulary
 * test/no-sentiment.test.ts asserts against in classifier.ts's static scan
 * (Plans.md Task 3.4) — reused/extended here as an OUTPUT-path filter, not a
 * static code scan: any AnalysisEngine response string matching one of
 * these patterns is dropped, never rendered (spec.md §7 "Closed output
 * schema"). Growing this list is a recorded product decision, same bar as
 * EMOTION_INFERENCE_PATTERNS in knowledge.ts — do not extend it ad hoc from
 * a call site.
 */
export const SENTIMENT_OUTPUT_PATTERNS: readonly RegExp[] = [
  // English
  /sentiment/i,
  /\bemotion/i,
  /\bstress/i,
  /\bangry\b/i,
  /\bfrustrat/i,
  /\bmood\b/i,
  /\bupset\b/i,
  /\banxious\b/i,
  // Polish
  /nastroj/i,
  /emocj/i,
  /zdenerwowan/i,
  /sfrustrowan/i,
  /zestresowan/i,
  /zaniepokojon/i
]

/** True when `text` matches any entry in {@link SENTIMENT_OUTPUT_PATTERNS}. */
export function containsSentimentVocabulary(text: string): boolean {
  return SENTIMENT_OUTPUT_PATTERNS.some((re) => re.test(text))
}

export interface AnalysisPromptInput {
  readonly transcriptText: string
  readonly asOfTurn: number
  readonly kbSnippets: readonly KnowledgeSnippet[]
  readonly customerBrief: string | null
}

/**
 * Builds the user prompt for one analysis call. Only the rolling-window
 * transcript text + top-K KB snippets + the selected brief content leave the
 * device — never the whole KnowledgeBase (spec.md §7). "as of turn N" stamps
 * the rolling window's turn count so a caller can tell how stale the
 * transcript context was at generation time — a display value, not a
 * global monotonic counter (it plateaus at TranscriptState's retained-turn
 * cap; see TranscriptState.renderRollingWindow).
 */
export function buildAnalysisUserPrompt(input: AnalysisPromptInput): string {
  let sb = ''
  sb += `<as-of-turn>${input.asOfTurn}</as-of-turn>\n\n`
  sb += '<transcript>\n'
  sb += input.transcriptText
  sb += '</transcript>\n\n'
  if (input.kbSnippets.length > 0) {
    sb += '<knowledge>\n'
    for (const s of input.kbSnippets) {
      sb += `## ${s.heading}\n${s.content}\n\n`
    }
    sb += '</knowledge>\n\n'
  }
  if (input.customerBrief !== null && input.customerBrief.trim().length > 0) {
    sb += '<customer-brief>\n'
    sb += input.customerBrief
    sb += '\n</customer-brief>\n\n'
  }
  return sb
}
