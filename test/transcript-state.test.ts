import { describe, expect, it } from 'vitest'
import { TranscriptState } from '../src/pipeline/transcript-state'

const SYSTEM = 'You are a copilot.'
const PLAYBOOK = '<context>pricing</context>'

function fresh(maxTurns = 12): TranscriptState {
  return new TranscriptState(SYSTEM, PLAYBOOK, maxTurns)
}

/** The settled-prefix = everything up to and including the last settled turn,
 *  i.e. render text before the closing </transcript> tag. */
function settledPrefix(render: string): string {
  const idx = render.indexOf('</transcript>')
  expect(idx).toBeGreaterThan(0)
  return render.slice(0, idx)
}

describe('TranscriptState prefix stability (the important one)', () => {
  it('settling a new turn keeps the prior settled prefix byte-identical', () => {
    const s = fresh()
    s.settle('THEM', 'ile to kosztuje')
    s.settle('ME', 'zalezy od zakresu')
    const render1 = s.renderPrompt()

    s.settle('THEM', 'za drogo')
    const render2 = s.renderPrompt()

    // Everything through the last settled turn of render#1 is a byte-identical
    // prefix of render#2. If someone adds a timestamp or reorders context, this
    // fails instead of quietly costing ~760ms per hint.
    expect(render2.startsWith(settledPrefix(render1))).toBe(true)
  })

  it('live interim updates never disturb the settled prefix', () => {
    const s = fresh()
    s.settle('THEM', 'dzien dobry')
    s.settle('ME', 'witam')
    const base = settledPrefix(s.renderPrompt())

    // Simulate ~30Hz interim revisions of a live turn.
    for (const interim of ['za', 'za dro', 'za drogo', 'za drogo dla nas']) {
      s.live('THEM', interim)
      expect(s.renderPrompt().startsWith(base)).toBe(true)
    }
  })

  it('the immutable head (system + playbook) is always the literal prefix', () => {
    const s = fresh()
    const head = `${SYSTEM}\n\n${PLAYBOOK}\n\n<transcript>\n`
    expect(s.renderPrompt().startsWith(head)).toBe(true)
    s.settle('THEM', 'cokolwiek')
    expect(s.renderPrompt().startsWith(head)).toBe(true)
  })

  it('renders speakers and tags exactly (no drift in the string building)', () => {
    const s = fresh()
    s.settle('THEM', 'pytanie')
    s.settle('ME', 'odpowiedz')
    expect(s.renderPrompt()).toBe(
      `${SYSTEM}\n\n${PLAYBOOK}\n\n<transcript>\nThem: pytanie\nMe: odpowiedz\n</transcript>\n\n<hint>`,
    )
  })

  it('blank settle is a no-op on history but clears the live turn', () => {
    const s = fresh()
    s.settle('THEM', 'realny obrot')
    s.live('THEM', 'szum')
    s.settle('THEM', '   ')
    expect(s.liveText()).toBe('')
    expect(s.renderPrompt()).toContain('Them: realny obrot\n</transcript>')
  })

  it('retrievalKey only exposes the far end (THEM), never the user', () => {
    const s = fresh()
    s.live('THEM', 'za drogo')
    expect(s.retrievalKey()).toBe('za drogo')
    s.live('ME', 'moja mowa')
    expect(s.retrievalKey()).toBe('')
  })
})
