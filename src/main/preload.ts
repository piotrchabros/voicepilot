import { contextBridge, ipcRenderer } from 'electron'
import type { ConsentRequiredMsg, CopilotBridge, HealthMsg, Hint } from '@shared/types'

// The renderer is sandboxed (contextIsolation on, nodeIntegration off). It gets
// a small, fixed set of capabilities: subscribe to hints, subscribe to health
// events (sidecar exit / device loss / Soniox disconnect), subscribe to the
// consent prompt, and affirm consent. Nothing else crosses the bridge.
const bridge: CopilotBridge = {
  onHint(cb: (hint: Hint) => void): () => void {
    const listener = (_e: unknown, hint: Hint): void => cb(hint)
    ipcRenderer.on('hint', listener)
    return () => ipcRenderer.removeListener('hint', listener)
  },
  onHealth(cb: (health: HealthMsg) => void): () => void {
    const listener = (_e: unknown, health: HealthMsg): void => cb(health)
    ipcRenderer.on('health', listener)
    return () => ipcRenderer.removeListener('health', listener)
  },
  onConsentRequired(cb: (msg: ConsentRequiredMsg) => void): () => void {
    const listener = (_e: unknown, msg: ConsentRequiredMsg): void => cb(msg)
    ipcRenderer.on('consent-required', listener)
    return () => ipcRenderer.removeListener('consent-required', listener)
  },
  affirmConsent(): void {
    ipcRenderer.send('consent:affirm')
  },
  ready(): void {
    ipcRenderer.send('overlay:ready')
  }
}

contextBridge.exposeInMainWorld('copilot', bridge)
