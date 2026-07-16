import type { Analysis, PanelBridge, PanelInitMsg } from '@shared/types'
import { type PanelViewModel, panelViewModelFor } from './panel-view'

// Analysis panel window renderer (spec.md §5/§7, Plans.md Task 6.6). Mirrors
// overlay.ts's split: `panel-view.ts`'s panelViewModelFor is the pure
// display-logic decision (unit-tested without jsdom), this file only does
// the DOM writes + IPC wiring, same seam pattern as consent-view.ts/overlay.ts.
declare global {
  interface Window {
    panel: PanelBridge
  }
}

// How often to re-evaluate time-based staleness while the panel is open,
// without requiring a new analysis or an explicit refresh click (spec.md §7
// "greyed... after a time threshold since last analysis").
const STALE_RECHECK_MS = 5_000

const panelRoot = document.getElementById('panel') as HTMLDivElement
const panelEmpty = document.getElementById('panel-empty') as HTMLDivElement
const panelEmptyText = document.getElementById('panel-empty-text') as HTMLSpanElement
const panelContent = document.getElementById('panel-content') as HTMLDivElement
const panelStage = document.getElementById('panel-stage') as HTMLDivElement
const panelQuestions = document.getElementById('panel-questions') as HTMLUListElement
const nextStepsWrap = document.getElementById('panel-next-steps-wrap') as HTMLDivElement
const nextStepsList = document.getElementById('panel-next-steps') as HTMLUListElement
const panelStamp = document.getElementById('panel-stamp') as HTMLDivElement
const cloudIndicator = document.getElementById('cloud-indicator') as HTMLDivElement
const refreshBtn = document.getElementById('panel-refresh-btn') as HTMLButtonElement

let analysisEnabled = false
let lastAnalysis: Analysis | null = null
let receivedAtMs: number | null = null

function listItemsFor(container: HTMLUListElement, items: readonly string[]): void {
  container.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li')
      li.textContent = text
      return li
    })
  )
}

function paint(vm: PanelViewModel): void {
  cloudIndicator.classList.toggle('visible', vm.cloudActive)
  panelRoot.classList.toggle('stale', vm.stale)
  panelEmpty.classList.toggle('visible', vm.empty)
  panelContent.classList.toggle('visible', !vm.empty)

  if (vm.empty) {
    panelEmptyText.textContent =
      vm.emptyReason === 'disabled' ? 'analysis disabled' : 'awaiting analysis…'
    return
  }

  panelStage.textContent = vm.stageLabel ?? ''
  listItemsFor(panelQuestions, vm.suggestedQuestions)

  const nextSteps = vm.nextSteps ?? []
  nextStepsWrap.classList.toggle('visible', nextSteps.length > 0)
  listItemsFor(nextStepsList, nextSteps)

  panelStamp.textContent = vm.asOfTurnLabel ?? ''
}

function render(): void {
  paint(
    panelViewModelFor({
      analysis: lastAnalysis,
      analysisEnabled,
      receivedAtMs,
      nowMs: Date.now()
    })
  )
}

function onAnalysis(analysis: Analysis): void {
  lastAnalysis = analysis
  receivedAtMs = Date.now()
  render()
}

function onPanelInit(msg: PanelInitMsg): void {
  analysisEnabled = msg.analysisEnabled
  render()
}

refreshBtn.addEventListener('click', () => {
  // Re-render-latest + ask main for a fresh send (spec.md §5 "manual
  // 'refresh now'"). AnalysisEngine exposes no public re-trigger as of Task
  // 6.6 (analysis-engine.ts is out of scope this wave) — main's
  // `panel:refresh` handler only re-sends the cached latest analysis; this
  // click also re-evaluates staleness immediately, independent of whether a
  // new payload arrives.
  window.panel.refreshNow()
  render()
})

window.panel.onAnalysis(onAnalysis)
window.panel.onPanelInit(onPanelInit)
window.panel.ready()

setInterval(render, STALE_RECHECK_MS)

render()
