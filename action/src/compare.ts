import type { PerTurnTiming, TraceSummary, Verdict } from "./types.ts"

/**
 * Produce a `Verdict` by diffing the current run against the baseline.
 *
 * `threshold` is a proportion (0.15 = 15%). A run is a regression when the
 * headline metric is worse than baseline by at least `threshold`.
 * "Worse" is direction-aware: for timings, larger is worse. We don't
 * have a metric today where smaller is worse, but if that changes this
 * is the one place to teach it.
 *
 * Absent baseline → `delta: null`, `regression: false`, and the comment
 * formatter renders the informational "first run" variant.
 */
export function compareAgainstBaseline(
  current: TraceSummary,
  baseline: TraceSummary | null,
  threshold: number,
): Verdict {
  if (!baseline) {
    return {
      regression: false,
      delta: null,
      turns: current.turns.map((t) => ({
        turn: t.turn,
        currentMs: t.totalMs,
        baselineMs: null,
        delta: null,
      })),
    }
  }

  const delta = proportionalDelta(current.headlineMs, baseline.headlineMs)
  const regression = delta !== null && delta >= threshold

  const byTurn = new Map(baseline.turns.map((t) => [t.turn, t]))
  const turns = current.turns.map((t) => {
    const b = byTurn.get(t.turn)
    return {
      turn: t.turn,
      currentMs: t.totalMs,
      baselineMs: b?.totalMs ?? null,
      delta: b ? proportionalDelta(t.totalMs, b.totalMs) : null,
    }
  })

  return { regression, delta, turns }
}

/** `(current - baseline) / baseline`, or `null` if the baseline is zero. */
export function proportionalDelta(current: number, baseline: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null
  if (baseline === 0) return null
  return (current - baseline) / baseline
}

/** Re-export for clients that want only the per-turn helper. */
export function perTurnDelta(current: PerTurnTiming, baseline: PerTurnTiming | undefined): number | null {
  if (!baseline) return null
  return proportionalDelta(current.totalMs, baseline.totalMs)
}
