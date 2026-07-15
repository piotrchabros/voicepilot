import type { ConsentRequiredMsg, CopilotBridge, HealthMsg, Hint } from '@shared/types'
import { bannerStateFor } from './health-banner'
import { consentPromptViewFor, type ConsentViewState, recIndicatorViewFor } from './consent-view'

// The renderer paints hints, shows a health banner, and manages the
// Transport-B consent gate UI (spec.md §4 item 2 / §5, Plans.md Task 4.1): a
// consent prompt until the operator affirms, then a persistent REC
// indicator. Coalescing at ~30Hz for hints happens naturally because we only
// touch the DOM on an event.
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
const consentPrompt = document.getElementById('consent-prompt') as HTMLDivElement
const consentAnnouncementEl = document.getElementById('consent-announcement') as HTMLSpanElement
const consentAffirmBtn = document.getElementById('consent-affirm-btn') as HTMLButtonElement
const recIndicator = document.getElementById('rec-indicator') as HTMLDivElement

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

// Local consent view state — the DOM's source of truth for the prompt/REC
// toggle. Updated optimistically on affirm (main's ConsentGate.affirm() is
// synchronous, so there's no round trip to wait on) and authoritatively from
// `msg.state` on the initial `consent-required` message — *not* hardcoded to
// 'pending', so a reload mid-call (operator already affirmed) restores the
// REC indicator instead of re-showing the prompt (reviewer note).
let consentState: ConsentViewState = 'pending'

function renderConsent(msg: ConsentRequiredMsg): void {
  consentState = msg.state
  const prompt = consentPromptViewFor(consentState, msg.announcement, msg.isPlaceholder)
  consentAnnouncementEl.textContent = prompt.announcement
  consentPrompt.classList.toggle('visible', prompt.visible)
  consentPrompt.classList.toggle('placeholder', prompt.isPlaceholder)
  renderRecIndicator()
}

function renderRecIndicator(): void {
  const rec = recIndicatorViewFor(consentState)
  recIndicator.classList.toggle('visible', rec.visible)
}

consentAffirmBtn.addEventListener('click', () => {
  window.copilot.affirmConsent()
  consentState = 'affirmed'
  consentPrompt.classList.remove('visible')
  renderRecIndicator()
})

window.copilot.onHint(render)
window.copilot.onHealth(renderHealth)
window.copilot.onConsentRequired(renderConsent)
// Tell main the subscription is live so no early hint/health/consent message is dropped.
window.copilot.ready()
