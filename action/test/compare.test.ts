import { describe, test, expect } from "bun:test"
import { compareAgainstBaseline, proportionalDelta } from "../src/compare.ts"
import type { TraceSummary } from "../src/types.ts"

/**
 * compare.test.ts — guards the regression-math kernel.
 *
 * Three things worth pinning down:
 *   1. The threshold boundary (at exactly `threshold`, we count it as
 *      regression — ≥, not >. If this changes, flakey half-steps start
 *      bouncing between "pass" and "fail").
 *   2. First-run (no baseline) never claims regression.
 *   3. Zero-baseline → null delta (don't divide by zero; let the formatter
 *      render "—" for unknown).
 */

function summary(headlineMs: number, turns: TraceSummary["turns"]): TraceSummary {
  return {
    project: "p",
    label: "lbl",
    headlineMetric: "TTFT",
    headlineMs,
    totalMs: turns.reduce((s, t) => s + t.totalMs, 0),
    turns,
  }
}

describe("proportionalDelta", () => {
  test("positive growth", () => {
    expect(proportionalDelta(1280, 960)).toBeCloseTo(0.3333, 3)
  })

  test("flat", () => {
    expect(proportionalDelta(100, 100)).toBe(0)
  })

  test("improvement is negative", () => {
    expect(proportionalDelta(800, 1000)).toBe(-0.2)
  })

  test("zero baseline → null (don't divide by zero)", () => {
    expect(proportionalDelta(500, 0)).toBeNull()
  })

  test("non-finite inputs → null", () => {
    expect(proportionalDelta(NaN, 100)).toBeNull()
    expect(proportionalDelta(100, Infinity)).toBeNull()
  })
})

describe("compareAgainstBaseline", () => {
  test("absent baseline → first-run shape, no regression, per-turn deltas are null", () => {
    const current = summary(960, [
      { turn: 1, stages: { whisper: 240, prefill: 320, decode: 400 }, totalMs: 960 },
      { turn: 2, stages: { whisper: 240, prefill: 360, decode: 480 }, totalMs: 1080 },
    ])
    const v = compareAgainstBaseline(current, null, 0.15)
    expect(v.regression).toBe(false)
    expect(v.delta).toBeNull()
    expect(v.turns).toEqual([
      { turn: 1, currentMs: 960, baselineMs: null, delta: null },
      { turn: 2, currentMs: 1080, baselineMs: null, delta: null },
    ])
  })

  test("+33% ≥ 15% threshold → regression", () => {
    const cur = summary(1280, [{ turn: 1, stages: {}, totalMs: 1280 }])
    const base = summary(960, [{ turn: 1, stages: {}, totalMs: 960 }])
    const v = compareAgainstBaseline(cur, base, 0.15)
    expect(v.regression).toBe(true)
    expect(v.delta).toBeCloseTo(0.3333, 3)
  })

  test("+1% < 15% threshold → pass", () => {
    const cur = summary(970, [{ turn: 1, stages: {}, totalMs: 970 }])
    const base = summary(960, [{ turn: 1, stages: {}, totalMs: 960 }])
    const v = compareAgainstBaseline(cur, base, 0.15)
    expect(v.regression).toBe(false)
    expect(v.delta).toBeCloseTo(0.0104, 3)
  })

  test("exactly at threshold → regression (≥, not >)", () => {
    // 1150 from 1000 → +15.0% exactly.
    const cur = summary(1150, [{ turn: 1, stages: {}, totalMs: 1150 }])
    const base = summary(1000, [{ turn: 1, stages: {}, totalMs: 1000 }])
    const v = compareAgainstBaseline(cur, base, 0.15)
    expect(v.regression).toBe(true)
  })

  test("improvement → not a regression, negative delta", () => {
    const cur = summary(800, [{ turn: 1, stages: {}, totalMs: 800 }])
    const base = summary(1000, [{ turn: 1, stages: {}, totalMs: 1000 }])
    const v = compareAgainstBaseline(cur, base, 0.15)
    expect(v.regression).toBe(false)
    expect(v.delta).toBeCloseTo(-0.2, 3)
  })

  test("turn not present in baseline → delta null for that turn", () => {
    const cur = summary(1000, [
      { turn: 1, stages: {}, totalMs: 500 },
      { turn: 2, stages: {}, totalMs: 500 },
    ])
    const base = summary(500, [{ turn: 1, stages: {}, totalMs: 500 }])
    const v = compareAgainstBaseline(cur, base, 0.15)
    expect(v.turns[0]).toEqual({ turn: 1, currentMs: 500, baselineMs: 500, delta: 0 })
    expect(v.turns[1]).toEqual({ turn: 2, currentMs: 500, baselineMs: null, delta: null })
  })

  test("zero baseline headline → null delta, no regression (can't divide by zero)", () => {
    const cur = summary(500, [{ turn: 1, stages: {}, totalMs: 500 }])
    const base = summary(0, [{ turn: 1, stages: {}, totalMs: 0 }])
    const v = compareAgainstBaseline(cur, base, 0.15)
    expect(v.delta).toBeNull()
    expect(v.regression).toBe(false)
  })
})
