import { contextBridge, ipcRenderer } from 'electron'
import type { CopilotBridge, Hint } from '@shared/types'

// The renderer is sandboxed (contextIsolation on, nodeIntegration off). It gets
// exactly one capability: subscribe to hints. Nothing else crosses the bridge.
const bridge: CopilotBridge = {
  onHint(cb: (hint: Hint) => void): () => void {
    const listener = (_e: unknown, hint: Hint): void => cb(hint)
    ipcRenderer.on('hint', listener)
    return () => ipcRenderer.removeListener('hint', listener)
  },
  ready(): void {
    ipcRenderer.send('overlay:ready')
  }
}

contextBridge.exposeInMainWorld('copilot', bridge)
