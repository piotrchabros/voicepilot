// utilityProcess entry: VAD -> STT -> HintEngine -> LlamaClient. Runs OFF the
// Electron main thread so ONNX inference never janks the overlay. This mirrors
// Main.java's leg() wiring: ONE shared TranscriptState + HintEngine + LlamaClient
// + Playbook, and a SEPARATE SileroVad + SttEngine per capture leg.

import {
  type FrameMsg,
  type FromPipeline,
  type Hint,
  type InitMsg,
  type Leg,
  type Speaker,
  speakerOf,
  type ToPipeline
} from '@shared/types'
import { HintEngine } from './hint-engine'
import { LlamaClient } from './llama-client'
import { Playbook } from './playbook'
import { SherpaStt } from './stt'
import type { SttEngine } from './stt-engine'
import { SonioxStt } from './stt-soniox'
import { TranscriptState } from './transcript-state'
import { SileroVad } from './vad'

// Electron gives a utilityProcess child a `process.parentPort`. Type the sliver
// we use (structured-clone messages in, postMessage out).
interface MessageEvent<T> {
  data: T
}
interface ParentPort {
  on(event: 'message', cb: (e: MessageEvent<ToPipeline>) => void): void
  postMessage(msg: FromPipeline): void
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

function send(msg: FromPipeline): void {
  parentPort?.postMessage(msg)
}
function log(level: 'info' | 'warn' | 'error', msg: string): void {
  send({ type: 'log', level, msg })
}

// spec.md §4.4 (Compliance & security, "Log hygiene"): no transcript/hint text
// in logs outside explicit debug mode; production default logs contain no call
// content. These are pure formatters so log-hygiene.test.ts can pin the
// contract without needing a live parentPort — callers must only invoke `log`
// with the (possibly null) result, never build the string inline.
export function formatTurnEndLog(who: Speaker, finalText: string, debug: boolean): string | null {
  return debug ? `${who}: turn end -> "${finalText}"` : null
}

export function formatHintLog(hint: Hint, debug: boolean): string | null {
  return debug ? `hint[${hint.source}] "${hint.text}"` : null
}

interface LegRuntime {
  who: Speaker
  vad: SileroVad
  stt: SttEngine
  // Per-leg serial processing chain — frames must be handled in order so VAD
  // recurrent state and STT stream stay consistent.
  tail: Promise<void>
  // Debug counters (COPILOT_DEBUG).
  rx: number
  maxProb: number
  sumAbs: number
}

const DEBUG = process.env['COPILOT_DEBUG'] === '1'

let engine: HintEngine | null = null
let state: TranscriptState | null = null
const legs = new Map<Leg, LegRuntime>()

async function init(cfg: InitMsg): Promise<void> {
  try {
    const playbook = Playbook.parse(cfg.playbookTsv)
    state = new TranscriptState(`${cfg.systemPrompt}`, cfg.staticContext, cfg.maxTurns)
    const llm = new LlamaClient(cfg.llamaBase)

    engine = new HintEngine(llm, playbook, state, (hint) => {
      const hintLog = formatHintLog(hint, DEBUG)
      if (hintLog !== null) log('info', hintLog)
      send({ type: 'hint', hint })
    })

    // One VAD + STT per leg. Mic = ME, system = THEM. Soniox (cloud, Polish)
    // when a key is configured; local English zipformer otherwise.
    // COPILOT_MIC_SPECULATE=1 (solo testing): the mic leg plays the CUSTOMER —
    // its transcript renders as "Them:" so the prompt makes sense to the LLM.
    const micAsThem = process.env['COPILOT_MIC_SPECULATE'] === '1'
    for (const leg of [0x00, 0x01] as Leg[]) {
      const vad = await SileroVad.create(cfg.sileroPath)
      const stt: SttEngine =
        cfg.sonioxApiKey !== null
          ? new SonioxStt({
              apiKey: cfg.sonioxApiKey,
              wsUrl: cfg.sonioxWsUrl,
              languageHints: [...cfg.sonioxLanguageHints],
              onLog: (level, msg) => log(level, msg)
            })
          : new SherpaStt(cfg.zipformerDir)
      legs.set(leg, {
        who: micAsThem && leg === 0x00 ? 'THEM' : speakerOf(leg),
        vad,
        stt,
        tail: Promise.resolve(),
        rx: 0,
        maxProb: 0,
        sumAbs: 0
      })
    }

    // Prefill the immutable prefix once at startup so the first real turn isn't
    // the one that pays for it.
    await llm.warm(cfg.systemPrompt)

    send({ type: 'ready' })
    log('info', 'pipeline ready')
  } catch (err) {
    log('error', `pipeline init failed: ${err instanceof Error ? err.message : String(err)}`)
    engine = null
  }
}

function onFrame(msg: FrameMsg): void {
  const leg = legs.get(msg.leg)
  if (leg === null || leg === undefined || engine === null || state === null) return
  const samples = new Float32Array(msg.samples)
  // Enqueue on the per-leg chain to serialize async VAD/STT.
  leg.tail = leg.tail
    .then(() => processFrame(leg, samples))
    .catch((err) => {
      log('error', `frame processing error: ${err instanceof Error ? err.message : String(err)}`)
    })
}

async function processFrame(leg: LegRuntime, samples: Float32Array): Promise<void> {
  if (engine === null || state === null) return
  const ev = await leg.vad.accept(samples)

  if (DEBUG) {
    leg.rx++
    let s = 0
    for (const x of samples) s += Math.abs(x)
    leg.sumAbs += s / samples.length
    if (leg.vad.lastProb > leg.maxProb) leg.maxProb = leg.vad.lastProb
    if (leg.rx % 62 === 0) {
      // ~2s of frames. level = mean |sample| (0 => silence/no signal).
      log(
        'info',
        `${leg.who}: rx=${leg.rx} level=${(leg.sumAbs / 62).toFixed(4)} vadMax=${leg.maxProb.toFixed(2)}`
      )
      leg.maxProb = 0
      leg.sumAbs = 0
    }
  }

  switch (ev) {
    case 'SILENCE':
      // don't burn STT cycles on room tone
      break
    case 'SPEECH_START':
      if (DEBUG) log('info', `${leg.who}: speech start`)
    // falls through
    case 'SPEECH': {
      leg.stt.accept(samples)
      state.live(leg.who, leg.stt.interim())
      // Only speculate on THEIR speech. Hinting at yourself mid-sentence is just
      // distracting. (In COPILOT_MIC_SPECULATE test mode the mic leg IS 'THEM'.)
      if (leg.who === 'THEM') engine.onTranscriptUpdate()
      break
    }
    case 'TURN_END': {
      leg.stt.accept(samples)
      const finalText = await leg.stt.finish()
      const turnEndLog = formatTurnEndLog(leg.who, finalText, DEBUG)
      if (turnEndLog !== null) log('info', turnEndLog)
      engine.onTurnEnd(leg.who, finalText)
      break
    }
  }
}

function shutdown(): void {
  engine?.shutdown()
  for (const leg of legs.values()) leg.stt.close()
  legs.clear()
}

parentPort?.on('message', (e) => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      void init(msg)
      break
    case 'frame':
      onFrame(msg)
      break
    case 'control':
      if (msg.action === 'shutdown') shutdown()
      break
  }
})
