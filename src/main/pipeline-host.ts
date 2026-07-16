import { type UtilityProcess, utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioFrame } from '@shared/audio-source'
import type { Analysis, FromPipeline, HealthMsg, Hint, InitMsg, LogMsg } from '@shared/types'
import {
  checkModels,
  customersDir,
  knowledgeDir,
  paths,
  playbookDir,
  sidecarBinary,
  SONIOX_LANGUAGE_HINTS,
  sonioxApiKey,
  sonioxWsUrl
} from './config'
import { type ConsentGate, resolveInitCustomerBrief, wireCaptureStart } from './consent'
import { audioEndToHealthMsg, audioHealthToMsg } from './health-events'
import { LlamaSupervisor } from './llama-supervisor'
import { MAX_TURNS, STATIC_CONTEXT, SYSTEM_PROMPT } from './prompts'
import { legForSpeaker, SystemAudioSource } from './system-audio-source'

// Owns the three child processes that make up the runtime:
//   1. the utilityProcess pipeline (VAD/STT/HintEngine) — off the main thread
//   2. the llama-server (supervised)
//   3. the Swift capture sidecar (PCM on stdout)
//
// Wires sidecar frames -> pipeline, and pipeline hints -> the overlay. If models
// or llama-server aren't set up yet, it logs clearly and stays idle so the
// overlay still runs (Step-1 content-protection stays verifiable regardless).

export interface PipelineDeps {
  onHint: (hint: Hint) => void
  onLog: (log: LogMsg) => void
  /** Sidecar exit / device loss / Soniox disconnect — surfaced as a banner,
   *  not just a log line (spec.md Task 2.4). */
  onHealth: (health: HealthMsg) => void
  /** Transport-B procedural consent gate (spec.md §4 item 2 / Plans.md Task
   *  4.1): `audioSource.start()` below is held behind `consentGate.onAffirmed`
   *  — capture must never start before the operator affirms, per call. */
  consentGate: ConsentGate
  /** Operator-selected customer-brief basename at the moment InitMsg is
   *  built, or `null` for "none" (spec.md §7, Plans.md Task 6.7). A getter
   *  (not a value) because init is constructed asynchronously after
   *  `child.once('spawn')`/`llama.ensure()`, by which point the operator may
   *  have already affirmed consent with a selection. */
  getCustomerBrief: () => string | null
  /** Optional: a best-effort analysis result to forward to the (future, Task
   *  6.6) side panel (spec.md §7, Plans.md Task 6.5). Optional because the
   *  analysis engine itself is optional (feature-flagged, cloud-LLM
   *  dependent) — main may run with no handler wired. */
  onAnalysis?: (analysis: Analysis) => void
}

export interface PipelineHandle {
  shutdown: () => void
}

export interface SendInitDeps {
  /** Resolves once llama-server is ready (or not) — mirrors `llama.ensure()`. */
  llamaReady: Promise<boolean>
  /** Builds every InitMsg field except `customerBrief`. Called at send
   *  time, same as `getCustomerBrief` below. */
  buildBaseInit: () => Omit<InitMsg, 'customerBrief'>
  /** Read at send time, NOT at pipeline-spawn/construction time (reviewer
   *  finding on commit cc11c18, Task 6.7 MAJOR A): the utilityProcess
   *  `'spawn'` event fires machine-fast, long before a human operator
   *  affirms consent with a brief selection — reading this eagerly at
   *  spawn time would almost always miss a real selection. */
  getCustomerBrief: () => string | null
  onLlamaNotReady: () => void
  send: (init: InitMsg) => void
}

/**
 * Sends `InitMsg` once `llamaReady` resolves, reading `getCustomerBrief()`
 * at THAT point rather than at pipeline-spawn/construction time (reviewer
 * finding MAJOR A, Task 6.7). Extracted as pure orchestration — no Electron
 * API calls — so the temporal ordering itself is unit-testable without
 * `utilityProcess`/`LlamaSupervisor` (see test/pipeline-host-init.test.ts).
 */
export function sendInitWhenReady(deps: SendInitDeps): Promise<void> {
  return deps.llamaReady.then((ok) => {
    if (!ok) deps.onLlamaNotReady()
    const base = deps.buildBaseInit()
    const customerBrief = resolveInitCustomerBrief(deps.getCustomerBrief())
    // exactOptionalPropertyTypes: spread it in only when selected — see the
    // comment at the previous call site (Plans.md Task 6.7).
    deps.send({ ...base, ...(customerBrief !== undefined && { customerBrief }) })
  })
}

/** Routing deps for `routeFromPipelineMessage` below — a subset of
 *  `PipelineDeps` (excludes `consentGate`/`getCustomerBrief`, which
 *  `startPipeline` uses elsewhere, not in the message switch). */
export interface RouteFromPipelineDeps {
  onHint: (hint: Hint) => void
  onLog: (log: LogMsg) => void
  onHealth: (health: HealthMsg) => void
  onAnalysis?: (analysis: Analysis) => void
}

/**
 * Pure routing table for `child.on('message')` (Task 6.5) — extracted so the
 * switch itself is unit-testable without a live `utilityProcess`, same seam
 * pattern as `sendInitWhenReady` above. `logFn` mirrors `startPipeline`'s
 * local `log` helper (level + message, not a `LogMsg`).
 */
export function routeFromPipelineMessage(
  msg: FromPipeline,
  deps: RouteFromPipelineDeps,
  logFn: (level: LogMsg['level'], msg: string) => void
): void {
  switch (msg.type) {
    case 'hint':
      deps.onHint(msg.hint)
      break
    case 'log':
      deps.onLog(msg)
      break
    case 'ready':
      logFn('info', 'pipeline reports ready')
      break
    case 'metric':
      // consumed by the bench harness only
      break
    case 'health':
      // e.g. Soniox ws disconnect, reported by the pipeline utilityProcess.
      deps.onHealth(msg)
      break
    case 'analysis':
      deps.onAnalysis?.(msg.analysis)
      break
  }
}

export function startPipeline(deps: PipelineDeps): PipelineHandle {
  const log = (level: LogMsg['level'], msg: string): void => deps.onLog({ type: 'log', level, msg })

  const models = checkModels()
  if (!models.ok) {
    const missing = [
      !models.silero && 'silero_vad.onnx',
      !models.soniox &&
        !models.zipformer &&
        'STT: SONIOX_API_KEY (or .soniox-key) or zipformer-streaming/ models'
    ].filter(Boolean)
    log(
      'warn',
      `missing in ${paths.models}: ${missing.join(', ')} — pipeline idle. See README step 2.`
    )
    // Still return a handle; the overlay runs standalone.
    return { shutdown: () => {} }
  }
  log('info', `stt engine: ${models.soniox ? 'soniox (cloud, pl+en)' : 'local zipformer (en)'}`)

  // 1. Spawn the pipeline utilityProcess.
  const child: UtilityProcess = utilityProcess.fork(join(__dirname, 'pipeline.js'), [], {
    serviceName: 'copilot-pipeline',
    stdio: 'inherit'
  })

  child.on('message', (msg: FromPipeline) => routeFromPipelineMessage(msg, deps, log))

  // 2. Supervise llama-server (spawn if needed, poll /health), then init pipeline.
  const llama = new LlamaSupervisor({
    base: paths.llamaBase,
    modelPath: paths.gguf,
    onLog: (l, m, _c) => log(l as LogMsg['level'], m)
  })

  child.once('spawn', () => {
    // Reviewer finding on commit cc11c18 (Task 6.7 MAJOR A): `getCustomerBrief()`
    // must be read once `llamaReady` resolves (inside `sendInitWhenReady`),
    // NOT here at 'spawn' time — 'spawn' fires machine-fast, long before a
    // human operator affirms consent with a brief selection, so reading it
    // eagerly here would almost always miss a real selection.
    void sendInitWhenReady({
      llamaReady: llama.ensure(),
      buildBaseInit: () => {
        // `playbookYaml` carries a filesystem path (directory of *.yaml/*.yml
        // files, spec.md §3), not raw YAML text — `Playbook.fromYaml()` on
        // the pipeline side resolves it against disk the same way this main
        // process can. Passing a path (not file contents) keeps a multi-file
        // playbook/ directory a single round trip instead of pre-merging N
        // files by hand.
        let playbookYaml = playbookDir()
        if (!existsSync(playbookYaml)) {
          log('warn', `playbook/ not found at ${playbookYaml} — retrieval layer disabled`)
          playbookYaml = ''
        }
        return {
          type: 'init',
          sileroPath: paths.silero,
          zipformerDir: paths.zipformer,
          sonioxApiKey: sonioxApiKey(),
          sonioxLanguageHints: SONIOX_LANGUAGE_HINTS,
          sonioxWsUrl: sonioxWsUrl(),
          llamaBase: paths.llamaBase,
          systemPrompt: SYSTEM_PROMPT,
          staticContext: STATIC_CONTEXT,
          playbookYaml,
          maxTurns: MAX_TURNS,
          bench: false,
          // Phase-6 AnalysisEngine (spec.md §7, Plans.md Task 6.4): only
          // filesystem paths cross this boundary — KB/brief content is
          // loaded fresh on the pipeline side (see src/pipeline/index.ts's
          // init()).
          knowledgeDir: knowledgeDir(),
          customersDir: customersDir()
        }
      },
      getCustomerBrief: deps.getCustomerBrief,
      onLlamaNotReady: () =>
        log('warn', 'llama-server not ready — generation layer will be silent until it is'),
      send: (init) => child.postMessage(init)
    })
  })

  // 3. Spawn the capture sidecar (via the `AudioSource` seam, spec.md §2) and
  //    forward frames to the pipeline, translating back to the unchanged
  //    sidecar/pipeline wire protocol (leg byte, not speaker role).
  const debug = process.env['COPILOT_DEBUG'] === '1'
  let frameCount = 0
  const audioSource = new SystemAudioSource({ binary: sidecarBinary() })
  audioSource.on('audio', (frame: AudioFrame) => {
    if (debug && ++frameCount % 150 === 0) log('info', `main: ${frameCount} frames from sidecar`)
    const leg = legForSpeaker(frame.speaker)
    child.postMessage({ type: 'frame', leg, samples: frame.pcm.buffer })
  })
  audioSource.on('health', (status) => {
    log(status.ok ? 'info' : 'warn', status.detail)
    deps.onHealth(audioHealthToMsg(status))
  })
  audioSource.on('end', (reason) => {
    log('warn', `capture sidecar ended (${reason})`)
    const health = audioEndToHealthMsg(reason)
    if (health !== null) deps.onHealth(health)
  })

  // Consent gate (spec.md §4 item 2 / Plans.md Task 4.1): capture never
  // starts before the operator affirms, per call — not merely a UI hint,
  // this is the actual gate on the audio source starting. Wiring extracted
  // to `wireCaptureStart` (unit-tested directly, without this function's
  // Electron/utilityProcess/llama-server dependencies).
  wireCaptureStart(
    deps.consentGate,
    () => void audioSource.start(),
    (msg) => log('info', msg)
  )

  return {
    shutdown: () => {
      void audioSource.stop()
      try {
        child.postMessage({ type: 'control', action: 'shutdown' })
      } catch {
        /* child may already be gone */
      }
      child.kill()
      llama.stop()
    }
  }
}
