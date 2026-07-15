import WebSocket from 'ws'
import type { SttEngine } from './stt-engine'

/**
 * Soniox real-time STT over WebSocket. Cloud engine — a deliberate scope change
 * from PORT.md's local-only rule, made because no local Polish STREAMING model
 * exists (user decision, 2026-07-15). The speculative-LLM economics are
 * unaffected: audio streams to STT once regardless of how many hints we cancel.
 *
 * Protocol (soniox.com/docs/api-reference/stt/websocket-api):
 *   1. connect wss://stt-rt.soniox.com/transcribe-websocket
 *   2. first message = JSON config (api_key, model, raw PCM format...)
 *   3. then binary frames of pcm_s16le audio
 *   4. responses carry tokens; is_final tokens are append-once, non-final tokens
 *      are replaced by each response
 *   5. {"type":"finalize"} forces everything sent so far to finalize (turn end)
 *   6. {"type":"keepalive"} must flow at least every ~20s when audio is gated
 *
 * Billing note: Soniox charges for STREAM DURATION, not audio content — so we
 * run lazy sessions: connect on first speech frame, keepalive through short
 * pauses, hang up after IDLE_CLOSE_MS of silence, reconnect on the next
 * utterance. The backlog buffer absorbs the ~300ms reconnect latency, so no
 * speech is lost.
 */

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
const MODEL = 'stt-rt-v4'
/** How long finish() waits for the finalize response before settling anyway. */
const FINALIZE_GRACE_MS = 600
/** Keepalive cadence while a session is open but VAD is gating audio. */
const KEEPALIVE_EVERY_MS = 10_000
/** Hang up after this much silence — reconnect lazily on the next utterance. */
const IDLE_CLOSE_MS = 30_000
/** Max buffered speech while (re)connecting: 300 frames ≈ 10s. */
const MAX_BACKLOG_FRAMES = 300

interface SonioxToken {
  text?: string
  is_final?: boolean
}
interface SonioxResponse {
  tokens?: SonioxToken[]
  error_code?: string
  error_message?: string
  finished?: boolean
}

/** Pure token assembly: finals append once, non-finals replace per response. */
export class TokenTracker {
  private finals = ''
  private nonFinal = ''

  onTokens(tokens: SonioxToken[]): void {
    this.nonFinal = ''
    for (const t of tokens) {
      if (t.text === undefined || t.text.length === 0) continue
      // Soniox emits control markers (<fin>, <end>) as tokens — not transcript.
      if (t.text.startsWith('<') && t.text.endsWith('>')) continue
      if (t.is_final === true) this.finals += t.text
      else this.nonFinal += t.text
    }
  }

  text(): string {
    return (this.finals + this.nonFinal).trim()
  }

  reset(): void {
    this.finals = ''
    this.nonFinal = ''
  }
}

export interface SonioxOptions {
  apiKey: string
  languageHints?: string[]
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export class SonioxStt implements SttEngine {
  private readonly opts: SonioxOptions
  private ws: WebSocket | null = null
  private open = false
  private connecting = false
  private closedForever = false
  private readonly tracker = new TokenTracker()
  /** Frames buffered while the socket is (re)connecting. */
  private backlog: Buffer[] = []
  private lastMessageAt = 0
  private lastAudioAt = 0
  private lastSentAt = 0
  private readonly housekeeper: ReturnType<typeof setInterval>

  constructor(opts: SonioxOptions) {
    this.opts = opts
    // Lazy: no connection until the first speech frame arrives.
    this.housekeeper = setInterval(() => this.housekeep(), 5_000)
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.opts.onLog?.(level, `soniox: ${msg}`)
  }

  private connect(): void {
    if (this.closedForever || this.connecting || this.ws !== null) return
    this.connecting = true
    const ws = new WebSocket(SONIOX_URL)
    this.ws = ws

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          api_key: this.opts.apiKey,
          model: MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: 16_000,
          num_channels: 1,
          language_hints: this.opts.languageHints ?? ['pl', 'en'],
          // VAD owns endpointing (two components racing to decide when the turn
          // ended is a bug you'll spend a week not finding) — leave Soniox's off.
          enable_endpoint_detection: false,
        }),
      )
      this.open = true
      this.connecting = false
      this.lastSentAt = Date.now()
      this.log('info', `session opened (${MODEL}), backlog=${this.backlog.length} frames`)
      for (const buf of this.backlog) ws.send(buf)
      this.backlog = []
    })

    ws.on('message', (data: WebSocket.RawData) => {
      this.lastMessageAt = Date.now()
      let res: SonioxResponse
      try {
        res = JSON.parse(data.toString()) as SonioxResponse
      } catch {
        return
      }
      if (res.error_code !== undefined) {
        this.log('warn', `${res.error_code}: ${res.error_message ?? ''}`)
        return
      }
      if (res.tokens !== undefined) this.tracker.onTokens(res.tokens)
    })

    ws.on('error', (err: Error) => this.log('warn', `ws error: ${err.message}`))

    ws.on('close', () => {
      // No eager reconnect: the next speech frame reconnects lazily, and the
      // backlog holds it in the meantime. Keeps billing bounded to speech.
      this.open = false
      this.connecting = false
      this.ws = null
    })
  }

  /** Keepalive through short pauses; hang up entirely after long silence. */
  private housekeep(): void {
    if (!this.open || this.ws === null) return
    const now = Date.now()
    if (now - this.lastAudioAt > IDLE_CLOSE_MS) {
      this.log('info', 'idle — closing session (will reconnect on next speech)')
      this.hangup()
      return
    }
    if (now - this.lastSentAt > KEEPALIVE_EVERY_MS) {
      this.ws.send(JSON.stringify({ type: 'keepalive' }))
      this.lastSentAt = now
    }
  }

  private hangup(): void {
    if (this.ws !== null) {
      try {
        this.ws.send(Buffer.alloc(0)) // graceful end-of-session
      } catch {
        /* already gone */
      }
      this.ws.close()
    }
    this.open = false
    this.connecting = false
    this.ws = null
  }

  accept(frame: Float32Array): void {
    this.lastAudioAt = Date.now()
    // Float32 [-1,1] -> pcm_s16le
    const pcm = Buffer.allocUnsafe(frame.length * 2)
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i] ?? 0))
      pcm.writeInt16LE(Math.round(s * 32767), i * 2)
    }
    if (this.open && this.ws !== null) {
      this.ws.send(pcm)
      this.lastSentAt = this.lastAudioAt
    } else {
      if (this.backlog.length < MAX_BACKLOG_FRAMES) this.backlog.push(pcm)
      this.connect() // lazy (re)connect on speech
    }
  }

  interim(): string {
    return this.tracker.text()
  }

  async finish(): Promise<string> {
    // Ask the server to finalize everything sent so far, then give the response
    // a short grace window to land — the tail of the turn firms up in it.
    if (this.open && this.ws !== null) {
      const sentAt = Date.now()
      this.ws.send(JSON.stringify({ type: 'finalize' }))
      this.lastSentAt = sentAt
      await this.waitForMessageAfter(sentAt, FINALIZE_GRACE_MS)
    }
    const text = this.tracker.text()
    this.tracker.reset()
    return text
  }

  private waitForMessageAfter(since: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = (): void => {
        if (this.lastMessageAt > since || Date.now() - started >= timeoutMs) resolve()
        else setTimeout(tick, 40)
      }
      tick()
    })
  }

  close(): void {
    this.closedForever = true
    clearInterval(this.housekeeper)
    this.hangup()
  }
}
