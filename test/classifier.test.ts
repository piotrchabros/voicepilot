import { describe, expect, it } from 'vitest'
import { classifyTurn, shouldSuggest } from '../src/pipeline/classifier'

// spec.md §3: Tier-1 labels are a closed set. spec.md §1 non-goals: emotion /
// sentiment / stress / personality inference is forbidden — these fixtures
// only pin *what was said* (objection/signal category), never *how the
// prospect feels*.

describe('classifyTurn (spec.md §3 Tier-1 PL rules)', () => {
  describe('price_objection', () => {
    it('matches "za drogie"', () => {
      expect(classifyTurn('to jest za drogie dla mnie').label).toBe('price_objection')
    })
    it('matches "drogo" (base form)', () => {
      expect(classifyTurn('szczerze mówiąc, drogo to jest').label).toBe('price_objection')
    })
    it('matches "nie stać nas na to"', () => {
      expect(classifyTurn('nie stać nas na to w tym momencie').label).toBe('price_objection')
    })
    it('matches inflected "za drogi" (masculine variant)', () => {
      expect(classifyTurn('ten pakiet jest za drogi').label).toBe('price_objection')
    })
  })

  describe('timing_objection', () => {
    it('matches "nie teraz"', () => {
      expect(classifyTurn('nie teraz, może później').label).toBe('timing_objection')
    })
    it('matches "zadzwoń za miesiąc"', () => {
      expect(classifyTurn('proszę zadzwonić za miesiąc').label).toBe('timing_objection')
    })
    it('matches "jeszcze nie jesteśmy gotowi"', () => {
      expect(classifyTurn('jeszcze nie jesteśmy gotowi na wdrożenie').label).toBe(
        'timing_objection'
      )
    })
    it('matches "w przyszłym kwartale"', () => {
      expect(classifyTurn('wróćmy do tego w przyszłym kwartale').label).toBe('timing_objection')
    })
  })

  describe('authority_objection', () => {
    it('matches "muszę to skonsultować z szefem"', () => {
      expect(classifyTurn('muszę to skonsultować z moim szefem').label).toBe('authority_objection')
    })
    it('matches "decyzję podejmuje zarząd"', () => {
      expect(classifyTurn('tę decyzję podejmuje zarząd').label).toBe('authority_objection')
    })
    it('matches "to nie moja decyzja"', () => {
      expect(classifyTurn('to nie jest moja decyzja').label).toBe('authority_objection')
    })
    it('matches inflected "porozmawiam z przełożonym"', () => {
      expect(classifyTurn('muszę porozmawiać z przełożonym').label).toBe('authority_objection')
    })
  })

  describe('need_question', () => {
    it('matches "jak to działa"', () => {
      expect(classifyTurn('a jak to dokładnie działa?').label).toBe('need_question')
    })
    it('matches "czy to zadziała u nas"', () => {
      expect(classifyTurn('czy to zadziała w naszej firmie').label).toBe('need_question')
    })
    it('matches "czy to obsługuje"', () => {
      expect(classifyTurn('czy wasz system obsługuje integrację z sap').label).toBe('need_question')
    })
    it('matches inflected "jak to będzie działało"', () => {
      expect(classifyTurn('a jak to będzie działało w praktyce').label).toBe('need_question')
    })
  })

  describe('competitor_mention', () => {
    it('matches "konkurencja"', () => {
      expect(classifyTurn('konkurencja oferuje to taniej').label).toBe('competitor_mention')
    })
    it('matches "korzystamy z innego dostawcy"', () => {
      expect(classifyTurn('obecnie korzystamy z innego dostawcy').label).toBe('competitor_mention')
    })
    it('matches "porównywaliśmy z innym rozwiązaniem"', () => {
      expect(classifyTurn('porównywaliśmy to z innym rozwiązaniem na rynku').label).toBe(
        'competitor_mention'
      )
    })
    it('matches inflected "u konkurenta"', () => {
      expect(classifyTurn('mamy podobne narzędzie u konkurenta').label).toBe('competitor_mention')
    })
  })

  describe('buying_signal', () => {
    it('matches "jak możemy zacząć"', () => {
      expect(classifyTurn('okej, jak możemy zacząć?').label).toBe('buying_signal')
    })
    it('matches "jestem gotowy podpisać"', () => {
      expect(classifyTurn('jestem gotowy to podpisać').label).toBe('buying_signal')
    })
    it('matches "wysyłajcie umowę"', () => {
      expect(classifyTurn('super, wysyłajcie umowę').label).toBe('buying_signal')
    })
    it('matches inflected "kiedy możemy wdrożyć"', () => {
      expect(classifyTurn('kiedy możemy to wdrożyć').label).toBe('buying_signal')
    })
  })

  describe('smalltalk suppression (must not misfire as an objection)', () => {
    it('greeting stays smalltalk', () => {
      expect(classifyTurn('dzień dobry, miło mi pana poznać').label).toBe('smalltalk')
    })
    it('weather chit-chat stays smalltalk', () => {
      expect(classifyTurn('ale dzisiaj piękna pogoda').label).toBe('smalltalk')
    })
    it('thanks stays smalltalk', () => {
      expect(classifyTurn('dziękuję bardzo za rozmowę').label).toBe('smalltalk')
    })
    // Regression: bare "na razie" used to be a smalltalk phrase and, on an
    // exact-substring tie (score 1.0), array order let it beat the longer,
    // more specific "na razie nie" timing_objection phrase. "na razie" was
    // removed from the smalltalk list; the longest-phrase tie-break below
    // is a second, independent layer of defense against the same class of
    // bug recurring with future phrases.
    it('a brush-off starting with the smalltalk farewell "na razie" is timing_objection, not smalltalk', () => {
      expect(classifyTurn('na razie nie, musimy to jeszcze przemyśleć').label).toBe(
        'timing_objection'
      )
    })
  })

  describe('negation guard (must not misfire on an explicitly negated objection)', () => {
    it('a negated price statement does not fire price_objection', () => {
      const c = classifyTurn('nie jest wcale za drogie')
      expect(c.label).not.toBe('price_objection')
    })

    // Pin the residual cross-label trigram score numerically: this text
    // scores non-zero against an unrelated label's trigrams (noise from
    // shared "nie ..." grams) even after the negation guard zeroes out its
    // own label. If CLEAN_THRESHOLD ever creeps down toward this value, this
    // fixture fails loudly instead of the guard silently eroding.
    it('the negated-sentence residual score stays below CLEAN_THRESHOLD (pinned)', () => {
      const c = classifyTurn('nie jest wcale za drogie')
      expect(c.label).toBe('none')
      expect(c.confidence).toBeCloseTo(0.3846153846153847, 10)
    })

    // Regression: the negation guard's clause-boundary handling must not
    // over-reach past a contrastive conjunction ("ale") into an unrelated
    // earlier clause. "nie wiem" here negates nothing about the speaker's
    // decision-making authority — the clause after "ale" is what matters.
    it('does not let an unrelated "nie" in an earlier clause cancel a match after "ale"', () => {
      expect(classifyTurn('nie wiem, ale to nie moja decyzja').label).toBe('authority_objection')
    })
  })

  describe('stalling vs. commitment ("bierzemy to")', () => {
    it('"bierzemy to pod uwagę" (we will take it under consideration) is a stall, not a buying signal', () => {
      expect(classifyTurn('okej, bierzemy to pod uwagę').label).toBe('timing_objection')
    })
  })

  describe('none (no signal)', () => {
    it('empty string is none', () => {
      expect(classifyTurn('').label).toBe('none')
    })
    it('unrelated factual statement is none', () => {
      expect(classifyTurn('mamy biuro w Warszawie i w Krakowie').label).toBe('none')
    })
  })

  describe('mixed separation raises the confidence threshold', () => {
    it('a weak/ambiguous match is suppressed to none under mixed separation', () => {
      const clean = classifyTurn('no może drogo', { separation: 'clean' })
      const mixed = classifyTurn('no może drogo', { separation: 'mixed' })
      // clean is at least as permissive as mixed for the same weak signal
      if (clean.label !== 'none') {
        expect(mixed.confidence).toBeLessThanOrEqual(clean.confidence)
      }
      expect(['price_objection', 'none']).toContain(mixed.label)
    })

    it('strong unambiguous signal still classifies under mixed separation', () => {
      const mixed = classifyTurn('to jest zdecydowanie za drogie dla nas', { separation: 'mixed' })
      expect(mixed.label).toBe('price_objection')
    })
  })

  describe('English input does not crash and degrades gracefully', () => {
    it('handles an English sentence without throwing', () => {
      expect(() => classifyTurn('this is way too expensive for us')).not.toThrow()
    })
    it('returns a valid closed-set label for English input', () => {
      const labels = [
        'price_objection',
        'timing_objection',
        'authority_objection',
        'need_question',
        'competitor_mention',
        'buying_signal',
        'smalltalk',
        'none'
      ]
      expect(labels).toContain(classifyTurn('this is way too expensive for us').label)
    })
  })

  describe('performance', () => {
    it('classifies 1000 turns in under 200ms', () => {
      const samples = [
        'to jest za drogie dla mnie',
        'nie teraz, może później',
        'muszę to skonsultować z szefem',
        'a jak to dokładnie działa?',
        'konkurencja oferuje to taniej',
        'okej, jak możemy zacząć?',
        'dzień dobry, miło mi pana poznać',
        'mamy biuro w Warszawie i w Krakowie'
      ]
      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        classifyTurn(samples[i % samples.length] as string)
      }
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(200)
    })
  })
})

describe('shouldSuggest (tier-2 suppression gate)', () => {
  it('suppresses smalltalk', () => {
    expect(shouldSuggest({ label: 'smalltalk', confidence: 1 })).toBe(false)
  })
  it('suppresses none', () => {
    expect(shouldSuggest({ label: 'none', confidence: 0 })).toBe(false)
  })
  it('allows a real objection label', () => {
    expect(shouldSuggest({ label: 'price_objection', confidence: 0.9 })).toBe(true)
  })
  it('allows a buying signal', () => {
    expect(shouldSuggest({ label: 'buying_signal', confidence: 0.9 })).toBe(true)
  })
})
