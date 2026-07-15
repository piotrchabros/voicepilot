// Pull-based async wrapper around `FileAudioSource`, extracted so the frame
// *supply* cadence used by `--bench` can be unit-tested without the
// electron-dependent pipeline stages (vad/stt/llama-client, transitively via
// `main/config.ts`'s `import { app } from 'electron'`) that `--bench` also
// drives. Frames arrive at the source's own pace (real time by default);
// `for await` consumers pull one at a time, so slow per-frame processing
// never drops or reorders frames — it just falls behind and drains the
// already-arrived backlog on the next pull.

import type { AudioFrame } from '@shared/audio-source'
import { FileAudioSource, type FileAudioSourceOptions } from './file-audio-source'

/** Streams a wav file's frames via `FileAudioSource`, in order, one at a time. */
export async function* streamFrames(
  wavPath: string,
  opts?: FileAudioSourceOptions
): AsyncGenerator<AudioFrame, void, void> {
  const source = new FileAudioSource(wavPath, opts)
  const queue: AudioFrame[] = []
  let waiter: (() => void) | null = null
  let ended = false
  let healthError: string | null = null

  const wake = (): void => {
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }

  source.on('audio', (frame) => {
    queue.push(frame)
    wake()
  })
  source.on('end', () => {
    ended = true
    wake()
  })
  source.on('health', (status) => {
    if (!status.ok) {
      healthError = status.detail
      wake()
    }
  })

  await source.start()

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      if (healthError !== null) {
        throw new Error(`FileAudioSource health failure: ${healthError}`)
      }
      if (ended) return
      await new Promise<void>((resolve) => {
        waiter = resolve
      })
    }
  } finally {
    await source.stop()
  }
}
