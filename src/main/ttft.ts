import { LlamaClient } from '../pipeline/llama-client'
import { TranscriptState } from '../pipeline/transcript-state'
import { paths } from './config'
import { MAX_TURNS, STATIC_CONTEXT, SYSTEM_PROMPT } from './prompts'

// Gate 2 — verify TTFT against a warm server (PORT.md step 4).
//
// Drives the REAL LlamaClient + TranscriptState rendering. Two phases:
//   A. append-only (cache-friendly): interims extend the transcript, so only the
//      new tokens are prefilled -> TTFT should be double-digit ms.
//   B. cache-busting control: a unique prefix is prepended each time, forcing a
//      full re-prefill -> TTFT balloons. This is what a broken prefix would do
//      to phase A, so it proves the cache is what's saving us.
//
// Pass condition: phase A p50 TTFT < ~100ms (and A << B).

const INTERIMS = [
  'to jest',
  'to jest dla nas',
  'to jest dla nas za',
  'to jest dla nas za drogo',
  'to jest dla nas za drogo w tym',
  'to jest dla nas za drogo w tym kwartale',
  'to jest dla nas za drogo w tym kwartale i musimy',
  'to jest dla nas za drogo w tym kwartale i musimy pogadac z zespolem',
]

export async function runTtft(): Promise<void> {
  const llm = new LlamaClient(paths.llamaBase)

  process.stdout.write(`waiting for llama-server at ${paths.llamaBase} ...`)
  const ready = await waitHealthy(llm, 600_000)
  process.stdout.write(ready ? ' ok\n' : ' TIMEOUT\n')
  if (!ready) {
    console.error(`llama-server never became healthy. Start it, then re-run.`)
    return
  }

  // Prime: model resident + system prefix cached.
  await llm.warm(SYSTEM_PROMPT)

  // Phase A — append-only speculation (the real path).
  const state = new TranscriptState(SYSTEM_PROMPT, STATIC_CONTEXT, MAX_TURNS)
  const aTtft: number[] = []
  for (const interim of INTERIMS) {
    state.live('THEM', interim)
    aTtft.push(await measureTtft(llm, state.renderPrompt()))
  }

  // Phase B — cache-busting control (prepend a unique line each time).
  const bTtft: number[] = []
  for (let i = 0; i < 4; i++) {
    const busted = `<!-- run ${i} salt ${'x'.repeat(i * 7 + 3)} -->\n${state.renderPrompt()}`
    bTtft.push(await measureTtft(llm, busted))
  }

  report('A: append-only (cache-friendly)', aTtft)
  report('B: cache-busting control', bTtft)

  const aP50 = pct(aTtft, 50) ?? Infinity
  const bMed = pct(bTtft, 50) ?? 0
  console.log('\n----------------------------------------------')
  if (aP50 < 100) {
    console.log(`GATE 2 PASS ✅  append-only p50 TTFT = ${aP50.toFixed(1)}ms (< 100ms)`)
    console.log(`prefix cache is working: control is ${(bMed / Math.max(aP50, 0.1)).toFixed(1)}× slower.`)
  } else {
    console.log(`GATE 2 FAIL ❌  append-only p50 TTFT = ${aP50.toFixed(1)}ms (>= 100ms)`)
    console.log('the prefix cache is not helping — something mutates the prompt prefix. Investigate.')
  }
}

async function measureTtft(llm: LlamaClient, prompt: string): Promise<number> {
  const t0 = performance.now()
  let ttft = Number.NaN
  const gen = llm.streamHint(prompt, () => {}, {
    onFirstToken: () => {
      ttft = performance.now() - t0
    },
  })
  await gen.done
  return Number.isNaN(ttft) ? performance.now() - t0 : ttft
}

async function waitHealthy(llm: LlamaClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await llm.health()) return true
    await delay(1000)
    process.stdout.write('.')
  }
  return false
}

function report(label: string, xs: number[]): void {
  const p50 = pct(xs, 50)
  const p95 = pct(xs, 95)
  const min = xs.length ? Math.min(...xs) : null
  console.log(`\n${label}`)
  console.log(`  n=${xs.length}  min=${fmt(min)}  p50=${fmt(p50)}  p95=${fmt(p95)}  (ms)`)
  console.log(`  samples: ${xs.map((x) => x.toFixed(0)).join(', ')}`)
}

function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? null
}

function fmt(x: number | null): string {
  return x === null ? '—' : x.toFixed(1)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
