import type { CopilotBridge, HealthMsg, Hint } from '@shared/types'
import { bannerStateFor } from './health-banner'

// The renderer does exactly two things: paint hints, and show a health
// banner. No other state, no other logic. Coalescing at ~30Hz happens
// naturally because we only touch the DOM on an event.
declare global {
  interface Window {
    copilot: CopilotBridge
  }
}

// How long an ok:false health banner stays up before it auto-dismisses, even
// without an explicit ok:true recovery event (spec.md Task 2.4).
const HEALTH_BANNER_TIMEOUT_MS = 10_000

const pill = document.getElementById('pill') as HTMLDivElement
const hintEl = document.getElementById('hint') as HTMLSpanElement
const healthPill = document.getElementById('health-pill') as HTMLDivElement
const healthEl = document.getElementById('health') as HTMLSpanElement

let healthTimer: ReturnType<typeof setTimeout> | null = null

function render(hint: Hint): void {
  const text = hint.text.trim()
  hintEl.textContent = text
  // Dim the guess, brighten the earned answer — so the eye learns to trust the
  // bright one without reading either.
  hintEl.classList.toggle('generated', hint.source === 'GENERATED')
  pill.classList.toggle('visible', text.length > 0 && text !== '-')
}

// The visible/text decision itself is pure (bannerStateFor, unit-tested
// without jsdom); the DOM writes and the auto-dismiss timer below are the one
// part of this file that isn't — they're covered by Task 4.2's manual QA
// checklist instead.
function renderHealth(health: HealthMsg): void {
  if (healthTimer !== null) {
    clearTimeout(healthTimer)
    healthTimer = null
  }
  const state = bannerStateFor(health)
  healthEl.textContent = state.text
  healthPill.classList.toggle('visible', state.visible)
  if (state.visible) {
    healthTimer = setTimeout(() => {
      healthPill.classList.remove('visible')
      healthTimer = null
    }, HEALTH_BANNER_TIMEOUT_MS)
  }
}

window.copilot.onHint(render)
window.copilot.onHealth(renderHealth)
// Tell main the subscription is live so no early hint is dropped.
window.copilot.ready()
