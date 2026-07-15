import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface LlamaDeps {
  base: string
  modelPath: string
  binary?: string // defaults to `llama-server` on PATH
  onLog: (level: string, msg: string, code?: string) => void
}

/**
 * Supervises a local llama-server. Spawns it if it isn't already answering
 * /health, polls until ready, and surfaces a clear error if the model is missing.
 *
 * Flags are carried over EXACTLY from LlamaClient.java's header comment — every
 * one is load-bearing, especially `--parallel 1` (one slot = one warm KV cache).
 */
export class LlamaSupervisor {
  private proc: ChildProcess | null = null
  private spawnedByUs = false
  private readonly deps: LlamaDeps

  constructor(deps: LlamaDeps) {
    this.deps = deps
  }

  /** Ensure a server is up and a model is loaded. Resolves true when /health is ok. */
  async ensure(timeoutMs = 60_000): Promise<boolean> {
    if (await this.health()) {
      this.deps.onLog('info', 'llama-server already running')
      return true
    }
    if (!existsSync(this.deps.modelPath)) {
      this.deps.onLog('error', `GGUF model missing: ${this.deps.modelPath}`, 'gguf-missing')
      return false
    }
    if (!this.spawn()) return false
    return this.waitHealthy(timeoutMs)
  }

  private spawn(): boolean {
    const bin = this.deps.binary ?? 'llama-server'
    const args = [
      '-m', this.deps.modelPath,
      '--host', '127.0.0.1',
      '--port', String(new URL(this.deps.base).port || '8080'),
      '--n-gpu-layers', '99', // Metal. Without this you're on CPU and it's over.
      '--parallel', '1', // ONE slot. One slot = one KV cache = it stays warm.
      '--ctx-size', '8192',
      '--cache-reuse', '256', // reuse the cached prefix instead of re-prefilling
    ]
    try {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.proc = proc
      this.spawnedByUs = true
      proc.stderr?.on('data', (c: Buffer) => {
        const line = c.toString('utf8').trim()
        if (line.length > 0) this.deps.onLog('info', `llama: ${line.split('\n').at(-1)}`)
      })
      proc.on('error', (err) => {
        this.deps.onLog(
          'error',
          `could not start llama-server (${bin}): ${err.message}. Install llama.cpp (brew install llama.cpp).`,
          'llama-spawn',
        )
      })
      proc.on('exit', (code) => {
        this.deps.onLog(code === 0 ? 'info' : 'warn', `llama-server exited (${code})`)
        this.proc = null
      })
      return true
    } catch (err) {
      this.deps.onLog('error', `llama-server spawn threw: ${String(err)}`, 'llama-spawn')
      return false
    }
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.health()) {
        this.deps.onLog('info', 'llama-server healthy')
        return true
      }
      await delay(500)
    }
    this.deps.onLog('error', 'llama-server did not become healthy in time', 'llama-timeout')
    return false
  }

  private async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.deps.base}/health`, { signal: AbortSignal.timeout(800) })
      return res.ok
    } catch {
      return false
    }
  }

  stop(): void {
    if (this.spawnedByUs) this.proc?.kill('SIGTERM')
    this.proc = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
