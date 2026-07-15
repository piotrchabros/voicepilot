import type { HealthMsg } from '@shared/types'

// Pure display-logic extraction: what the health banner should show for a
// given HealthMsg. Kept separate from overlay.ts (DOM + timers) so it's
// testable without jsdom (spec.md Task 2.4).

export interface BannerState {
  readonly visible: boolean
  readonly text: string
}

export function bannerStateFor(health: HealthMsg): BannerState {
  if (health.ok) return { visible: false, text: '' }
  return { visible: true, text: `⚠ ${health.detail}` }
}
