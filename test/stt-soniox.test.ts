import { describe, expect, it } from 'vitest'
import { TokenTracker } from '../src/pipeline/stt-soniox'

// The Soniox contract: final tokens arrive exactly once and accumulate;
// non-final tokens are a rolling guess replaced by every response.
describe('Soniox TokenTracker', () => {
  it('accumulates finals and replaces non-finals per response', () => {
    const t = new TokenTracker()
    t.onTokens([
      { text: 'To', is_final: true },
      { text: ' jest', is_final: false },
    ])
    expect(t.text()).toBe('To jest')

    // Next response: previous non-final firmed up + new guess.
    t.onTokens([
      { text: ' jest', is_final: true },
      { text: ' za dro', is_final: false },
    ])
    expect(t.text()).toBe('To jest za dro')

    // Revision: non-final replaced wholesale, finals untouched.
    t.onTokens([{ text: ' za drogo', is_final: false }])
    expect(t.text()).toBe('To jest za drogo')
  })

  it('a response with only finals clears the stale non-final tail', () => {
    const t = new TokenTracker()
    t.onTokens([{ text: 'za dro', is_final: false }])
    t.onTokens([{ text: 'za drogo', is_final: true }])
    expect(t.text()).toBe('za drogo')
  })

  it('ignores empty tokens and trims the assembled text', () => {
    const t = new TokenTracker()
    t.onTokens([{ text: ' ', is_final: true }, {}, { text: 'tak', is_final: true }])
    expect(t.text()).toBe('tak')
  })

  it('filters Soniox control markers like <fin> and <end> out of the text', () => {
    const t = new TokenTracker()
    t.onTokens([
      { text: 'za drogo.', is_final: true },
      { text: '<fin>', is_final: true },
      { text: '<end>', is_final: true },
    ])
    expect(t.text()).toBe('za drogo.')
  })

  it('reset() starts a fresh turn', () => {
    const t = new TokenTracker()
    t.onTokens([{ text: 'stare', is_final: true }])
    t.reset()
    t.onTokens([{ text: 'nowe', is_final: false }])
    expect(t.text()).toBe('nowe')
  })
})
