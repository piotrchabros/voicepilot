import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { LEG_MIC, LEG_SYSTEM, type Leg, RECORD_BYTES } from '@shared/types'

export interface SidecarDeps {
  binary: string
  onFrame: (leg: Leg, samples: ArrayBuffer) => void
  onLog: (level: string, msg: string, code?: string) => void
  onExit: (code: number | null) => void
}

/**
 * Spawns the Swift capture sidecar and demuxes its stdout stream of fixed
 * 2049-byte records (1 leg byte + 512 Float32 LE) into frames. stderr is
 * newline-delimited JSON log/permission lines — never PCM.
 */
export class Sidecar {
  private proc: ChildProcess | null = null
  private buf: Buffer = Buffer.alloc(0)
  private readonly deps: SidecarDeps

  constructor(deps: SidecarDeps) {
    this.deps = deps
  }

  start(): boolean {
    if (!existsSync(this.deps.binary)) {
      this.deps.onLog(
        'error',
        `capture sidecar not built at ${this.deps.binary} — run: npm run sidecar`,
        'sidecar-missing'
      )
      return false
    }
    const proc = spawn(this.deps.binary, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk))
    proc.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk))
    proc.on('exit', (code) => {
      this.proc = null
      this.deps.onExit(code)
    })
    proc.on('error', (err) => {
      this.deps.onLog('error', `sidecar spawn error: ${err.message}`, 'sidecar-spawn')
    })
    return true
  }

  private onStdout(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    // Drain as many whole records as we have. Fixed size => no framing parser.
    let offset = 0
    while (this.buf.length - offset >= RECORD_BYTES) {
      const legByte = this.buf[offset]
      const leg: Leg = legByte === LEG_SYSTEM ? LEG_SYSTEM : LEG_MIC
      // Copy the 2048 PCM bytes into a standalone ArrayBuffer for the child.
      const ab = new ArrayBuffer(RECORD_BYTES - 1)
      new Uint8Array(ab).set(this.buf.subarray(offset + 1, offset + RECORD_BYTES))
      this.deps.onFrame(leg, ab)
      offset += RECORD_BYTES
    }
    this.buf = offset === 0 ? this.buf : this.buf.subarray(offset)
  }

  private onStderr(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const obj = JSON.parse(trimmed) as { level?: string; msg?: string; code?: string }
        this.deps.onLog(obj.level ?? 'info', obj.msg ?? trimmed, obj.code)
      } catch {
        this.deps.onLog('info', trimmed)
      }
    }
  }

  stop(): void {
    this.proc?.kill('SIGTERM')
    this.proc = null
  }
}
