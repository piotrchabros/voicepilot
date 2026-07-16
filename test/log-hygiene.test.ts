import { describe, expect, it } from 'vitest'
import type { Hint } from '@shared/types'
import type { Analysis } from '../src/pipeline/analysis-engine'
import {
  formatAnalysisLog,
  formatClassificationLog,
  formatHintLog,
  formatTurnEndLog
} from '../src/pipeline/index'

// spec.md §4.4 (Compliance & security, item 4 "Log hygiene"): no transcript/hint
// text in logs outside explicit debug mode; production default logs contain no
// call content. These tests pin that contract at the pure-function level so a
// future log call can't silently regress it.

const SECRET_TRANSCRIPT = 'ich habe ein geheimnis das niemand wissen darf'
const SECRET_HINT_TEXT = 'sag ihm den Rabatt von 12%'

describe('log hygiene (spec.md §4.4)', () => {
  describe('formatTurnEndLog', () => {
    it('never includes transcript text when debug is off', () => {
      const line = formatTurnEndLog('THEM', SECRET_TRANSCRIPT, false)
      expect(line).toBeNull()
    })

    it('includes transcript text only when debug is explicitly on', () => {
      const line = formatTurnEndLog('THEM', SECRET_TRANSCRIPT, true)
      expect(line).not.toBeNull()
      expect(line).toContain(SECRET_TRANSCRIPT)
    })
  })

  describe('formatHintLog', () => {
    const hint: Hint = { source: 'GENERATED', text: SECRET_HINT_TEXT }

    it('never includes hint text when debug is off', () => {
      const line = formatHintLog(hint, false)
      expect(line).toBeNull()
    })

    it('includes hint text only when debug is explicitly on', () => {
      const line = formatHintLog(hint, true)
      expect(line).not.toBeNull()
      expect(line).toContain(SECRET_HINT_TEXT)
    })
  })

  // spec.md §3 Tier-1 classification is a gate + telemetry label: even in
  // debug mode, only the label + confidence may appear — never the
  // underlying transcript text (that's a separate, already-gated call via
  // formatTurnEndLog above).
  describe('formatClassificationLog', () => {
    it('never logs anything when debug is off', () => {
      const line = formatClassificationLog('price_objection', 0.91, false)
      expect(line).toBeNull()
    })

    it('logs only the label and confidence when debug is explicitly on', () => {
      const line = formatClassificationLog('price_objection', 0.91, true)
      expect(line).not.toBeNull()
      expect(line).toContain('price_objection')
      expect(line).toContain('0.91')
      // No transcript text of any kind should ever appear in this line.
      expect(line).not.toContain(SECRET_TRANSCRIPT)
      expect(line).not.toContain(SECRET_HINT_TEXT)
    })
  })

  // spec.md §7 "Log hygiene (§4.4) extends" to analysis prompts, retrieved KB
  // snippets, brief content, and analysis output (Plans.md Task 6.4): the
  // rendered analysis (stage/questions/next-steps) must never appear in a
  // production-default log line, same rule as hint text above.
  describe('formatAnalysisLog', () => {
    const analysis: Analysis = {
      stage: 'objection',
      suggestedQuestions: [SECRET_HINT_TEXT],
      asOfTurn: 3
    }

    it('never includes analysis content when debug is off', () => {
      const line = formatAnalysisLog(analysis, false)
      expect(line).toBeNull()
    })

    it('includes analysis content only when debug is explicitly on', () => {
      const line = formatAnalysisLog(analysis, true)
      expect(line).not.toBeNull()
      expect(line).toContain(SECRET_HINT_TEXT)
      expect(line).toContain('objection')
      expect(line).toContain('3')
    })
  })
})
