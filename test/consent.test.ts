import { describe, expect, it, vi } from 'vitest'
import {
  canStartCapture,
  CONSENT_ANNOUNCEMENT_PLACEHOLDER,
  ConsentGate,
  resolveAnnouncement
} from '../src/main/consent'

// Transport-B procedural consent gate (spec.md §4 item 2 / Plans.md Task 4.1):
// capture must not start until the operator affirms, per call, and the
// affirmation is logged with a timestamp — never call content.

describe('canStartCapture', () => {
  it('is false while pending', () => {
    expect(canStartCapture('pending')).toBe(false)
  })

  it('is true once affirmed', () => {
    expect(canStartCapture('affirmed')).toBe(true)
  })
})

describe('ConsentGate', () => {
  it('starts in the pending state', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    expect(gate.state).toBe('pending')
  })

  it('does not run onAffirmed callbacks before affirm() is called', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    const cb = vi.fn()
    gate.onAffirmed(cb)
    expect(cb).not.toHaveBeenCalled()
  })

  it('runs queued onAffirmed callbacks exactly once affirm() is called', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    const cb = vi.fn()
    gate.onAffirmed(cb)
    gate.affirm()
    expect(cb).toHaveBeenCalledTimes(1)
    expect(gate.state).toBe('affirmed')
  })

  it('runs onAffirmed callbacks immediately when already affirmed', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    gate.affirm()
    const cb = vi.fn()
    gate.onAffirmed(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('affirm() logs a record with an ISO timestamp and session id — no call content', () => {
    const writer = vi.fn()
    const now = () => new Date('2026-07-15T12:00:00.000Z')
    const session = () => 'session-fixed-uuid'
    const gate = new ConsentGate({ writer, now, session })
    const record = gate.affirm()

    expect(record).toEqual({
      affirmedAt: '2026-07-15T12:00:00.000Z',
      session: 'session-fixed-uuid'
    })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(record)

    // shape guard: only timestamp + session id, nothing resembling call content
    expect(Object.keys(record).sort()).toEqual(['affirmedAt', 'session'])
  })

  it('affirm() is idempotent — a second call does not re-log or change the record', () => {
    const writer = vi.fn()
    const gate = new ConsentGate({ writer, now: () => new Date('2026-07-15T12:00:00.000Z') })
    const first = gate.affirm()
    const second = gate.affirm()
    expect(second).toEqual(first)
    expect(writer).toHaveBeenCalledTimes(1)
  })
})

describe('resolveAnnouncement', () => {
  it('falls back to the placeholder — clearly marked pending legal review — when unset', () => {
    expect(resolveAnnouncement(undefined)).toEqual({
      text: CONSENT_ANNOUNCEMENT_PLACEHOLDER,
      isPlaceholder: true
    })
  })

  it('falls back to the placeholder for a blank/whitespace-only value', () => {
    expect(resolveAnnouncement('   ')).toEqual({
      text: CONSENT_ANNOUNCEMENT_PLACEHOLDER,
      isPlaceholder: true
    })
  })

  it('never invents wording — uses the configured value verbatim when set', () => {
    const legal = 'Ta rozmowa jest nagrywana w celach szkoleniowych.'
    expect(resolveAnnouncement(legal)).toEqual({ text: legal, isPlaceholder: false })
  })
})
