import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeBase, loadCustomerBrief } from '../src/pipeline/knowledge'

// PL fixture corpus mirroring the shipped knowledge/ shape (spec.md §7):
// knowledge/**/*.md chunked by "## " heading, one file may hold several
// sections. Content is sales-closing / objection-handling technique prose —
// never instructions to detect the prospect's emotional state.
const CLOSING_MD = `# Techniki zamykania sprzedazy

## Obiekcja cenowa

Kiedy klient mowi, ze jest za drogo, zapytaj o koszt niepodjecia decyzji.
Skup sie na wartosci, nie na cenie samej w sobie.

## Obiekcja czasowa

Jesli klient prosi o oferte na pozniej, zaproponuj krotkie 15-minutowe
spotkanie zamiast wysylania dokumentu bez kontekstu.
`

const PSYCHOLOGY_MD = `## Jezyk perswazji

Uzywaj jezyka korzysci, nie cech produktu. Mow o rezultacie, ktory klient
otrzyma, a nie o funkcjach samych w sobie.

## Zakazana sekcja

Wyczuj emocje klienta i dostosuj ton, aby wykryc jego frustracje zanim
sam o niej powie.
`

describe('KnowledgeBase.load chunking and per-section retrieval (PL fixtures)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-'))
    mkdirSync(join(dir, 'sales'))
    writeFileSync(join(dir, 'sales', 'closing.md'), CLOSING_MD)
    writeFileSync(join(dir, 'psychology.md'), PSYCHOLOGY_MD)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('chunks by "## " heading and answers inflected Polish queries', () => {
    const kb = KnowledgeBase.load(dir)
    const hitsExact = kb.search('za drogo')
    expect(hitsExact.length).toBeGreaterThan(0)
    expect(hitsExact[0]?.heading).toBe('Obiekcja cenowa')

    // Inflected variants of "drogi" (drogo/drogie/drogi) should still hit
    // the same section via trigram cosine (Polish-inflection-robust).
    const hitsInflected = kb.search('produkt jest za drogie')
    expect(hitsInflected.length).toBeGreaterThan(0)
    expect(hitsInflected[0]?.heading).toBe('Obiekcja cenowa')
  })

  it('returns top-K results ordered by descending score', () => {
    const kb = KnowledgeBase.load(dir)
    const hits = kb.search('oferta pozniej spotkanie 15 minut', 2)
    expect(hits.length).toBeLessThanOrEqual(2)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
    }
  })

  it('suppresses results below MIN_SCORE rather than guessing', () => {
    const kb = KnowledgeBase.load(dir)
    expect(kb.search('jaka dzis pogoda w warszawie')).toEqual([])
    expect(kb.search('')).toEqual([])
  })

  it('rejects denylisted emotion-inference sections at load and warns without leaking content', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kb = KnowledgeBase.load(dir)

    // The "Zakazana sekcja" heading instructs detecting the prospect's
    // emotions/frustration — must be excluded from the retrievable pool.
    const hits = kb.search('wyczuj emocje klienta wykryc frustracje')
    expect(hits.find((h) => h.heading === 'Zakazana sekcja')).toBeUndefined()

    const warned = warnSpy.mock.calls.some((call) => String(call[0]).includes('Zakazana sekcja'))
    expect(warned).toBe(true)
    // The warn message must not repeat the rejected section's content.
    const leaked = warnSpy.mock.calls.some((call) => String(call[0]).includes('dostosuj ton'))
    expect(leaked).toBe(false)

    warnSpy.mockRestore()
  })

  it('keeps allowed sections in the same file as a rejected section', () => {
    const kb = KnowledgeBase.load(dir)
    const hits = kb.search('jezyk korzysci rezultat klient')
    expect(hits.find((h) => h.heading === 'Jezyk perswazji')).toBeDefined()
  })
})

describe('KnowledgeBase.load preamble-only file (zero "## " sections)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'knowledge-preamble-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('warns with file+path only (no content) when a file yields zero sections', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preambleOnly =
      '# Just a title\n\nSome intro prose with SECRET-CONTENT-marker, no "## " headings at all.\n'
    writeFileSync(join(dir, 'preamble-only.md'), preambleOnly)

    const kb = KnowledgeBase.load(dir)
    expect(kb.size).toBe(0)

    const warned = warnSpy.mock.calls.some(
      (call) => String(call[0]).includes('preamble-only.md') && String(call[0]).includes('zero')
    )
    expect(warned).toBe(true)
    // Never leak the file's actual content into the warn message.
    const leaked = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes('SECRET-CONTENT-marker')
    )
    expect(leaked).toBe(false)

    warnSpy.mockRestore()
  })

  it('does not warn for a file that has at least one "## " section', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dir, 'has-section.md'), '# Title\n\n## Heading\n\nContent.\n')

    KnowledgeBase.load(dir)

    const warned = warnSpy.mock.calls.some((call) => String(call[0]).includes('has-section.md'))
    expect(warned).toBe(false)

    warnSpy.mockRestore()
  })
})

describe('KnowledgeBase.load missing-directory safety', () => {
  it('warns and returns an empty, safe knowledge base when knowledge/ is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingDir = join(tmpdir(), 'knowledge-does-not-exist-' + Date.now())
    const kb = KnowledgeBase.load(missingDir)
    expect(kb.search('cokolwiek')).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('loadCustomerBrief — whole-file, always-injected, never retrieval', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'customers-'))
    writeFileSync(
      join(dir, 'acme.md'),
      '# Acme Sp. z o.o.\n\nKluczowy kontakt: Jan Kowalski. Budzet: 50000 PLN.\n'
    )
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads the whole brief file by name', () => {
    const brief = loadCustomerBrief(dir, 'acme')
    expect(brief).toContain('Jan Kowalski')
    expect(brief).toContain('Acme Sp. z o.o.')
  })

  it('returns null and warns (not throws) when the brief file is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadCustomerBrief(dir, 'does-not-exist')).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('rejects a crafted "../" name and never escapes customersDir (path-traversal regression, 6.1 review)', () => {
    // A sibling file that a naive `join(customersDir, `${name}.md`)` (without
    // `basename()`) could otherwise read via '../<secret>'.
    const secretPath = join(dir, '..', 'secret-outside-customers.md')
    writeFileSync(secretPath, '# Should never be readable via customersDir\n')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const brief = loadCustomerBrief(dir, '../secret-outside-customers')
      expect(brief).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      rmSync(secretPath, { force: true })
      warnSpy.mockRestore()
    }
  })

  it('returns null and warns when the customers/ directory itself is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missingDir = join(tmpdir(), 'customers-does-not-exist-' + Date.now())
    expect(loadCustomerBrief(missingDir, 'acme')).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('never appears in a KnowledgeBase retrieval pool', () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'knowledge-empty-'))
    const kb = KnowledgeBase.load(kbDir)
    const hits = kb.search('Jan Kowalski Acme budzet')
    expect(hits).toEqual([])
    rmSync(kbDir, { recursive: true, force: true })
  })
})
