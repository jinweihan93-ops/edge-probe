import { describe, test, expect } from "bun:test"
import { join } from "node:path"
import { renderComment, fmtMs, fmtDelta } from "../src/comment.ts"
import { compareAgainstBaseline } from "../src/compare.ts"
import { parseSummary } from "../src/entry.ts"
import type { CommentInput, TraceSummary } from "../src/types.ts"

/**
 * comment.test.ts — byte-level lock on the PR comment template.
 *
 * The golden files in `fixtures/comment.*.golden.md` are part of the
 * product contract. Every consumer of this Action diffs these bytes
 * against their own workflow output. Change the template deliberately,
 * update the golden. Never accidentally.
 *
 * If a golden test fails with `expected ... received ...`, look at the
 * diff carefully — glyphs (✓, →, −) are single-codepoint Unicode and the
 * template deliberately uses the MINUS SIGN (U+2212), not HYPHEN-MINUS,
 * for negative deltas.
 */

const FIXTURES = join(import.meta.dir, "..", "fixtures")

async function readFixture(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text()
}

describe("renderComment — three golden variants", () => {
  test("regression — reads trace + baseline fixtures and matches golden", async () => {
    const current = parseSummary(await readFixture("trace.sample.json"), "trace.sample.json")
    const baseline = parseSummary(await readFixture("baseline.sample.json"), "baseline.sample.json")
    const verdict = compareAgainstBaseline(current, baseline, 0.15)
    expect(verdict.regression).toBe(true)

    const input: CommentInput = {
      current,
      baseline,
      verdict,
      threshold: 0.15,
      shareUrl: "https://edgeprobe.dev/r/A7F3",
      version: "0.0.1",
      configureUrl: "https://edgeprobe.dev/app/projects/voiceprobe-demo",
    }

    const actual = renderComment(input)
    const expected = await readFixture("comment.regression.golden.md")
    expect(actual).toBe(expected)
  })

  test("pass — +1% under 15% threshold", async () => {
    const current: TraceSummary = {
      project: "voiceprobe-demo",
      label: "iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M",
      headlineMetric: "TTFT",
      headlineMs: 970,
      totalMs: 970,
      turns: [{ turn: 1, stages: { whisper: 240, prefill: 320, decode: 410 }, totalMs: 970 }],
    }
    const baseline: TraceSummary = {
      project: "voiceprobe-demo",
      label: current.label,
      headlineMetric: "TTFT",
      headlineMs: 960,
      totalMs: 960,
      turns: [{ turn: 1, stages: { whisper: 240, prefill: 320, decode: 400 }, totalMs: 960 }],
    }
    const verdict = compareAgainstBaseline(current, baseline, 0.15)
    expect(verdict.regression).toBe(false)

    const actual = renderComment({
      current,
      baseline,
      verdict,
      threshold: 0.15,
      shareUrl: "https://edgeprobe.dev/r/B8G4",
      version: "0.0.1",
      configureUrl: "https://edgeprobe.dev/app/projects/voiceprobe-demo",
    })
    const expected = await readFixture("comment.pass.golden.md")
    expect(actual).toBe(expected)
  })

  test("first-run — no baseline, informational shape", async () => {
    const current: TraceSummary = {
      project: "voiceprobe-demo",
      label: "iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M",
      headlineMetric: "TTFT",
      headlineMs: 960,
      totalMs: 3100,
      turns: [
        { turn: 1, stages: { whisper: 240, prefill: 320, decode: 400 }, totalMs: 960 },
        { turn: 2, stages: { whisper: 240, prefill: 360, decode: 480 }, totalMs: 1080 },
        { turn: 3, stages: { whisper: 240, prefill: 400, decode: 420 }, totalMs: 1060 },
      ],
      git: { thisRef: "main", thisSha: "1a2b3c4" },
    }
    const verdict = compareAgainstBaseline(current, null, 0.15)

    const actual = renderComment({
      current,
      baseline: null,
      verdict,
      threshold: 0.15,
      shareUrl: "https://edgeprobe.dev/r/C9H5",
      version: "0.0.1",
    })
    const expected = await readFixture("comment.firstrun.golden.md")
    expect(actual).toBe(expected)
  })
})

describe("renderComment — small-surface invariants", () => {
  test("regression variant uses MINUS SIGN (U+2212), not HYPHEN-MINUS, for negative deltas", () => {
    // Tiny self-contained case where the decode turn improves — the table's
    // delta cell must render with U+2212 so the byte stays aligned with the
    // golden markdown. Hyphen-minus (U+002D) would be a silent regression of
    // the comment template.
    const current: TraceSummary = {
      project: "p", label: "lbl", headlineMetric: "TTFT",
      headlineMs: 1200, totalMs: 1200,
      turns: [{ turn: 1, stages: { decode: 1200 }, totalMs: 1200 }],
    }
    const baseline: TraceSummary = {
      project: "p", label: "lbl", headlineMetric: "TTFT",
      headlineMs: 1000, totalMs: 1500,
      turns: [{ turn: 1, stages: { decode: 1500 }, totalMs: 1500 }],
    }
    const verdict = compareAgainstBaseline(current, baseline, 0.15)
    const body = renderComment({
      current, baseline, verdict,
      threshold: 0.15, shareUrl: null, version: "0.0.1",
    })
    // The per-turn delta is (1200-1500)/1500 = -0.20 → "−20%" with U+2212.
    expect(body).toContain("\u221220%")
    expect(body).not.toContain("-20%") // ascii hyphen-minus would be the bug
  })

  test("shareUrl null → explicit '_No share URL_' notice (CI still useful without backend)", () => {
    const current: TraceSummary = {
      project: "p", label: "lbl", headlineMetric: "TTFT",
      headlineMs: 100, totalMs: 100, turns: [],
    }
    const body = renderComment({
      current, baseline: null,
      verdict: compareAgainstBaseline(current, null, 0.15),
      threshold: 0.15, shareUrl: null, version: "0.0.1",
    })
    expect(body).toContain("_No share URL")
  })

  test("pass variant carries the ✓ glyph, not 'OK' or other ascii synonyms", () => {
    const current: TraceSummary = {
      project: "p", label: "lbl", headlineMetric: "TTFT",
      headlineMs: 100, totalMs: 100,
      turns: [{ turn: 1, stages: {}, totalMs: 100 }],
    }
    const baseline: TraceSummary = { ...current, headlineMs: 99 }
    const body = renderComment({
      current, baseline,
      verdict: compareAgainstBaseline(current, baseline, 0.15),
      threshold: 0.15, shareUrl: null, version: "0.0.1",
    })
    expect(body.startsWith("\u2713 ")).toBe(true)
  })
})

describe("fmtMs + fmtDelta primitives", () => {
  test("fmtMs sub-second with thousands separator", () => {
    expect(fmtMs(240)).toBe("240 ms")
    expect(fmtMs(999)).toBe("999 ms")
  })

  test("fmtMs ≥ 1 s shown as two-decimal seconds", () => {
    expect(fmtMs(1000)).toBe("1.00 s")
    expect(fmtMs(1280)).toBe("1.28 s")
    expect(fmtMs(12345)).toBe("12.35 s")
  })

  test("fmtMs non-finite → em-dash", () => {
    expect(fmtMs(NaN)).toBe("\u2014")
    expect(fmtMs(Infinity)).toBe("\u2014")
  })

  test("fmtDelta zero → ±0%", () => {
    expect(fmtDelta(0)).toBe("\u00B10%")
  })

  test("fmtDelta rounds to nearest percent", () => {
    expect(fmtDelta(0.3333)).toBe("+33%")
    expect(fmtDelta(0.0104)).toBe("+1%")
  })

  test("fmtDelta uses minus sign for negatives", () => {
    expect(fmtDelta(-0.02)).toBe("\u22122%")
    expect(fmtDelta(-0.5)).toBe("\u221250%")
  })
})
