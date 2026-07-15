import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertEuEndpoint, EU_SONIOX_WS_URL } from '../pipeline/stt-soniox'

// Runtime paths, mirroring Main.java's `~/models` layout and the README.
const MODELS = join(homedir(), 'models')

export const paths = {
  models: MODELS,
  silero: join(MODELS, 'silero_vad.onnx'),
  zipformer: join(MODELS, 'zipformer-streaming'),
  gguf: join(MODELS, 'Qwen3-4B-Instruct-Q4_K_M.gguf'),
  llamaBase: 'http://127.0.0.1:8080'
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

/**
 * Soniox API key: SONIOX_API_KEY env var, or a git-ignored `.soniox-key` file at
 * the project root. Null when absent — the pipeline then uses the local engine.
 */
export function sonioxApiKey(): string | null {
  const env = process.env['SONIOX_API_KEY']?.trim()
  if (env !== undefined && env.length > 0) return env
  const keyFile = join(app.getAppPath(), '.soniox-key')
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, 'utf8').trim()
    if (key.length > 0) return key
  }
  return null
}

/** Transcript language hints for Soniox — Polish-first sales calls. */
export const SONIOX_LANGUAGE_HINTS = ['pl', 'en'] as const

/**
 * Soniox WS endpoint (spec.md §4.1, EU data residency). Config-driven via
 * SONIOX_WS_URL; defaults to the documented EU host when unset. Asserted here
 * (main-process boot, throws on misconfiguration — "config error = app won't
 * start", not a silent degrade) AND again in stt-soniox.ts's SonioxStt
 * constructor (defense-in-depth for any other caller that builds a URL).
 */
export function sonioxWsUrl(): string {
  const env = process.env['SONIOX_WS_URL']?.trim()
  if (env !== undefined && env.length > 0) return assertEuEndpoint(env)
  return EU_SONIOX_WS_URL
}

export interface ModelReadiness {
  silero: boolean
  zipformer: boolean
  soniox: boolean
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
  const soniox = sonioxApiKey() !== null
  const gguf = existsSync(paths.gguf)
  // The VAD is always required; STT needs either the cloud key or local models.
  return { silero, zipformer, soniox, gguf, ok: silero && (soniox || zipformer) }
}
