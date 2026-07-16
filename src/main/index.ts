import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import type { Analysis, HealthMsg, Hint } from '@shared/types'
import { ConsentGate, handleConsentAffirm, resolveAnnouncement } from './consent'
import { customersDir } from './config'
import { loadEnv } from './env'
import { startPipeline, type PipelineHandle } from './pipeline-host'
import { runListDevices } from './list-devices'
import { runBench } from './bench'
import { runTtft } from './ttft'
import { listCustomerBriefs } from '../pipeline/knowledge'
// Reused, not duplicated (Task 6.6): the same fail-closed boolean-flag parse
// the pipeline utilityProcess uses to gate the AnalysisEngine itself
// (analysis-engine.ts has no Electron dependency — see its own header
// comment — so it's safe to import from main too).
import { resolveAnalysisEnabledFlag } from '../pipeline/analysis-engine'

// Fail-fast at boot (Plans.md 1.2 / spec.md §4.6): a malformed .env should
// stop the app before any window/pipeline exists, not surface as a
// mid-session crash. Runs before the CLI-subcommand branch below too, so
// --bench/--ttft/--list-devices get the same guarantee.
const env = loadEnv()

// Transport-B consent gate (spec.md §4 item 2 / Plans.md Task 4.1): one gate
// per app run — this is a single-overlay, single-call-at-a-time process, so
// one ConsentGate instance is the whole story. `announcement` is the on-screen
// script; a legal deliverable (docs/compliance.md item 4), never invented
// here — unset/blank resolves to a clearly-marked placeholder instead.
const consentGate = new ConsentGate()
const announcement = resolveAnnouncement(env.CONSENT_ANNOUNCEMENT_PL)
if (announcement.isPlaceholder) {
  console.warn(
    '[consent] CONSENT_ANNOUNCEMENT_PL is not set — showing a placeholder announcement. ' +
      'This must not be used on a real-prospect call (docs/compliance.md item 4).'
  )
}

// Cloud-processing indicator flag for the analysis panel (spec.md §7,
// Plans.md Task 6.6) — the same `LLM_ANALYSIS_ENABLED` env-flag read the
// pipeline utilityProcess does to gate `AnalysisEngine`. Deliberately NOT
// combined with `resolveCloudLlmConfig` (Task 6.3): that resolution lives on
// the pipeline side and never crosses the process boundary, so main can only
// honestly report "the flag resolved true", not "the engine is definitely
// live" (documented in PanelInitMsg's doc comment, shared/types.ts).
const analysisEnabled = resolveAnalysisEnabledFlag(env.LLM_ANALYSIS_ENABLED)

// Customer-brief selection (spec.md §7, Plans.md Task 6.7): operator picks
// from a pre-Start consent-screen dropdown, default "none". The available
// names are enumerated once at boot (mirrors playbook/'s directory-listing
// pattern); the selection itself is captured on `consent:affirm` below and
// never logged (log hygiene — customer names are personal data).
const availableCustomerBriefs = listCustomerBriefs(customersDir())
let selectedCustomerBrief: string | null = null

// Overlay geometry — mirrors the Java Overlay: 900×150, bottom-centre, above
// the dock. Height grew from 90 (Task 4.2 reviewer finding): the two-line
// RETRIEVED suggestion card (headline + line, ~89.2px at 90px pill padding)
// left <1px of margin against the window edge, risking headline clipping and
// overlap with the top-center health banner. 150 gives the two-line pill
// (with its now-tighter 14px padding, see overlay.css) real headroom.
const OVERLAY_W = 900
const OVERLAY_H = 150
const BOTTOM_GAP = 100 // px above the bottom of the work area

let overlay: BrowserWindow | null = null
let pipeline: PipelineHandle | null = null

function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    transparent: true,
    backgroundColor: '#00000000', // required WITH transparent on macOS
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // never steal focus from the call
    resizable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // THE reason for this port: hide the overlay from screen share / recording.
  // COPILOT_NO_PROTECT=1 disables it — used only to A/B verify the gate (the
  // pill MUST appear in a capture with protection off, and vanish with it on).
  const protect = process.env['COPILOT_NO_PROTECT'] !== '1'
  win.setContentProtection(protect)
  if (!protect) console.log('[gate] content protection DISABLED (COPILOT_NO_PROTECT=1)')
  // Plain alwaysOnTop loses to a fullscreen Zoom; 'screen-saver' wins.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Clicks pass straight through to the call underneath.
  win.setIgnoreMouseEvents(true, { forward: true })

  positionBottomCentre(win)

  // Diagnostics (surface renderer errors + confirm the window is where we think).
  win.webContents.on('console-message', (_e, _level, message) =>
    console.log(`[renderer] ${message}`)
  )
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.log(`[did-fail-load] ${code} ${desc}`)
  )
  win.webContents.on('did-finish-load', () =>
    console.log(`[did-finish-load] bounds=${JSON.stringify(win.getBounds())}`)
  )

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => {
    overlay = null
  })
  return win
}

function positionBottomCentre(win: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea
  const x = Math.round(area.x + (area.width - OVERLAY_W) / 2)
  const y = Math.round(area.y + area.height - OVERLAY_H - BOTTOM_GAP)
  win.setPosition(x, y)
}

// Analysis panel window (spec.md §5 "Phase 6 adds a second, separately
// content-protected analysis panel window"; §7; Plans.md Task 6.6). Right
// side, vertically centered — clear of the bottom-centre hint card, the
// top-center health banner, and the top-left transport chrome (mode
// chip/REC), so none of them ever overlap it.
const PANEL_W = 360
const PANEL_H = 420
const PANEL_MARGIN = 24
// Cmd+Shift+A (macOS-only app, spec.md §6) toggles panel visibility — no
// dock/taskbar presence, so this is the only way to reach it.
const PANEL_TOGGLE_ACCELERATOR = 'Command+Shift+A'

let panel: BrowserWindow | null = null
// Cache of the most recently received analysis, so `panel:ready` (a fresh
// show/reload) and `panel:refresh` (manual "refresh now") can re-render it
// without waiting on the next turn-end (spec.md §5 "refresh happens on
// toggle / manual 'refresh now'").
let lastAnalysis: Analysis | null = null

function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    frame: false,
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Interactive by design (spec.md §5 "refresh-now" button) — unlike the
    // overlay, this window must accept real clicks and may take focus.
    focusable: true,
    resizable: false,
    show: false, // hidden by default (spec.md §5) — only the toggle shortcut shows it
    webPreferences: {
      preload: join(__dirname, '../preload/panel.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Same content-protection recipe as createOverlay() above (spec.md §5 "a
  // second, separately content-protected analysis panel window") — kept as
  // its own copy rather than a shared helper so createOverlay() itself stays
  // byte-for-byte untouched (Task 6.6 constraint).
  const protect = process.env['COPILOT_NO_PROTECT'] !== '1'
  win.setContentProtection(protect)
  if (!protect) console.log('[gate] panel content protection DISABLED (COPILOT_NO_PROTECT=1)')
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  positionPanelRight(win)

  // Log hygiene (spec.md §4.4/§7): the panel renders analysis content, so an
  // unfiltered console-message forward could leak it into non-debug logs the
  // way overlay.ts's hint pill never risks (hints aren't logged from the
  // renderer side either, but this window additionally *displays* analysis
  // text). Gated behind COPILOT_DEBUG, mirroring the fail-closed default the
  // rest of the app's debug-only logging uses (analysis-sink-wiring.ts,
  // formatHintLog) — silent by default, opt-in verbose only.
  if (process.env['COPILOT_DEBUG'] === '1') {
    win.webContents.on('console-message', (_e, _level, message) =>
      console.log(`[panel-renderer] ${message}`)
    )
  }
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.log(`[panel-did-fail-load] ${code} ${desc}`)
  )

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/panel.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/panel.html'))
  }

  win.on('closed', () => {
    panel = null
  })
  return win
}

function positionPanelRight(win: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea
  const x = Math.round(area.x + area.width - PANEL_W - PANEL_MARGIN)
  const y = Math.round(area.y + (area.height - PANEL_H) / 2)
  win.setPosition(x, y)
}

function paint(hint: Hint): void {
  overlay?.webContents.send('hint', hint)
}

function paintHealth(health: HealthMsg): void {
  overlay?.webContents.send('health', health)
}

// Task 6.5/6.6 (spec.md §7, Plans.md): forwards a best-effort analysis
// result to the overlay's webContents channel (kept for wire-shape
// compatibility with 6.5's CopilotBridge.onAnalysis; the overlay's own
// renderer never subscribes to it) AND now, Task 6.6, to the dedicated side
// panel window created by createPanel() above — this is the "extend
// paintAnalysis to also feed the panel" wiring the panel gets its data
// through. Log hygiene (spec.md §4.4/§7): analysis content is call content —
// this function must never log it (formatAnalysisLog's debug-gated line
// already covers the pipeline side; no new logging is added here).
function paintAnalysis(analysis: Analysis): void {
  overlay?.webContents.send('analysis', analysis)
  lastAnalysis = analysis
  panel?.webContents.send('analysis', analysis)
}

// --- CLI subcommands (do not launch the overlay) ------------------------------

const argv = process.argv.slice(app.isPackaged ? 1 : 2)
if (argv.includes('--list-devices')) {
  void runListDevices().finally(() => app.quit())
} else if (argv.includes('--bench')) {
  const wav = argv[argv.indexOf('--bench') + 1]
  void runBench(wav).finally(() => app.quit())
} else if (argv.includes('--ttft')) {
  void runTtft().finally(() => app.quit())
} else {
  void app.whenReady().then(() => {
    overlay = createOverlay()
    panel = createPanel()

    // Toggle the analysis panel's visibility (spec.md §5 "shown by explicit
    // operator toggle", Plans.md Task 6.6). No dock/taskbar entry exists for
    // it, so this shortcut is the only way to reach it.
    const registered = globalShortcut.register(PANEL_TOGGLE_ACCELERATOR, () => {
      if (panel === null) return
      if (panel.isVisible()) panel.hide()
      else panel.showInactive()
    })
    if (!registered) {
      console.log(`[panel] failed to register global shortcut ${PANEL_TOGGLE_ACCELERATOR}`)
    }

    // Panel signals when its subscription is live (mirrors 'overlay:ready'
    // below): send the cloud-indicator flag once, then re-send whatever
    // analysis is already cached so a fresh show/reload isn't blank until
    // the next turn-end (spec.md §5).
    ipcMain.on('panel:ready', () => {
      console.log(`[panel:ready] renderer subscribed (analysisEnabled=${analysisEnabled})`)
      panel?.webContents.send('panel-init', { type: 'panel-init', analysisEnabled })
      if (lastAnalysis !== null) panel?.webContents.send('analysis', lastAnalysis)
    })

    // Manual "refresh now" (spec.md §5). AnalysisEngine (src/pipeline/
    // analysis-engine.ts) exposes no public re-trigger as of this task — out
    // of scope this wave (briefing: "do not modify analysis-engine.ts") — so
    // this is a re-render-latest only, documented in docs/qa-checklist-6.6.md.
    ipcMain.on('panel:refresh', () => {
      if (lastAnalysis !== null) panel?.webContents.send('analysis', lastAnalysis)
    })

    // Renderer signals when its hint subscription is live — only then is it safe
    // to paint, so no early hint is dropped into the void.
    ipcMain.on('overlay:ready', () => {
      console.log('[overlay:ready] renderer subscribed')

      // Consent gate (spec.md §4 item 2 / §5, Plans.md Task 4.1): tell the
      // renderer what to show. While pending, the overlay needs real clicks
      // for the affirm button — the window is click-through the rest of the
      // time (setIgnoreMouseEvents(true) above), so this is the one window
      // during which that's flipped off.
      overlay?.webContents.send('consent-required', {
        type: 'consent-required',
        announcement: announcement.text,
        isPlaceholder: announcement.isPlaceholder,
        // Reload mid-call must not re-show the prompt or drop the REC
        // indicator if the operator already affirmed (reviewer note).
        state: consentGate.state,
        // Task 6.7: available customer-brief dropdown options, "none"-safe.
        customerBriefs: availableCustomerBriefs
      })
      if (consentGate.state !== 'affirmed') overlay?.setIgnoreMouseEvents(false)

      // Demo mode: cycle real generated-style hints so the overlay's rendering of
      // pipeline hints is visible without depending on live-mic quality.
      if (process.env['COPILOT_DEMO'] === '1') {
        const demo = [
          "Let's explore a phased rollout instead",
          'What benefits do you get from them?',
          'When can I meet your team?',
          "What's included in the offer?"
        ]
        demo.forEach((text, i) =>
          setTimeout(() => paint({ text, source: 'GENERATED' }), 800 + i * 2500)
        )
        return
      }
      // Dev aid: with no models/llama yet, show a placeholder so the Step-1
      // content-protection gate has something visible to look for.
      if (process.env['COPILOT_PLACEHOLDER'] !== '0') {
        console.log('[paint] sending placeholder hint')
        paint({ text: 'ready', source: 'GENERATED' })
      }
    })

    // Operator affirms consent for this call (spec.md §4 item 2 / Plans.md
    // Task 4.1): logs the affirmation, unblocks `startPipeline`'s capture
    // start, and restores click-through now that the affirm button no longer
    // needs real clicks. Task 6.7: also locks in the customer-brief
    // selection (basename sanitized + validated against the enumerated
    // list) and records which processor set this affirmation covers — never
    // the brief name itself (log hygiene: customer names are personal
    // data). `handleConsentAffirm` (reviewer findings on commit cc11c18,
    // MAJOR B + MINOR C) ignores a replayed event after the gate is already
    // affirmed, and collapses an unknown/nonexistent brief name to "none"
    // rather than letting it over-claim the soniox+llm consent scope.
    ipcMain.on('consent:affirm', (_e, rawCustomerBrief: string | null) => {
      const result = handleConsentAffirm(
        consentGate,
        rawCustomerBrief,
        selectedCustomerBrief,
        availableCustomerBriefs
      )
      selectedCustomerBrief = result.selection
      overlay?.setIgnoreMouseEvents(true, { forward: true })
    })

    pipeline = startPipeline({
      onHint: paint,
      onLog: (l) => console.log(`[pipeline:${l.level}] ${l.msg}`),
      onHealth: paintHealth,
      onAnalysis: paintAnalysis,
      consentGate,
      getCustomerBrief: () => selectedCustomerBrief
    })

    app.on('activate', () => {
      // Recreate both windows together — without the panel, the toggle
      // shortcut would silently no-op after a full re-activation (reviewer
      // finding, Task 6.6 fix). Panel stays hidden by default, same as boot.
      if (BrowserWindow.getAllWindows().length === 0) {
        overlay = createOverlay()
        panel = createPanel()
      }
    })
  })

  app.on('window-all-closed', () => {
    // Overlay is the whole UI; closing it ends the app (macOS-only, no tray).
    app.quit()
  })

  app.on('before-quit', () => {
    pipeline?.shutdown()
  })

  app.on('will-quit', () => {
    // Task 6.6: release the panel-toggle accelerator so it doesn't linger
    // registered system-wide after quit.
    globalShortcut.unregisterAll()
  })
}
