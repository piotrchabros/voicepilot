import type { CopilotBridge, Hint } from '@shared/types'

// The renderer does exactly one thing: paint what it's sent. No state, no logic.
// Coalescing at ~30Hz happens naturally because we only touch the DOM on a hint.
declare global {
  interface Window {
    copilot: CopilotBridge
  }
}

const pill = document.getElementById('pill') as HTMLDivElement
const hintEl = document.getElementById('hint') as HTMLSpanElement

function render(hint: Hint): void {
  const text = hint.text.trim()
  hintEl.textContent = text
  // Dim the guess, brighten the earned answer — so the eye learns to trust the
  // bright one without reading either.
  hintEl.classList.toggle('generated', hint.source === 'GENERATED')
  pill.classList.toggle('visible', text.length > 0 && text !== '-')
}

window.copilot.onHint(render)
// Tell main the subscription is live so no early hint is dropped.
window.copilot.ready()
