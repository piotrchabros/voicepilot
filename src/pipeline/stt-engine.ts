/**
 * Keep this interface between you and any vendor. You WILL swap engines — Polish
 * WER is where they all diverge and none of the published benchmarks will tell
 * you which one wins on your actual calls. Port of SttEngine.java.
 *
 * finish() is async because offline (pseudo-streaming) engines like Parakeet do
 * their final decode on turn-end; a sync decode would stall both capture legs.
 */
export interface SttEngine {
  /** Feed 32ms of 16kHz mono float PCM. */
  accept(frame: Float32Array): void

  /** Current best guess for the in-progress turn. Revised constantly — never final. */
  interim(): string

  /** Call on VAD TURN_END. Resolves the settled text and resets the stream. */
  finish(): Promise<string>

  close(): void
}
