import { app } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Runtime paths, mirroring Main.java's `~/models` layout and the README.
const MODELS = join(homedir(), 'models')

export const paths = {
  models: MODELS,
  silero: join(MODELS, 'silero_vad.onnx'),
  zipformer: join(MODELS, 'zipformer-streaming'),
  gguf: join(MODELS, 'Qwen3-4B-Instruct-Q4_K_M.gguf'),
  llamaBase: 'http://127.0.0.1:8080',
} as const

/** The capture sidecar binary, whether running packaged or from source. */
export function sidecarBinary(): string {
  const fromSource = join(app.getAppPath(), 'native/capture/.build/release/capture')
  if (existsSync(fromSource)) return fromSource
  // Packaged: shipped next to resources.
  return join(process.resourcesPath, 'capture')
}

/** playbook.tsv lives at the project root (Main.java read it from the cwd). */
export function playbookPath(): string {
  const atRoot = join(app.getAppPath(), 'playbook.tsv')
  if (existsSync(atRoot)) return atRoot
  return join(process.cwd(), 'playbook.tsv')
}

export interface ModelReadiness {
  silero: boolean
  zipformer: boolean
  gguf: boolean
  ok: boolean
}

export function checkModels(): ModelReadiness {
  const silero = existsSync(paths.silero)
  const zipformer =
    existsSync(join(paths.zipformer, 'encoder.onnx')) &&
    existsSync(join(paths.zipformer, 'decoder.onnx')) &&
    existsSync(join(paths.zipformer, 'joiner.onnx')) &&
    existsSync(join(paths.zipformer, 'tokens.txt'))
  const gguf = existsSync(paths.gguf)
  return { silero, zipformer, gguf, ok: silero && zipformer }
}
