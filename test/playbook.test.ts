import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Playbook } from '../src/pipeline/playbook'

// Mirrors the shipped playbook/objections.yaml (id/trigger/headline/line/detail/phrases).
const YAML = `
entries:
  - id: price_objection_status_quo
    trigger: price_objection
    headline: Cena vs koszt zwloki
    line: zapytaj o koszt status quo
    phrases:
      - za drogo
      - za drogie
      - za drogi
  - id: authority_objection_team
    trigger: authority_objection
    headline: Kto jeszcze decyduje
    line: umow ich na call
    phrases:
      - musze pogadac z zespolem
  - id: timing_objection_send_offer
    trigger: timing_objection
    headline: Nie wysylaj oferty
    line: umow 15 min na przejscie przez nia
    phrases:
      - wyslij oferte
  - id: timing_objection_budget
    trigger: timing_objection
    headline: Kiedy budzet
    line: zapytaj o cykl
    phrases:
      - nie mamy teraz budzetu
  - id: competitor_mention_existing_vendor
    trigger: competitor_mention
    headline: Co zmienic w rozwiazaniu
    line: co bys zmienil w obecnym rozwiazaniu
    phrases:
      - mamy juz dostawce
`

describe('Playbook.fromYaml trigram matching (Polish inflection)', () => {
  const pb = Playbook.fromYaml(YAML)
  const priceHeadline = 'Cena vs koszt zwloki'
  const priceLine = 'zapytaj o koszt status quo'

  it('drogo / drogie / za drogi all hit the same price_objection entry', () => {
    expect(pb.nearestPlay('za drogo')).toEqual({
      id: 'price_objection_status_quo',
      headline: priceHeadline,
      line: priceLine,
      detail: undefined
    })
    expect(pb.nearestPlay('to jest za drogie')?.id).toBe('price_objection_status_quo')
    expect(pb.nearestPlay('za drogi produkt')?.id).toBe('price_objection_status_quo')
  })

  it('below-threshold input returns nothing, not a bad guess', () => {
    expect(pb.nearestPlay('jaka dzis pogoda')).toBeNull()
    expect(pb.nearestPlay('xyz')).toBeNull()
    expect(pb.nearestPlay('')).toBeNull()
  })

  it('distinct objections route to their own plays', () => {
    expect(pb.nearestPlay('musze pogadac z zespolem')?.headline).toBe('Kto jeszcze decyduje')
    expect(pb.nearestPlay('nie mamy teraz budzetu')?.headline).toBe('Kiedy budzet')
    expect(pb.nearestPlay('mamy juz dostawce')?.line).toContain('obecnym rozwiazaniu')
  })

  it('nearest() legacy API returns "headline — line" combined string', () => {
    expect(pb.nearest('za drogo')).toBe(`${priceHeadline} — ${priceLine}`)
    expect(pb.nearest('jaka dzis pogoda')).toBeNull()
  })
})

describe('Playbook.fromYaml directory loading', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('loads and merges every *.yaml file in a directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'playbook-yaml-'))
    writeFileSync(
      join(dir, 'objections.yaml'),
      `entries:\n  - id: a\n    trigger: price_objection\n    headline: H1\n    line: L1\n    phrases: [za drogo]\n`
    )
    writeFileSync(
      join(dir, 'signals.yaml'),
      `entries:\n  - id: b\n    trigger: buying_signal\n    headline: H2\n    line: L2\n    phrases: [kiedy zaczynamy]\n`
    )
    const pb = Playbook.fromYaml(dir)
    expect(pb.nearestPlay('za drogo')?.id).toBe('a')
    expect(pb.nearestPlay('kiedy zaczynamy')?.id).toBe('b')
  })
})

describe('Playbook.fromYaml schema validation', () => {
  it('throws when a required field is missing', () => {
    const missingHeadline = `entries:\n  - id: x\n    trigger: price_objection\n    line: L1\n    phrases: [za drogo]\n`
    expect(() => Playbook.fromYaml(missingHeadline)).toThrow(/headline/i)

    const missingPhrases = `entries:\n  - id: x\n    trigger: price_objection\n    headline: H\n    line: L1\n`
    expect(() => Playbook.fromYaml(missingPhrases)).toThrow(/phrases/i)

    const missingId = `entries:\n  - trigger: price_objection\n    headline: H\n    line: L1\n    phrases: [za drogo]\n`
    expect(() => Playbook.fromYaml(missingId)).toThrow(/id/i)
  })

  it('throws on an unknown trigger label', () => {
    const badTrigger = `entries:\n  - id: x\n    trigger: not_a_real_label\n    headline: H\n    line: L1\n    phrases: [za drogo]\n`
    expect(() => Playbook.fromYaml(badTrigger)).toThrow(/trigger/i)
  })

  it('ignores blank yaml (no entries) and returns an empty playbook', () => {
    const p = Playbook.fromYaml('entries: []')
    expect(p.nearestPlay('za drogo')).toBeNull()
  })
})
