import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import type { HealthMsg, Hint } from '@shared/types'
import { ConsentGate, resolveAnnouncement } from './consent'
import { loadEnv } from './env'
import { startPipeline, type PipelineHandle } from './pipeline-host'
import { runListDevices } from './list-devices'
import { runBench } from './bench'
import { runTtft } from './ttft'

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

function paint(hint: Hint): void {
  overlay?.webContents.send('hint', hint)
}

function paintHealth(health: HealthMsg): void {
  overlay?.webContents.send('health', health)
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
        state: consentGate.state
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
    // needs real clicks.
    ipcMain.on('consent:affirm', () => {
      consentGate.affirm()
      overlay?.setIgnoreMouseEvents(true, { forward: true })
    })

    pipeline = startPipeline({
      onHint: paint,
      onLog: (l) => console.log(`[pipeline:${l.level}] ${l.msg}`),
      onHealth: paintHealth,
      consentGate
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) overlay = createOverlay()
    })
  })

  app.on('window-all-closed', () => {
    // Overlay is the whole UI; closing it ends the app (macOS-only, no tray).
    app.quit()
  })

  app.on('before-quit', () => {
    pipeline?.shutdown()
  })
}
