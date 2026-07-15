import { readFileSync } from 'node:fs'
import { FRAME_MS } from '@shared/types'
import { HintEngine } from '../pipeline/hint-engine'
import { LlamaClient } from '../pipeline/llama-client'
import { Playbook } from '../pipeline/playbook'
import { SherpaStt } from '../pipeline/stt'
import { TranscriptState } from '../pipeline/transcript-state'
import { SileroVad } from '../pipeline/vad'
import { parseWav, toFrames, toMono16k } from '../pipeline/wav'
import { checkModels, paths, playbookPath } from './config'
import { MAX_TURNS, STATIC_CONTEXT, SYSTEM_PROMPT } from './prompts'

// `--bench <wav>`: replay a wav through the pipeline and print p50/p95 for each
// stage boundary. This is how the port gets validated — everything else is
// unverifiable without a real call.
//
// Frames are fed at their natural 32ms cadence so the 200ms debounce and the
// llama slot behave the way they would on a live call. A 20s wav takes ~20s.

const STAGES = ['vad', 'stt', 'speculate', 'ttft', 'paint'] as const
type Stage = (typeof STAGES)[number]

export async function runBench(wav: string | undefined): Promise<void> {
  if (wav === undefined) {
    console.error('usage: --bench <file.wav>')
    return
  }
  const models = checkModels()
  if (!models.silero || !models.zipformer) {
    console.error(`models missing in ${paths.models}: need silero_vad.onnx + zipformer-streaming/. See README step 2.`)
    return
  }

  const mono = toMono16k(parseWav(readFileSync(wav)))
  const frames = toFrames(mono)
  console.log(`bench: ${wav} -> ${frames.length} frames (${(frames.length * FRAME_MS) / 1000}s @16k mono)`)

  const llm = new LlamaClient(paths.llamaBase)
  if (!(await llm.health())) {
    console.warn(`warning: llama-server not answering at ${paths.llamaBase}/health — ttft/paint stages will be empty.`)
  }

  const playbook = loadPlaybook()
  const state = new TranscriptState(SYSTEM_PROMPT, STATIC_CONTEXT, MAX_TURNS)
  const samples: Record<Stage, number[]> = { vad: [], stt: [], speculate: [], ttft: [], paint: [] }

  // Per-speculation correlation timestamps.
  let lastInterimAt = 0
  let specAt = 0
  let firstTokenAt = 0
  let awaitingFirstToken = false
  let awaitingPaint = false

  const engine = new HintEngine(llm, playbook, state, (hint) => {
    if (hint.source === 'GENERATED' && awaitingPaint) {
      samples.paint.push(now() - firstTokenAt)
      awaitingPaint = false
    }
  })
  engine.onSpeculate = () => {
    specAt = now()
    samples.speculate.push(specAt - lastInterimAt)
    awaitingFirstToken = true
  }
  engine.onFirstToken = () => {
    if (!awaitingFirstToken) return
    firstTokenAt = now()
    samples.ttft.push(firstTokenAt - specAt)
    awaitingFirstToken = false
    awaitingPaint = true
  }

  const vad = await SileroVad.create(paths.silero)
  const stt = new SherpaStt(paths.zipformer)

  await llm.warm(SYSTEM_PROMPT)

  for (const frame of frames) {
    const t0 = now()
    const ev = await vad.accept(frame)
    samples.vad.push(now() - t0)

    if (ev === 'SPEECH_START' || ev === 'SPEECH') {
      const t1 = now()
      stt.accept(frame)
      const interim = stt.interim()
      samples.stt.push(now() - t1)
      state.live('THEM', interim)
      lastInterimAt = now()
      engine.onTranscriptUpdate()
    } else if (ev === 'TURN_END') {
      stt.accept(frame)
      engine.onTurnEnd('THEM', stt.finish())
    }
    await delay(FRAME_MS)
  }

  // Let the last in-flight speculation land.
  await delay(500)
  engine.shutdown()
  stt.close()

  report(samples)
}

function loadPlaybook(): Playbook {
  try {
    return Playbook.parse(readFileSync(playbookPath(), 'utf8'))
  } catch {
    return Playbook.parse('')
  }
}

function report(samples: Record<Stage, number[]>): void {
  console.log('\nstage boundary        n     p50(ms)   p95(ms)')
  console.log('----------------------------------------------')
  const labels: Record<Stage, string> = {
    vad: 'frame_in -> vad_out',
    stt: 'vad_out -> stt_interim',
    speculate: 'stt_interim -> speculate',
    ttft: 'speculate -> first_token',
    paint: 'first_token -> painted',
  }
  for (const stage of STAGES) {
    const xs = samples[stage]
    const p50 = pct(xs, 50)
    const p95 = pct(xs, 95)
    console.log(
      `${labels[stage].padEnd(24)}${String(xs.length).padStart(4)}   ${fmt(p50).padStart(8)}  ${fmt(p95).padStart(8)}`,
    )
  }
}

function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? null
}

function fmt(x: number | null): string {
  return x === null ? '—' : x.toFixed(1)
}

function now(): number {
  return performance.now()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
