import { describe, expect, it, vi } from 'vitest'
import {
  canStartCapture,
  CONSENT_ANNOUNCEMENT_PLACEHOLDER,
  ConsentGate,
  handleConsentAffirm,
  processorSetFor,
  resolveAnnouncement,
  resolveInitCustomerBrief,
  resolveKnownCustomerBrief,
  sanitizeCustomerBriefSelection,
  wireCaptureStart
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
      session: 'session-fixed-uuid',
      processors: 'soniox'
    })
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(record)

    // shape guard: timestamp + session id + processor set — nothing resembling
    // call content, and never the customer-brief name itself (Plans.md Task
    // 6.7 / spec.md §4 item 8: the record lists the processor set covered,
    // not personal data).
    expect(Object.keys(record).sort()).toEqual(['affirmedAt', 'processors', 'session'])
  })

  it('affirm(processors) records the processor set the affirmation covers (Task 6.7)', () => {
    const writer = vi.fn()
    const now = () => new Date('2026-07-15T12:00:00.000Z')
    const gate = new ConsentGate({ writer, now })
    const record = gate.affirm('soniox+llm')

    expect(record.processors).toBe('soniox+llm')
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ processors: 'soniox+llm' }))
  })

  it('affirm() is idempotent — a second call does not re-log or change the record', () => {
    const writer = vi.fn()
    const gate = new ConsentGate({ writer, now: () => new Date('2026-07-15T12:00:00.000Z') })
    const first = gate.affirm()
    const second = gate.affirm()
    expect(second).toEqual(first)
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('propagates a write failure and stays pending — a failed log must never silently start capture', () => {
    const writer = vi.fn(() => {
      throw new Error('disk full')
    })
    const gate = new ConsentGate({ writer })
    const cb = vi.fn()
    gate.onAffirmed(cb)

    expect(() => gate.affirm()).toThrow('disk full')
    expect(gate.state).toBe('pending')
    expect(cb).not.toHaveBeenCalled()
  })

  it('allows a retry after a failed affirm() — a subsequent successful write does affirm', () => {
    let shouldFail = true
    const writer = vi.fn(() => {
      if (shouldFail) throw new Error('disk full')
    })
    const gate = new ConsentGate({ writer, now: () => new Date('2026-07-15T12:00:00.000Z') })

    expect(() => gate.affirm()).toThrow('disk full')
    expect(gate.state).toBe('pending')

    shouldFail = false
    const record = gate.affirm()
    expect(gate.state).toBe('affirmed')
    expect(record).toEqual({
      affirmedAt: '2026-07-15T12:00:00.000Z',
      session: expect.any(String),
      processors: 'soniox'
    })
    expect(writer).toHaveBeenCalledTimes(2)
  })
})

describe('wireCaptureStart', () => {
  it('does not call start() before affirm() — only registers for later', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    const start = vi.fn()
    const log = vi.fn()

    wireCaptureStart(gate, start, log)

    expect(start).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('awaiting operator consent affirmation')
    )
  })

  it('calls start() exactly once after affirm() fires', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    const start = vi.fn()
    const log = vi.fn()

    wireCaptureStart(gate, start, log)
    expect(start).not.toHaveBeenCalled()

    gate.affirm()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('calls start() immediately when the gate is already affirmed', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    gate.affirm()
    const start = vi.fn()
    const log = vi.fn()

    wireCaptureStart(gate, start, log)

    expect(start).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already affirmed'))
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

// Customer-brief selection (spec.md §7 / §4 item 8, Plans.md Task 6.7):
// pre-Start consent dropdown, default none, extends the per-call affirmation
// record with the processor set it covered.

describe('processorSetFor', () => {
  it('is "soniox" alone when no brief is selected (none-path safety)', () => {
    expect(processorSetFor(false)).toBe('soniox')
  })

  it('is "soniox+llm" when a brief is selected', () => {
    expect(processorSetFor(true)).toBe('soniox+llm')
  })
})

describe('resolveInitCustomerBrief', () => {
  it('maps no selection (null) to undefined — InitMsg.customerBrief stays unset', () => {
    expect(resolveInitCustomerBrief(null)).toBeUndefined()
  })

  it('passes a selected name through unchanged', () => {
    expect(resolveInitCustomerBrief('acme')).toBe('acme')
  })
})

describe('sanitizeCustomerBriefSelection', () => {
  it('maps null/undefined/blank to null — "none" selected', () => {
    expect(sanitizeCustomerBriefSelection(null)).toBeNull()
    expect(sanitizeCustomerBriefSelection(undefined)).toBeNull()
    expect(sanitizeCustomerBriefSelection('   ')).toBeNull()
    expect(sanitizeCustomerBriefSelection('')).toBeNull()
  })

  it('passes a plain name through', () => {
    expect(sanitizeCustomerBriefSelection('acme')).toBe('acme')
  })

  it('strips any path traversal via basename() — same defense as loadCustomerBrief', () => {
    expect(sanitizeCustomerBriefSelection('../../etc/passwd')).toBe('passwd')
    expect(sanitizeCustomerBriefSelection('../../secret')).toBe('secret')
  })
})

// Reviewer findings on commit cc11c18 (Task 6.7): MAJOR B (replayed
// consent:affirm must not swap the brief after affirmation) and MINOR C
// (unknown/nonexistent brief names must not claim the second-processor
// consent scope).

describe('resolveKnownCustomerBrief', () => {
  it('passes a known (enumerated) name through unchanged', () => {
    expect(resolveKnownCustomerBrief('acme', ['acme', 'globex'])).toBe('acme')
  })

  it('collapses an unknown/nonexistent name to null — no compliance over-claim (Task 6.7 MINOR C)', () => {
    expect(resolveKnownCustomerBrief('does-not-exist', ['acme', 'globex'])).toBeNull()
  })

  it('null stays null regardless of the known list', () => {
    expect(resolveKnownCustomerBrief(null, ['acme'])).toBeNull()
    expect(resolveKnownCustomerBrief(null, [])).toBeNull()
  })
})

describe('handleConsentAffirm', () => {
  it('affirms with a known brief selection — processors soniox+llm', () => {
    const writer = vi.fn()
    const gate = new ConsentGate({ writer })
    const result = handleConsentAffirm(gate, 'acme', null, ['acme', 'globex'])

    expect(result.selection).toBe('acme')
    expect(result.record?.processors).toBe('soniox+llm')
    expect(gate.state).toBe('affirmed')
  })

  it('an unknown brief name affirms as "none" — processors soniox, customerBrief stays undefined (Task 6.7 MINOR C)', () => {
    const writer = vi.fn()
    const gate = new ConsentGate({ writer })
    const result = handleConsentAffirm(gate, 'does-not-exist', null, ['acme', 'globex'])

    expect(result.selection).toBeNull()
    expect(resolveInitCustomerBrief(result.selection)).toBeUndefined()
    expect(result.record?.processors).toBe('soniox')
  })

  it('affirms with no selection — processors soniox (none-path safety)', () => {
    const gate = new ConsentGate({ writer: vi.fn() })
    const result = handleConsentAffirm(gate, null, null, ['acme'])

    expect(result.selection).toBeNull()
    expect(result.record?.processors).toBe('soniox')
  })

  it('a replayed consent:affirm after the gate is already affirmed does not change the selection or re-log (Task 6.7 MAJOR B)', () => {
    const writer = vi.fn()
    const gate = new ConsentGate({ writer })
    const first = handleConsentAffirm(gate, 'acme', null, ['acme', 'globex'])
    expect(first.record).not.toBeNull()
    expect(writer).toHaveBeenCalledTimes(1)

    // A second (replayed / malicious) IPC event tries to swap the brief
    // after the operator already affirmed — must be ignored entirely: no
    // new record, no selection change, so InitMsg can never diverge from
    // what the (already-written) ConsentRecord.processors covers.
    const replay = handleConsentAffirm(gate, 'globex', first.selection, ['acme', 'globex'])

    expect(replay.selection).toBe('acme') // unchanged — still the original
    expect(replay.record).toBeNull() // no new write
    expect(writer).toHaveBeenCalledTimes(1) // still just the one log line
  })
})
