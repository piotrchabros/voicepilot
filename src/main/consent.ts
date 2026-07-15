import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConsentState } from '@shared/types'

/**
 * Transport-B procedural consent gate (spec.md §4 item 2 / §5, Plans.md Task
 * 4.1): capture must not start until the operator affirms, per call, that
 * the consent announcement has been given. The affirmation is logged with a
 * timestamp + session id — deliberately never the call content (spec.md §4
 * item 4: no transcript/hint text in logs outside explicit debug mode).
 */

// Re-exported so existing callers importing ConsentState from here (rather
// than @shared/types directly) keep working — @shared/types is the single
// source of truth for the literal union (shared with consent-view.ts,
// renderer-side, and ConsentRequiredMsg on the wire).
export type { ConsentState } from '@shared/types'

/** What gets logged on affirmation. Timestamp + session id only — no call content. */
export interface ConsentRecord {
  readonly affirmedAt: string // ISO 8601
  readonly session: string // one id per gate instance, not tied to call content
}

export type ConsentWriter = (record: ConsentRecord) => void

const CONSENT_LOG_DIR = join(homedir(), '.copilot')
const CONSENT_LOG_PATH = join(CONSENT_LOG_DIR, 'consent-log.jsonl')

/** Default writer: append-only JSONL at ~/.copilot/consent-log.jsonl. */
function defaultWriter(record: ConsentRecord): void {
  mkdirSync(CONSENT_LOG_DIR, { recursive: true })
  appendFileSync(CONSENT_LOG_PATH, `${JSON.stringify(record)}\n`)
}

export interface ConsentGateOptions {
  /** Defaults to appending to ~/.copilot/consent-log.jsonl. Inject a fake for tests. */
  writer?: ConsentWriter
  /** Defaults to `() => new Date()`. Inject for deterministic tests. */
  now?: () => Date
  /** Defaults to `randomUUID`. Inject for deterministic tests. */
  session?: () => string
}

/** Pure predicate: may capture (`audioSource.start()`) begin for this state? */
export function canStartCapture(state: ConsentState): boolean {
  return state === 'affirmed'
}

/**
 * Per-call consent gate. `pipeline-host.ts` holds `audioSource.start()`
 * behind `onAffirmed` — capture never begins before the operator affirms
 * (spec.md §4 item 2). `affirm()` is idempotent: a second call is a no-op
 * that returns the original record, so a double-click can't log twice or
 * re-run queued start callbacks.
 */
export class ConsentGate {
  private stateValue: ConsentState = 'pending'
  private record: ConsentRecord | null = null
  private readonly writer: ConsentWriter
  private readonly now: () => Date
  private readonly session: () => string
  private readonly waiters: Array<() => void> = []

  constructor(options: ConsentGateOptions = {}) {
    this.writer = options.writer ?? defaultWriter
    this.now = options.now ?? (() => new Date())
    this.session = options.session ?? randomUUID
  }

  get state(): ConsentState {
    return this.stateValue
  }

  /**
   * Operator affirms consent for this call. Logs {affirmedAt, session} via
   * the injected writer *before* flipping to 'affirmed' and running any
   * `onAffirmed` callbacks — a write failure (e.g. disk full, unwritable
   * `~/.copilot`) must never silently start capture. If `writer` throws, the
   * state stays 'pending', no record is retained, and the error propagates
   * to the caller (reviewer note, Plans.md Task 4.1): a failed log means
   * consent isn't affirmed yet, not "affirmed but unlogged".
   */
  affirm(): ConsentRecord {
    if (this.record !== null) return this.record
    const record: ConsentRecord = {
      affirmedAt: this.now().toISOString(),
      session: this.session()
    }
    this.writer(record) // throws -> state stays 'pending', nothing below runs
    this.record = record
    this.stateValue = 'affirmed'
    const queued = this.waiters.splice(0)
    for (const wake of queued) wake()
    return record
  }

  /** Runs `cb` once affirmed — immediately if already affirmed, otherwise
   *  queued until `affirm()` fires. This is the gate `pipeline-host.ts` uses
   *  to hold `audioSource.start()` until the operator affirms — capture must
   *  not start before affirmation (spec.md §4 item 2 / Plans.md Task 4.1). */
  onAffirmed(cb: () => void): void {
    if (canStartCapture(this.stateValue)) {
      cb()
      return
    }
    this.waiters.push(cb)
  }
}

/**
 * Wires the consent gate to a capture-start callback. Extracted as pure
 * logic (reviewer note, Plans.md Task 4.1) so the consent -> capture-start
 * wiring is unit-testable without spinning up `pipeline-host.ts`'s Electron
 * utilityProcess / llama-server / sidecar dependencies. `pipeline-host.ts`
 * calls this with `() => void audioSource.start()`.
 */
export function wireCaptureStart(
  gate: ConsentGate,
  start: () => void,
  log: (msg: string) => void
): void {
  log(
    canStartCapture(gate.state)
      ? 'consent already affirmed for this call — starting audio capture'
      : 'awaiting operator consent affirmation before starting audio capture'
  )
  gate.onAffirmed(start)
}

/** Clearly-marked placeholder per docs/compliance.md item 4's placeholder
 *  policy — never a guess at the real wording, and never played to a
 *  real prospect (spec.md §4 item 2: wording is a legal deliverable). */
export const CONSENT_ANNOUNCEMENT_PLACEHOLDER = '[consent announcement pending legal review]'

export interface ConsentAnnouncement {
  readonly text: string
  readonly isPlaceholder: boolean
}

/**
 * Resolves the on-screen announcement script (spec.md §4 item 2 / §5). The
 * real wording is a legal deliverable (docs/compliance.md item 4) — this
 * function never invents it. Unset/blank falls back to
 * `CONSENT_ANNOUNCEMENT_PLACEHOLDER`; callers should warn at boot when that
 * happens (see `resolveAnnouncement`'s caller in `index.ts`).
 */
export function resolveAnnouncement(envValue: string | undefined): ConsentAnnouncement {
  const trimmed = envValue?.trim()
  if (trimmed !== undefined && trimmed.length > 0) return { text: trimmed, isPlaceholder: false }
  return { text: CONSENT_ANNOUNCEMENT_PLACEHOLDER, isPlaceholder: true }
}
