import type { ConsentState } from '@shared/types'

// Pure display-logic extraction (spec.md §4 item 2 / §5, Plans.md Task 4.1):
// what the consent prompt and REC indicator should show for a given consent
// state, kept separate from overlay.ts (DOM + IPC) so it's testable without
// jsdom — the same pattern health-banner.ts uses for bannerStateFor.

// Re-exported under its historical name so existing imports keep working;
// `ConsentState` (from @shared/types) is the single source of truth for the
// literal union, shared with main's `ConsentGate` and `ConsentRequiredMsg`.
export type ConsentViewState = ConsentState

export interface ConsentPromptView {
  /** Prompt (announcement script + affirm button) shown only while pending. */
  readonly visible: boolean
  readonly announcement: string
  readonly isPlaceholder: boolean
}

export function consentPromptViewFor(
  state: ConsentViewState,
  announcement: string,
  isPlaceholder: boolean
): ConsentPromptView {
  return { visible: state === 'pending', announcement, isPlaceholder }
}

export interface RecIndicatorView {
  /** Persistent recording indicator (spec.md §4 item 2) — visible for the
   *  entire duration capture may be running, i.e. from affirmation onward. */
  readonly visible: boolean
}

export function recIndicatorViewFor(state: ConsentViewState): RecIndicatorView {
  return { visible: state === 'affirmed' }
}
