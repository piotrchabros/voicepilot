import type {
  ConsentRequiredMsg,
  CopilotBridge,
  HealthMsg,
  Hint,
  SuggestionTransport
} from '@shared/types'
import { bannerStateFor } from './health-banner'
import {
  consentPromptViewFor,
  type ConsentViewState,
  customerBriefOptionsFor,
  recIndicatorViewFor
} from './consent-view'
import { hintDisplayFor } from './hint-view'
import { modeLabelFor } from './mode-chip'

// The renderer paints hints, shows a health banner, and manages the
// Transport-B consent gate UI (spec.md §4 item 2 / §5, Plans.md Task 4.1): a
// consent prompt until the operator affirms, then a persistent REC
// indicator. Coalescing at ~30Hz for hints happens naturally because we only
// touch the DOM on an event. Task 4.2 adds the always-on mode chip and the
// two-line suggestion-card hierarchy (spec.md §5 "Transport chrome").
declare global {
  interface Window {
    copilot: CopilotBridge
  }
}

// How long an ok:false health banner stays up before it auto-dismisses, even
// without an explicit ok:true recovery event (spec.md Task 2.4).
const HEALTH_BANNER_TIMEOUT_MS = 10_000

// v1 only ever wires SystemAudioSource (spec.md §2); there is no live
// transport-selector UI yet, just this always-visible label. modeLabelFor
// already covers 'file'/'twilio' so swapping this constant is the only change
// needed once bench replay or PSTN (Transport A) drive the chip for real.
const CURRENT_TRANSPORT: SuggestionTransport = 'system'

const pill = document.getElementById('pill') as HTMLDivElement
const hintHeadlineEl = document.getElementById('hint-headline') as HTMLSpanElement
const hintLineEl = document.getElementById('hint-line') as HTMLSpanElement
const healthPill = document.getElementById('health-pill') as HTMLDivElement
const healthEl = document.getElementById('health') as HTMLSpanElement
const consentPrompt = document.getElementById('consent-prompt') as HTMLDivElement
const consentAnnouncementEl = document.getElementById('consent-announcement') as HTMLSpanElement
const consentAffirmBtn = document.getElementById('consent-affirm-btn') as HTMLButtonElement
const customerBriefSelect = document.getElementById('customer-brief-select') as HTMLSelectElement
const recIndicator = document.getElementById('rec-indicator') as HTMLDivElement
const modeLabelEl = document.getElementById('mode-label') as HTMLSpanElement

let healthTimer: ReturnType<typeof setTimeout> | null = null

// The headline/line split decision is pure (hintDisplayFor, unit-tested
// without jsdom); only the DOM writes below live here.
function render(hint: Hint): void {
  const text = hint.text.trim()
  const display = hintDisplayFor(hint)
  const twoLine = display.headline !== undefined
  hintHeadlineEl.textContent = twoLine ? (display.headline as string) : (display.single ?? '')
  hintLineEl.textContent = twoLine ? (display.line ?? '') : ''
  pill.classList.toggle('two-line', twoLine)
  // Dim the guess, brighten the earned answer — so the eye learns to trust the
  // bright one without reading either.
  hintHeadlineEl.classList.toggle('generated', hint.source === 'GENERATED')
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
  renderCustomerBriefOptions(msg.customerBriefs)
  renderRecIndicator()
}

// Customer-brief dropdown (spec.md §7, Plans.md Task 6.7): options are
// rebuilt from main's listing each time consent-required arrives (once per
// overlay load); "none" (value: '') always leads and is the default.
function renderCustomerBriefOptions(names: readonly string[]): void {
  const options = customerBriefOptionsFor(names)
  customerBriefSelect.replaceChildren(
    ...options.map((opt) => {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      return el
    })
  )
  customerBriefSelect.value = ''
}

function renderRecIndicator(): void {
  const rec = recIndicatorViewFor(consentState)
  recIndicator.classList.toggle('visible', rec.visible)
}

consentAffirmBtn.addEventListener('click', () => {
  // Locked in at affirm time — no mid-call switching (spec.md §7). '' means
  // "none" was selected, the default.
  const selected = customerBriefSelect.value
  window.copilot.affirmConsent(selected.length > 0 ? selected : null)
  consentState = 'affirmed'
  consentPrompt.classList.remove('visible')
  customerBriefSelect.disabled = true
  renderRecIndicator()
})

// Mode chip: always visible, independent of consent state (spec.md §5) —
// unlike REC, it doesn't wait on affirmation because it isn't recording
// anything, it's just naming which capture path is live.
modeLabelEl.textContent = modeLabelFor(CURRENT_TRANSPORT)

window.copilot.onHint(render)
window.copilot.onHealth(renderHealth)
window.copilot.onConsentRequired(renderConsent)
// Tell main the subscription is live so no early hint/health/consent message is dropped.
window.copilot.ready()
