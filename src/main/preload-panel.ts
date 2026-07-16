import { contextBridge, ipcRenderer } from 'electron'
import type { Analysis, PanelBridge, PanelInitMsg } from '@shared/types'
import type { RendererIpc } from './preload'

// Analysis panel window's minimal preload (spec.md §5, Plans.md Task 6.6) —
// a separate, narrower bridge from `buildCopilotBridge` (preload.ts):
// the panel only ever needs analysis results, the cloud-indicator flag, and
// a manual refresh request. `RendererIpc` is reused via `import type` (erased
// at compile time — this file does not pull preload.ts's
// `contextBridge.exposeInMainWorld('copilot', ...)` call into this bundle).
export function buildPanelBridge(ipc: RendererIpc): PanelBridge {
  return {
    onAnalysis(cb: (analysis: Analysis) => void): () => void {
      const listener = (_e: unknown, analysis: Analysis): void => cb(analysis)
      ipc.on('analysis', listener)
      return () => ipc.removeListener('analysis', listener)
    },
    onPanelInit(cb: (msg: PanelInitMsg) => void): () => void {
      const listener = (_e: unknown, msg: PanelInitMsg): void => cb(msg)
      ipc.on('panel-init', listener)
      return () => ipc.removeListener('panel-init', listener)
    },
    refreshNow(): void {
      ipc.send('panel:refresh')
    },
    ready(): void {
      ipc.send('panel:ready')
    }
  }
}

// `contextBridge` is unavailable outside a real preload context — optional
// chaining keeps `buildPanelBridge` importable from tests without this line
// throwing (mirrors preload.ts's own guard).
contextBridge?.exposeInMainWorld('panel', buildPanelBridge(ipcRenderer))
