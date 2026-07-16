import { app } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from './env'
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

/**
 * playbook/ (YAML entries, spec.md §3) lives at the project root — Main.java's
 * playbook.tsv read it from the cwd; this is the YAML-schema successor
 * (Playbook.fromYaml() merges every *.yaml/*.yml file inside the directory).
 */
export function playbookDir(): string {
  const atRoot = join(app.getAppPath(), 'playbook')
  if (existsSync(atRoot)) return atRoot
  return join(process.cwd(), 'playbook')
}

/**
 * `customers/<name>.md` briefs (spec.md §7, Plans.md Task 6.1/6.7) — same
 * app-path-then-cwd resolution as `playbookDir()` above. Never copied into
 * a derived store; `listCustomerBriefs`/`loadCustomerBrief`
 * (src/pipeline/knowledge.ts) read straight from this directory.
 */
export function customersDir(): string {
  const atRoot = join(app.getAppPath(), 'customers')
  if (existsSync(atRoot)) return atRoot
  return join(process.cwd(), 'customers')
}

/**
 * `knowledge/**\/*.md` (sales-closing practices, strategy, sales-psychology
 * notes, product/service info — spec.md §7, Plans.md Task 6.1/6.4). Same
 * app-path-then-cwd resolution as `playbookDir()`/`customersDir()` above.
 * `KnowledgeBase.load()` (src/pipeline/knowledge.ts) is empty-safe against a
 * missing directory, so this never needs its own existence check here.
 */
export function knowledgeDir(): string {
  const atRoot = join(app.getAppPath(), 'knowledge')
  if (existsSync(atRoot)) return atRoot
  return join(process.cwd(), 'knowledge')
}

/**
 * Soniox API key: SONIOX_API_KEY in `.env` (validated fail-fast by env.ts —
 * Plans.md 1.2 / spec.md §4.6), or a git-ignored `.soniox-key` file at the
 * project root as a deprecated fallback. Null when absent — the pipeline
 * then uses the local engine.
 */
export function sonioxApiKey(): string | null {
  const fromEnv = loadEnv().SONIOX_API_KEY
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const keyFile = join(app.getAppPath(), '.soniox-key')
  if (existsSync(keyFile)) {
    const key = readFileSync(keyFile, 'utf8').trim()
    if (key.length > 0) {
      console.warn('[deprecated] .soniox-key file — migrate to SONIOX_API_KEY in .env')
      warnIfKeyFileNotLockedDown(keyFile)
      return key
    }
  }
  return null
}

/** chmod 600 recommendation — the key file readable by group/other is a leak. */
function warnIfKeyFileNotLockedDown(keyFile: string): void {
  const mode = statSync(keyFile).mode & 0o777
  if (mode !== 0o600) {
    console.warn(
      `[deprecated] .soniox-key permissions are ${mode.toString(8)}, not 600 — run \`chmod 600 ${keyFile}\` to keep the key readable by you only.`
    )
  }
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
  const env = loadEnv().SONIOX_WS_URL
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
