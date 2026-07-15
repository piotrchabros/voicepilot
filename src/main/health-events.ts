import type { HealthMsg } from '@shared/types'

// Pure conversions from the two SystemAudioSource event shapes into the wire
// HealthMsg the overlay understands. Kept out of pipeline-host.ts (which
// imports electron) so these can be unit-tested directly (spec.md Task 2.4).
// The remaining pipeline-host.ts wiring hop (audioSource.on(...) -> deps.onHealth)
// is electron-only glue with no branching logic — covered by Task 4.2's manual
// QA checklist, not a unit test here.

/** SystemAudioSource's own 'health' event shape (see system-audio-source.ts). */
export interface AudioHealthStatus {
  readonly ok: boolean
  readonly detail: string
}

/** sidecar-missing is a process/binary problem; everything else reported on
 *  this seam so far is a device/permission/stream problem. */
function classifyAudioHealthSource(
  detail: string
): Extract<HealthMsg['source'], 'sidecar' | 'device'> {
  return detail.includes('[sidecar-missing]') ? 'sidecar' : 'device'
}

/** Converts a SystemAudioSource 'health' event into the wire HealthMsg. */
export function audioHealthToMsg(status: AudioHealthStatus): HealthMsg {
  return {
    type: 'health',
    ok: status.ok,
    source: classifyAudioHealthSource(status.detail),
    detail: status.detail
  }
}

/** Converts a SystemAudioSource 'end' event into a HealthMsg — but only for an
 *  unexpected exit. An intentional stop() ('stopped') is not a health event;
 *  reporting it as one would be a false alarm on ordinary shutdown. */
export function audioEndToHealthMsg(reason: string): HealthMsg | null {
  if (reason !== 'exit') return null
  return {
    type: 'health',
    ok: false,
    source: 'sidecar',
    detail: `capture sidecar ended unexpectedly (${reason})`
  }
}
