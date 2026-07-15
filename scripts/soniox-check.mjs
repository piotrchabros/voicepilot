// Stream a 16k mono PCM16 wav to Soniox real-time API and print the transcript.
// Validates the API key and the protocol end to end, no Electron involved.
//   node scripts/soniox-check.mjs [file.wav]
// Key: SONIOX_API_KEY env or .soniox-key file next to package.json.
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const apiKey =
  process.env.SONIOX_API_KEY?.trim() ||
  (existsSync(join(root, '.soniox-key'))
    ? readFileSync(join(root, '.soniox-key'), 'utf8').trim()
    : '')
if (!apiKey) {
  console.error('No API key. Set SONIOX_API_KEY or create .soniox-key')
  process.exit(1)
}

// EU host allowlist — must stay in sync with EU_SONIOX_HOST in
// src/pipeline/stt-soniox.ts (that's the TS source of truth; this .mjs script
// can't import it directly, so the literal is duplicated here deliberately).
const EU_SONIOX_HOST = 'stt-rt.eu.soniox.com'
const EU_SONIOX_WS_URL = `wss://${EU_SONIOX_HOST}/transcribe-websocket`

function assertEuEndpoint(url) {
  if (!url || url.trim().length === 0) return EU_SONIOX_WS_URL
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    console.error(
      `Invalid Soniox WS URL "${url}" — must be ${EU_SONIOX_WS_URL} (spec.md §4.1, EU data residency).`
    )
    process.exit(1)
  }
  if (parsed.protocol !== 'wss:' || parsed.hostname !== EU_SONIOX_HOST) {
    console.error(
      `Refusing to start: Soniox WS endpoint "${url}" is not the documented EU host. ` +
        `Set SONIOX_WS_URL to ${EU_SONIOX_WS_URL} (spec.md §4.1, EU data residency).`
    )
    process.exit(1)
  }
  return url
}

const wsUrl = assertEuEndpoint(process.env.SONIOX_WS_URL)

const wavPath = process.argv[2] ?? '/tmp/say.wav'
const buf = readFileSync(wavPath)
let ds = 44,
  dl = buf.length - 44,
  off = 12
while (off + 8 <= buf.length) {
  const id = buf.toString('ascii', off, off + 4)
  const size = buf.readUInt32LE(off + 4)
  if (id === 'data') {
    ds = off + 8
    dl = size
    break
  }
  off += 8 + size + (size % 2)
}
const pcm = buf.subarray(ds, Math.min(ds + dl, buf.length))
console.log(`streaming ${wavPath} (${(pcm.length / 32000).toFixed(1)}s) to Soniox...`)

const ws = new WebSocket(wsUrl)
let finals = ''
let nonFinal = ''
const t0 = Date.now()
let firstTokenAt = 0

ws.on('open', async () => {
  ws.send(
    JSON.stringify({
      api_key: apiKey,
      model: 'stt-rt-v4',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['pl', 'en']
    })
  )
  // Stream in real-time-ish chunks (100ms), then end with an empty frame.
  const chunk = 3200
  for (let o = 0; o < pcm.length; o += chunk) {
    ws.send(pcm.subarray(o, Math.min(o + chunk, pcm.length)))
    await new Promise((r) => setTimeout(r, 20)) // 5x real-time
  }
  ws.send(Buffer.alloc(0))
})

ws.on('message', (data) => {
  const res = JSON.parse(data.toString())
  if (res.error_code) {
    console.error(`ERROR ${res.error_code}: ${res.error_message}`)
    ws.close()
    return
  }
  if (res.tokens?.length) {
    if (!firstTokenAt) firstTokenAt = Date.now()
    nonFinal = ''
    for (const t of res.tokens) {
      if (!t.text) continue
      if (t.is_final) finals += t.text
      else nonFinal += t.text
    }
    process.stdout.write(`\r${(finals + nonFinal).trim()}                    `)
  }
  if (res.finished) {
    console.log(`\n\n✅ TRANSCRIPT: "${finals.trim()}"`)
    console.log(`first token after ${firstTokenAt - t0}ms`)
    ws.close()
  }
})

ws.on('error', (e) => {
  console.error('ws error:', e.message)
  process.exit(1)
})
