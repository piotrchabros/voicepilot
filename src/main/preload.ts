import { contextBridge, ipcRenderer } from 'electron'
import type { Analysis, ConsentRequiredMsg, CopilotBridge, HealthMsg, Hint } from '@shared/types'

/** The slice of `ipcRenderer` the bridge needs — narrowed so
 *  `buildCopilotBridge` below is testable with a plain fake, without pulling
 *  in the real `electron` module (unavailable outside a preload context). */
export interface RendererIpc {
  // `...args: any[]` mirrors Electron's own IpcRenderer#on/#removeListener
  // signature so the real `ipcRenderer` is structurally assignable here
  // without a cast.
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown
  send(channel: string, ...args: unknown[]): void
}

// The renderer is sandboxed (contextIsolation on, nodeIntegration off). It gets
// a small, fixed set of capabilities: subscribe to hints, subscribe to health
// events (sidecar exit / device loss / Soniox disconnect), subscribe to the
// consent prompt, subscribe to analysis results, and affirm consent. Nothing
// else crosses the bridge. Extracted as a pure function (Task 6.5) — same
// seam pattern as `sendInitWhenReady`/`routeFromPipelineMessage` — so the
// bridge's shape is unit-testable without a live `contextBridge`.
export function buildCopilotBridge(ipc: RendererIpc): CopilotBridge {
  return {
    onHint(cb: (hint: Hint) => void): () => void {
      const listener = (_e: unknown, hint: Hint): void => cb(hint)
      ipc.on('hint', listener)
      return () => ipc.removeListener('hint', listener)
    },
    onHealth(cb: (health: HealthMsg) => void): () => void {
      const listener = (_e: unknown, health: HealthMsg): void => cb(health)
      ipc.on('health', listener)
      return () => ipc.removeListener('health', listener)
    },
    onConsentRequired(cb: (msg: ConsentRequiredMsg) => void): () => void {
      const listener = (_e: unknown, msg: ConsentRequiredMsg): void => cb(msg)
      ipc.on('consent-required', listener)
      return () => ipc.removeListener('consent-required', listener)
    },
    /** Mirrors `onHint` exactly (spec.md §7, Plans.md Task 6.5) — nothing
     *  else crosses the bridge for this channel. */
    onAnalysis(cb: (analysis: Analysis) => void): () => void {
      const listener = (_e: unknown, analysis: Analysis): void => cb(analysis)
      ipc.on('analysis', listener)
      return () => ipc.removeListener('analysis', listener)
    },
    affirmConsent(customerBrief: string | null): void {
      ipc.send('consent:affirm', customerBrief)
    },
    ready(): void {
      ipc.send('overlay:ready')
    }
  }
}

// `contextBridge` is unavailable outside a real preload context (undefined in
// a plain node/test environment) — optional chaining keeps `buildCopilotBridge`
// importable from tests without this line throwing.
contextBridge?.exposeInMainWorld('copilot', buildCopilotBridge(ipcRenderer))
