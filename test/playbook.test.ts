import { describe, expect, it } from 'vitest'
import { Playbook } from '../src/pipeline/playbook'

// Mirrors the shipped playbook.tsv (trigger <TAB> hint).
const TSV = [
  'za drogo\tCena vs koszt zwloki — zapytaj o koszt status quo',
  'musze pogadac z zespolem\tKto jeszcze decyduje? Umow ich na call',
  'wyslij oferte\tNie wysylaj. Umow 15 min na przejscie przez nia',
  'nie mamy teraz budzetu\tKiedy planujecie budzet? Zapytaj o cykl',
  'mamy juz dostawce\tCo bys zmienil w obecnym rozwiazaniu?'
].join('\n')

describe('Playbook trigram matching (Polish inflection)', () => {
  const pb = Playbook.parse(TSV)
  const priceHint = 'Cena vs koszt zwloki — zapytaj o koszt status quo'

  it('drogo / drogie / za drogi all hit the same "za drogo" entry', () => {
    expect(pb.nearest('za drogo')).toBe(priceHint)
    expect(pb.nearest('to jest za drogie')).toBe(priceHint)
    expect(pb.nearest('za drogi produkt')).toBe(priceHint)
  })

  it('below-threshold input returns nothing, not a bad guess', () => {
    expect(pb.nearest('jaka dzis pogoda')).toBeNull()
    expect(pb.nearest('xyz')).toBeNull()
    expect(pb.nearest('')).toBeNull()
  })

  it('distinct objections route to their own hints', () => {
    expect(pb.nearest('musze pogadac z zespolem')).toContain('Kto jeszcze decyduje')
    expect(pb.nearest('nie mamy teraz budzetu')).toContain('Kiedy planujecie budzet')
    expect(pb.nearest('mamy juz dostawce')).toContain('obecnym rozwiazaniu')
  })

  it('ignores blank lines and # comments when parsing', () => {
    const withNoise = `# a comment\n\n${TSV}\n   \n`
    const p = Playbook.parse(withNoise)
    expect(p.nearest('za drogo')).toBe(priceHint)
  })
})
