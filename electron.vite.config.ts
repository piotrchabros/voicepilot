import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// The pipeline (VAD/STT/HintEngine/LlamaClient) runs in a utilityProcess, NOT the
// main process — ONNX inference on the main thread janks the window. It is built
// alongside main here as a second entry, sharing the same node/externalize config.
// Native addons (onnxruntime-node, sherpa-onnx-node) must never be bundled.
const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          pipeline: resolve('src/pipeline/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve('src/main/preload.ts'),
          // Analysis panel window's own, narrower preload (Plans.md Task 6.6).
          panel: resolve('src/main/preload-panel.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: { alias },
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // Analysis panel window (Plans.md Task 6.6) — hidden by default,
          // a separate BrowserWindow from the hint-card overlay above.
          panel: resolve('src/renderer/panel.html'),
        },
      },
    },
  },
})
