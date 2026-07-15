import type { SuggestionTransport } from '@shared/types'

// Pure display-logic extraction (mirrors bannerStateFor / consentPromptViewFor):
// the human-readable label for the transport chrome's mode chip (spec.md §5
// "Transport chrome: mode selector..."), kept separate from overlay.ts (DOM)
// so it's testable without jsdom.
//
// v1 only ever wires SystemAudioSource (`transport: 'system'`, spec.md §2) —
// there is no live selector UI yet, just an always-visible label next to REC.
// 'file' and 'twilio' are covered now so this function doesn't need a rewrite
// once bench replay ('file') or PSTN/Transport A ('twilio') actually drive the
// chip; only the caller's constant changes.
export function modeLabelFor(transport: SuggestionTransport): string {
  switch (transport) {
    case 'system':
      return 'System audio'
    case 'file':
      return 'File replay'
    case 'twilio':
      return 'PSTN'
  }
}
