import { type UtilityProcess, utilityProcess } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FromPipeline, Hint, InitMsg, Leg, LogMsg } from '@shared/types'
import { checkModels, paths, playbookPath, sidecarBinary, SONIOX_LANGUAGE_HINTS, sonioxApiKey } from './config'
import { LlamaSupervisor } from './llama-supervisor'
import { MAX_TURNS, STATIC_CONTEXT, SYSTEM_PROMPT } from './prompts'
import { Sidecar } from './sidecar'

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
        'STT: SONIOX_API_KEY (or .soniox-key) or zipformer-streaming/ models',
    ].filter(Boolean)
    log('warn', `missing in ${paths.models}: ${missing.join(', ')} — pipeline idle. See README step 2.`)
    // Still return a handle; the overlay runs standalone.
    return { shutdown: () => {} }
  }
  log('info', `stt engine: ${models.soniox ? 'soniox (cloud, pl+en)' : 'local zipformer (en)'}`)

  // 1. Spawn the pipeline utilityProcess.
  const child: UtilityProcess = utilityProcess.fork(join(__dirname, 'pipeline.js'), [], {
    serviceName: 'copilot-pipeline',
    stdio: 'inherit',
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
    }
  })

  // 2. Supervise llama-server (spawn if needed, poll /health), then init pipeline.
  const llama = new LlamaSupervisor({ base: paths.llamaBase, modelPath: paths.gguf, onLog: (l, m, _c) => log(l as LogMsg['level'], m) })

  child.once('spawn', () => {
    let playbookTsv = ''
    try {
      playbookTsv = readFileSync(playbookPath(), 'utf8')
    } catch {
      log('warn', `playbook.tsv not found at ${playbookPath()} — retrieval layer disabled`)
    }
    const init: InitMsg = {
      type: 'init',
      sileroPath: paths.silero,
      zipformerDir: paths.zipformer,
      sonioxApiKey: sonioxApiKey(),
      sonioxLanguageHints: SONIOX_LANGUAGE_HINTS,
      llamaBase: paths.llamaBase,
      systemPrompt: SYSTEM_PROMPT,
      staticContext: STATIC_CONTEXT,
      playbookTsv,
      maxTurns: MAX_TURNS,
      bench: false,
    }
    // Bring llama up before the pipeline warms its prefix against it.
    void llama.ensure().then((ok) => {
      if (!ok) log('warn', 'llama-server not ready — generation layer will be silent until it is')
      child.postMessage(init)
    })
  })

  // 3. Spawn the capture sidecar and forward frames to the pipeline.
  const debug = process.env['COPILOT_DEBUG'] === '1'
  let frameCount = 0
  const sidecar = new Sidecar({
    binary: sidecarBinary(),
    onFrame: (leg: Leg, samples: ArrayBuffer) => {
      if (debug && ++frameCount % 150 === 0) log('info', `main: ${frameCount} frames from sidecar`)
      child.postMessage({ type: 'frame', leg, samples })
    },
    onLog: (level, msg, code) => log(level as LogMsg['level'], code ? `[${code}] ${msg}` : msg),
    onExit: (code) => log(code === 0 ? 'info' : 'warn', `capture sidecar exited (${code})`),
  })
  const started = sidecar.start()
  if (!started) log('warn', 'capture sidecar not started — no audio input')

  return {
    shutdown: () => {
      sidecar.stop()
      try {
        child.postMessage({ type: 'control', action: 'shutdown' })
      } catch {
        /* child may already be gone */
      }
      child.kill()
      llama.stop()
    },
  }
}
