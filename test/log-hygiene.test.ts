import { describe, expect, it } from 'vitest'
import type { Hint } from '@shared/types'
import { formatHintLog, formatTurnEndLog } from '../src/pipeline/index'

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
})
