import type { SuggestionTiming } from '@shared/types'
import { FRAME_MS } from '@shared/types'
import { streamFrames } from '../pipeline/frame-stream'
import { HintEngine } from '../pipeline/hint-engine'
import { LlamaClient } from '../pipeline/llama-client'
import { Playbook } from '../pipeline/playbook'
import { SherpaStt } from '../pipeline/stt'
import { StageClock, stageDeltas } from '../pipeline/timing'
import { TranscriptState } from '../pipeline/transcript-state'
import { SileroVad } from '../pipeline/vad'
import { checkModels, paths, playbookDir } from './config'
import { MAX_TURNS, STATIC_CONTEXT, SYSTEM_PROMPT } from './prompts'

// `--bench <wav>`: replay a wav through the pipeline and print p50/p95 for each
// stage boundary, aggregated from Hint.timing (Task 3.3 — same StageClock the
// live pipeline uses, transport tagged 'file' here since this replays via
// FileAudioSource). This is how the port gets validated — everything else is
// unverifiable without a real call.
//
// Frames are fed at their natural 32ms cadence so the 200ms debounce and the
// llama slot behave the way they would on a live call. A 20s wav takes ~20s.

/** Ordered (label, printed heading) pairs — same order/labels as the original
 *  bench report, so existing output consumers see an unchanged table shape
 *  plus one new trailing column. */
const STAGE_ROWS: readonly (readonly [string, string])[] = [
  ['frame_in->vad_out', 'frame_in -> vad_out'],
  ['vad_out->stt_interim', 'vad_out -> stt_interim'],
  ['stt_interim->speculate_fired', 'stt_interim -> speculate'],
  ['speculate_fired->first_token', 'speculate -> first_token'],
  ['first_token->painted', 'first_token -> painted']
]

export async function runBench(wav: string | undefined): Promise<void> {
  if (wav === undefined) {
    console.error('usage: --bench <file.wav>')
    return
  }
  const models = checkModels()
  if (!models.silero || !models.zipformer) {
    console.error(
      `models missing in ${paths.models}: need silero_vad.onnx + zipformer-streaming/. See README step 2.`
    )
    return
  }

  console.log(`bench: ${wav} -> streaming frames at natural cadence (~${FRAME_MS}ms/frame)`)

  const llm = new LlamaClient(paths.llamaBase)
  if (!(await llm.health())) {
    console.warn(
      `warning: llama-server not answering at ${paths.llamaBase}/health — ttft/paint stages will be empty.`
    )
  }

  const playbook = loadPlaybook()
  const state = new TranscriptState(SYSTEM_PROMPT, STATIC_CONTEXT, MAX_TURNS)
  const clock = new StageClock()
  const timings: SuggestionTiming[] = []
  let awaitingPaint = false

  const engine = new HintEngine(
    llm,
    playbook,
    state,
    (hint) => {
      if (hint.source === 'GENERATED' && awaitingPaint) {
        clock.mark('painted')
        const snap = clock.snapshot()
        if (snap !== null) timings.push(snap)
        awaitingPaint = false
      }
    },
    clock
  )
  engine.onFirstToken = () => {
    awaitingPaint = true
  }

  const vad = await SileroVad.create(paths.silero)
  const stt = new SherpaStt(paths.zipformer)

  await llm.warm(SYSTEM_PROMPT)

  // Frames are supplied by `FileAudioSource` (via the pure `streamFrames`
  // wrapper) at their natural 32ms cadence, so the 200ms debounce and the
  // llama slot behave the way they would on a live call. Counted here (as
  // they're consumed) rather than via a separate upfront wav parse, so the
  // file is only ever parsed once (inside `FileAudioSource`).
  let frameCount = 0
  for await (const frame of streamFrames(wav, { realtime: true })) {
    frameCount++
    clock.beginTurn('file')
    const ev = await vad.accept(frame.pcm)
    clock.mark('vad_out')

    if (ev === 'SPEECH_START' || ev === 'SPEECH') {
      stt.accept(frame.pcm)
      const interim = stt.interim()
      clock.mark('stt_interim')
      state.live('THEM', interim)
      engine.onTranscriptUpdate()
    } else if (ev === 'TURN_END') {
      stt.accept(frame.pcm)
      engine.onTurnEnd('THEM', await stt.finish())
    }
  }
  console.log(
    `bench: processed ${frameCount} frames (${(frameCount * FRAME_MS) / 1000}s @16k mono)`
  )

  // Let the last in-flight speculation land.
  await delay(500)
  engine.shutdown()
  stt.close()

  report(timings)
}

function loadPlaybook(): Playbook {
  return Playbook.load(playbookDir())
}

/** Pure aggregation + print: exported so it can be unit-tested with fixture
 *  `SuggestionTiming[]` instead of a real model/wav run. */
export function report(timings: readonly SuggestionTiming[]): void {
  console.log('\nstage boundary        n     p50(ms)   p95(ms)   transport')
  console.log('---------------------------------------------------------')
  const buckets = new Map<string, number[]>()
  const transports = new Set<string>()
  for (const timing of timings) {
    transports.add(timing.transport)
    for (const delta of stageDeltas(timing)) {
      const arr = buckets.get(delta.label) ?? []
      arr.push(delta.ms)
      buckets.set(delta.label, arr)
    }
  }
  const transportTag = transports.size === 0 ? '—' : [...transports].sort().join(',')
  for (const [label, heading] of STAGE_ROWS) {
    const xs = buckets.get(label) ?? []
    const p50 = pct(xs, 50)
    const p95 = pct(xs, 95)
    console.log(
      `${heading.padEnd(24)}${String(xs.length).padStart(4)}   ${fmt(p50).padStart(8)}  ${fmt(p95).padStart(8)}   ${transportTag}`
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
