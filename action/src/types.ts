/**
 * Wire types shared across the Action pieces.
 *
 * A `TraceSummary` is the minimum input the Action needs to format a
 * comment, compare to a baseline, and (optionally) forward to the
 * EdgeProbe backend for a share URL. It is intentionally NOT the full
 * OTel payload — the SDK already reduces a trace to its hero-metric
 * shape before handing it to CI; carrying the raw span tree through
 * this stage would just bloat the golden fixture.
 *
 * Consumers (the user's CI script) emit one JSON blob of this shape per
 * turn-group, then feed it to `action/src/entry.ts`.
 */

export interface PerTurnTiming {
  /** 1-indexed turn number within the trace. */
  turn: number
  /** Stage → milliseconds. Keys not set are rendered as `—`. */
  stages: {
    whisper?: number | undefined
    prefill?: number | undefined
    decode?: number | undefined
    tts?: number | undefined
  }
  /** Convenience: total ms across all stages. Callers MUST supply. */
  totalMs: number
}

export interface TraceSummary {
  /** User-visible project name (matches what shows on the dashboard). */
  project: string
  /** Device + runtime label, e.g. "iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M". */
  label: string
  /** Headline metric key, e.g. "TTFT". */
  headlineMetric: string
  /** Headline metric value in ms on this run. */
  headlineMs: number
  /** Total measured run time in ms (sum over turns). */
  totalMs: number
  /**
   * Per-turn rows. May be empty for single-span traces (the Action still
   * renders a usable comment with just the headline).
   */
  turns: PerTurnTiming[]
  /** Git metadata for the "Baseline / This PR" line. Optional, filled by Action wiring. */
  git?: {
    baselineRef?: string
    baselineSha?: string
    thisRef?: string
    thisSha?: string
  } | undefined
}

/**
 * Decision made by comparing the current run against a baseline.
 * `delta` is a proportion (0.34 = +34%, -0.02 = -2%).
 */
export interface Verdict {
  /** `true` when the delta exceeds the threshold. */
  regression: boolean
  /** Proportion change on the headline metric. `null` if no baseline. */
  delta: number | null
  /** Turn-level breakdown when a baseline is present. */
  turns: Array<{
    turn: number
    currentMs: number
    baselineMs: number | null
    delta: number | null
  }>
}

export interface CommentInput {
  current: TraceSummary
  baseline: TraceSummary | null
  verdict: Verdict
  /** Threshold used for the verdict, as proportion (0.15 = 15%). */
  threshold: number
  /** Public share URL for the current trace (e.g. `https://edgeprobe.dev/r/A7F3`). */
  shareUrl: string | null
  /** SDK/Action version string for the footer. */
  version: string
  /** Optional "configure" link for the footer. */
  configureUrl?: string | undefined
}
