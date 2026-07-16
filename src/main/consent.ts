import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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

/**
 * Processor set covered by a consent affirmation (spec.md §4 item 8): the
 * second data processor (cloud analysis LLM) is a legal boundary — an old
 * affirmation must not silently cover a new data flow, so the record states
 * exactly what was affirmed. `soniox+llm` today means "a customer brief was
 * selected"; TODO(6.4) OR-in the cloud-analysis feature flag once it lands
 * so a brief-less call with cloud analysis enabled also affirms `soniox+llm`
 * (Plans.md Task 6.7 / spec.md §7).
 */
export type ProcessorSet = 'soniox' | 'soniox+llm'

/** See {@link ProcessorSet} — `hasBrief` is whether a customer brief was
 *  selected on the pre-Start consent screen (Plans.md Task 6.7). */
export function processorSetFor(hasBrief: boolean): ProcessorSet {
  return hasBrief ? 'soniox+llm' : 'soniox'
}

/**
 * Maps an operator's pre-Start customer-brief dropdown selection to
 * `InitMsg.customerBrief` (Plans.md Task 6.7): "none" (`null`, the default)
 * must not surface as an empty-string field — it's simply absent, matching
 * InitMsg's optional-field contract. A selected name passes through
 * unchanged. Pure so it's testable without pipeline-host.ts's Electron
 * utilityProcess wiring.
 */
export function resolveInitCustomerBrief(selected: string | null): string | undefined {
  return selected ?? undefined
}

/**
 * Sanitizes an operator-selected customer-brief name arriving over the
 * renderer -> main `consent:affirm` IPC channel (Plans.md Task 6.7).
 * `basename()` guards against path traversal via a crafted payload — the
 * same defense `loadCustomerBrief` (src/pipeline/knowledge.ts) applies at
 * the file-read boundary; this applies it earlier, at the IPC boundary.
 * Null/undefined/blank all mean "none selected" (the safe default).
 */
export function sanitizeCustomerBriefSelection(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return basename(trimmed)
}

/**
 * Validates a sanitized customer-brief selection against the enumerated
 * `listCustomerBriefs()` output (reviewer finding on commit cc11c18, Task
 * 6.7 MINOR C): an unknown/nonexistent basename must not silently claim the
 * second-processor consent scope — `processorSetFor` would over-report
 * `soniox+llm` for a brief that doesn't actually exist. Unknown names
 * collapse to `null` ("none"), same as if nothing had been selected.
 */
export function resolveKnownCustomerBrief(
  sanitized: string | null,
  known: readonly string[]
): string | null {
  if (sanitized === null) return null
  return known.includes(sanitized) ? sanitized : null
}

/** What gets logged on affirmation. Timestamp + session id + the processor
 *  set covered — deliberately never the customer-brief name itself (spec.md
 *  §4 item 4 log hygiene: personal data stays out of this record too). */
export interface ConsentRecord {
  readonly affirmedAt: string // ISO 8601
  readonly session: string // one id per gate instance, not tied to call content
  readonly processors: ProcessorSet // spec.md §4 item 8: what this affirmation covered
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
   * Operator affirms consent for this call. Logs {affirmedAt, session,
   * processors} via the injected writer *before* flipping to 'affirmed' and
   * running any `onAffirmed` callbacks — a write failure (e.g. disk full,
   * unwritable `~/.copilot`) must never silently start capture. If `writer`
   * throws, the state stays 'pending', no record is retained, and the error
   * propagates to the caller (reviewer note, Plans.md Task 4.1): a failed
   * log means consent isn't affirmed yet, not "affirmed but unlogged".
   *
   * `processors` (Plans.md Task 6.7 / spec.md §4 item 8) is the processor
   * set this affirmation covers — defaults to `'soniox'` (no second
   * processor) so existing no-arg callers keep their prior behavior.
   * `affirm()` is idempotent regardless of the argument on a second call: a
   * double-click, or a late brief-selection change after the operator
   * already affirmed, can't retroactively widen what was affirmed ("no
   * mid-call switching").
   */
  affirm(processors: ProcessorSet = 'soniox'): ConsentRecord {
    if (this.record !== null) return this.record
    const record: ConsentRecord = {
      affirmedAt: this.now().toISOString(),
      session: this.session(),
      processors
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
 * State-mutation logic behind the `consent:affirm` IPC handler in
 * `index.ts` (reviewer findings on commit cc11c18, Task 6.7: MAJOR B +
 * MINOR C). Extracted as a pure function (no ipcMain/overlay dependency) so
 * both fixes are unit-testable directly:
 *
 * - MAJOR B: once `gate.state === 'affirmed'`, a replayed/late
 *   `consent:affirm` IPC event must not change the locked-in selection —
 *   `ConsentGate.affirm()` is already idempotent for the *logged* record,
 *   but without this guard the caller's `selectedCustomerBrief` variable
 *   (which feeds `InitMsg.customerBrief`) could still be reassigned to a
 *   brief the operator never actually affirmed for.
 * - MINOR C: `resolveKnownCustomerBrief` rejects any selection that isn't
 *   in the enumerated `known` list before it can influence
 *   `processorSetFor`'s `soniox+llm` claim.
 *
 * Returns `record: null` when the replay guard fired (nothing new was
 * logged) so the caller can tell "already affirmed, ignored" apart from "a
 * fresh affirmation just happened".
 */
export function handleConsentAffirm(
  gate: ConsentGate,
  rawCustomerBrief: string | null | undefined,
  currentSelection: string | null,
  knownCustomerBriefs: readonly string[]
): { selection: string | null; record: ConsentRecord | null } {
  if (gate.state === 'affirmed') {
    return { selection: currentSelection, record: null }
  }
  const selection = resolveKnownCustomerBrief(
    sanitizeCustomerBriefSelection(rawCustomerBrief),
    knownCustomerBriefs
  )
  const record = gate.affirm(processorSetFor(selection !== null))
  return { selection, record }
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
