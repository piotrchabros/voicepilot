import { type UtilityProcess, utilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AudioFrame } from '@shared/audio-source'
import type { FromPipeline, HealthMsg, Hint, InitMsg, LogMsg } from '@shared/types'
import {
  checkModels,
  paths,
  playbookDir,
  sidecarBinary,
  SONIOX_LANGUAGE_HINTS,
  sonioxApiKey,
  sonioxWsUrl
} from './config'
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
}

export interface PipelineHandle {
  shutdown: () => void
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

  child.on('message', (msg: FromPipeline) => {
    switch (msg.type) {
      case 'hint':
        deps.onHint(msg.hint)
        break
      case 'log':
        deps.onLog(msg)
        break
      case 'ready':
        log('info', 'pipeline reports ready')
        break
      case 'metric':
        // consumed by the bench harness only
        break
      case 'health':
        // e.g. Soniox ws disconnect, reported by the pipeline utilityProcess.
        deps.onHealth(msg)
        break
    }
  })

  // 2. Supervise llama-server (spawn if needed, poll /health), then init pipeline.
  const llama = new LlamaSupervisor({
    base: paths.llamaBase,
    modelPath: paths.gguf,
    onLog: (l, m, _c) => log(l as LogMsg['level'], m)
  })

  child.once('spawn', () => {
    // `playbookYaml` carries a filesystem path (directory of *.yaml/*.yml
    // files, spec.md §3), not raw YAML text — `Playbook.fromYaml()` on the
    // pipeline side resolves it against disk the same way this main process
    // can. Passing a path (not file contents) keeps a multi-file playbook/
    // directory a single round trip instead of pre-merging N files by hand.
    let playbookYaml = playbookDir()
    if (!existsSync(playbookYaml)) {
      log('warn', `playbook/ not found at ${playbookYaml} — retrieval layer disabled`)
      playbookYaml = ''
    }
    const init: InitMsg = {
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
      bench: false
    }
    // Bring llama up before the pipeline warms its prefix against it.
    void llama.ensure().then((ok) => {
      if (!ok) log('warn', 'llama-server not ready — generation layer will be silent until it is')
      child.postMessage(init)
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
  void audioSource.start()

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
