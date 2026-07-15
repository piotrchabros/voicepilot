import { contextBridge, ipcRenderer } from 'electron'
import type { CopilotBridge, HealthMsg, Hint } from '@shared/types'

// The renderer is sandboxed (contextIsolation on, nodeIntegration off). It gets
// exactly two capabilities: subscribe to hints, and subscribe to health events
// (sidecar exit / device loss / Soniox disconnect). Nothing else crosses the
// bridge.
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
  ready(): void {
    ipcRenderer.send('overlay:ready')
  }
}

contextBridge.exposeInMainWorld('copilot', bridge)
