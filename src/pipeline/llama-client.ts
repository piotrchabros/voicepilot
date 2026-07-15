// Talks to a local llama-server over SSE. Port of LlamaClient.java.
//
// Launch it like this — every flag here is load-bearing:
//
//   llama-server \
//     -m ~/models/Qwen3-4B-Instruct-Q4_K_M.gguf \
//     --host 127.0.0.1 --port 8080 \
//     --n-gpu-layers 99 \        # Metal. Without this you're on CPU and it's over.
//     --parallel 1 \             # ONE slot. One slot = one KV cache = it stays warm.
//     --ctx-size 8192 \
//     --cache-reuse 256          # reuse the cached prefix instead of re-prefilling
//
// The whole game is `cache_prompt: true` + a pinned slot (`id_slot: 0`) + an
// append-only prompt. Get that right and TTFT is ~30-50ms because you only
// prefill the NEW tokens. Get it wrong — mutate anything in the middle of the
// prompt — and you re-prefill 4k tokens on every keystroke of speech and end up
// SLOWER than a cloud API.

/** A cancellable in-flight generation. `cancel()` must actually abort the fetch. */
export interface Generation {
  /** Abort the generation. Idempotent. */
  cancel(): void
  /** Resolves when the stream ends (naturally, by stop, or by abort). Never rejects. */
  readonly done: Promise<void>
  readonly isCancelled: () => boolean
}

export interface StreamOptions {
  /** Fired once, when the first content token arrives — used for the TTFT metric. */
  onFirstToken?: () => void
}

export class LlamaClient {
  private readonly base: string

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '')
  }

  /**
   * Streams a hint. Returns a handle you can cancel — and you will cancel it,
   * constantly, because interim transcripts get revised and most speculations
   * are wrong. That's fine. Locally, a wasted generation costs electricity.
   */
  streamHint(prompt: string, onToken: (tok: string) => void, opts: StreamOptions = {}): Generation {
    const controller = new AbortController()
    let cancelled = false

    // Every field here is carried over from the Java client verbatim. Do not drop
    // any of them: cache_prompt + id_slot are the warm-slot mechanism; n_predict
    // caps rambling; stop ends the hint at the first newline or </hint>.
    const body = {
      prompt,
      stream: true,
      cache_prompt: true, // <- the entire point
      id_slot: 0, // <- pin to the warm slot
      n_predict: 24, // hints are <=10 words; don't let it ramble
      temperature: 0.3,
      top_p: 0.9,
      stop: ['\n', '</hint>'],
    }

    const done = this.run(body, onToken, controller.signal, () => cancelled, opts).catch(() => {
      // Aborted generations are SUPPOSED to die. Swallow — no retry, no backoff.
    })

    return {
      cancel: () => {
        if (cancelled) return
        cancelled = true
        controller.abort()
      },
      done,
      isCancelled: () => cancelled,
    }
  }

  private async run(
    body: unknown,
    onToken: (tok: string) => void,
    signal: AbortSignal,
    isCancelled: () => boolean,
    opts: StreamOptions,
  ): Promise<void> {
    const res = await fetch(`${this.base}/completion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || res.body === null) {
      throw new Error(`llama-server /completion -> ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let firstSeen = false

    try {
      for (;;) {
        // Check the abort signal in the SSE loop BEFORE dispatching each chunk —
        // a cancelled generation must not paint another token.
        if (isCancelled()) return
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        // SSE frames are separated by blank lines; each frame has "data: <json>".
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data: ')) continue
          if (isCancelled()) return
          const payload = line.slice(6)
          if (payload === '[DONE]') return
          let tok = ''
          let stop = false
          try {
            const n = JSON.parse(payload) as { content?: string; stop?: boolean }
            tok = n.content ?? ''
            stop = n.stop === true
          } catch {
            continue // half-written frame or keep-alive; skip
          }
          if (tok.length > 0) {
            if (!firstSeen) {
              firstSeen = true
              opts.onFirstToken?.()
            }
            onToken(tok)
          }
          if (stop) return
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  /** Fire once at startup so the model is resident and the prefix is cached. */
  async warm(systemPrefix: string): Promise<void> {
    try {
      await this.streamHint(systemPrefix, () => {}).done
    } catch {
      /* ignore */
    }
  }

  /** Supervisor helper: is the server up and a model loaded? */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(1000) })
      return res.ok
    } catch {
      return false
    }
  }
}
