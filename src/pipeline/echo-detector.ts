// spec.md §5.4 (Echo/headset detection): when the rep uses a speaker instead of
// a headset, the rep's own voice can leak (acoustically or via loopback mixing)
// into the system-audio/loopback leg — the leg we treat as the prospect's
// channel. That leakage makes the rep's words look like prospect speech.
//
// EchoDetector watches for that leak by tracking the *energy envelope* of each
// leg (never raw-sample correlation — far too costly to run per frame) and
// periodically computing a lightweight normalized cross-correlation between
// the two envelopes across a small window of lags. Evaluating *periodically*
// (rather than every single frame on a fully overlapping sliding window)
// matters: an overlapping per-frame window barely changes between checks, so
// once correlation crosses the threshold it tends to stay elevated for many
// consecutive frames just from data reuse — that would make the hysteresis
// gate below meaningless. Spacing the checks out so each one draws on mostly
// fresh frames makes "M checks in a row" a real, independent signal instead of
// an artifact of window overlap.

export type EchoSpeaker = 'rep' | 'prospect'

export interface EchoStatus {
  suspected: boolean
  correlation: number
}

// Aligned samples used per correlation computation.
const CORR_WINDOW = 20
// Lags (in frames) checked for a delayed leak. Frame = 32ms, so this covers
// roughly a 0-160ms leak window — comfortably past any acoustic/soft-loopback delay.
const MAX_LAG = 5
// Only recompute correlation every PERIOD_FRAMES accepted frames (across both
// legs combined). Spacing checks out this way keeps each one close to
// independent — see the module comment above.
const PERIOD_FRAMES = 10
// Correlation above this is considered "same signal".
const THRESHOLD = 0.6
// Consecutive periodic checks required before we call it suspected. This is
// the hysteresis: one lucky spike (e.g. both parties pausing at the same
// moment) must not trip the warning.
const CONSECUTIVE_REQUIRED = 5
// How many recent per-leg energy samples we keep. A little slack past what a
// single correlation computation needs so lag alignment near the retention
// boundary always has real data to read.
const HISTORY_FRAMES = CORR_WINDOW + MAX_LAG + 5

/**
 * Pearson correlation of two equal-length sample arrays. Returns 0 (rather than
 * NaN) when either series has zero variance (e.g. silence) — silence must never
 * read as "correlated".
 */
function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length
  if (n === 0) return 0

  let meanX = 0
  let meanY = 0
  for (let i = 0; i < n; i++) {
    meanX += xs[i]!
    meanY += ys[i]!
  }
  meanX /= n
  meanY /= n

  let num = 0
  let denomX = 0
  let denomY = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    const dy = ys[i]! - meanY
    num += dx * dy
    denomX += dx * dx
    denomY += dy * dy
  }

  const denom = Math.sqrt(denomX * denomY)
  if (denom === 0) return 0
  return num / denom
}

/** Mean squared amplitude of a frame — cheap stand-in for RMS energy. */
function frameEnergy(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (const x of frame) sum += x * x
  return sum / frame.length
}

export class EchoDetector {
  private readonly repEnergy: number[] = []
  private readonly prospectEnergy: number[] = []
  private framesSinceCheck = 0
  private consecutiveHigh = 0
  private suspectedState = false
  private lastCorrelation = 0

  /**
   * Record one frame's energy for the given leg. Correlation is only
   * re-evaluated every PERIOD_FRAMES calls (across both legs combined) — see
   * the module comment for why. Calls in between return the last known status.
   */
  accept(speaker: EchoSpeaker, frame: Float32Array): EchoStatus {
    const energy = frameEnergy(frame)
    const series = speaker === 'rep' ? this.repEnergy : this.prospectEnergy
    series.push(energy)
    if (series.length > HISTORY_FRAMES) series.shift()

    this.framesSinceCheck++
    if (this.framesSinceCheck < PERIOD_FRAMES) {
      return { suspected: this.suspectedState, correlation: this.lastCorrelation }
    }
    this.framesSinceCheck = 0

    const correlation = this.bestLagCorrelation()
    this.lastCorrelation = correlation

    if (correlation > THRESHOLD) {
      this.consecutiveHigh++
    } else {
      this.consecutiveHigh = 0
    }

    if (this.consecutiveHigh >= CONSECUTIVE_REQUIRED) {
      this.suspectedState = true
    }

    return { suspected: this.suspectedState, correlation }
  }

  /** True once a sustained correlation has been observed. Sticky — does not clear itself. */
  get suspected(): boolean {
    return this.suspectedState
  }

  private bestLagCorrelation(): number {
    if (this.repEnergy.length < CORR_WINDOW + MAX_LAG || this.prospectEnergy.length < CORR_WINDOW) {
      return 0
    }

    let best = 0
    for (let lag = 0; lag <= MAX_LAG; lag++) {
      const c = this.corrAtLag(lag)
      if (c > best) best = c
    }
    return best
  }

  /**
   * Correlate the rep leg, delayed by `lag` frames, against the prospect leg's
   * most recent CORR_WINDOW samples. lag=0 catches instant leakage; lag>0
   * catches leakage that arrives a few frames late (buffering/mixing delay).
   */
  private corrAtLag(lag: number): number {
    const repLen = this.repEnergy.length
    const prospectLen = this.prospectEnergy.length
    const xs: number[] = new Array(CORR_WINDOW)
    const ys: number[] = new Array(CORR_WINDOW)
    for (let i = 0; i < CORR_WINDOW; i++) {
      const repIdx = repLen - CORR_WINDOW - lag + i
      const prospectIdx = prospectLen - CORR_WINDOW + i
      xs[i] = this.repEnergy[repIdx]!
      ys[i] = this.prospectEnergy[prospectIdx]!
    }
    return pearson(xs, ys)
  }
}
