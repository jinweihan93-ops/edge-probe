import { describe, test, expect } from "bun:test"
import {
  computeMetrics,
  computeWaterfall,
  type SpanLike,
  type TraceHeader,
} from "../src/lib/metrics.ts"
import { composeVerdict } from "../src/pages/publicTrace.tsx"

/**
 * Unit tests for the two shapes of trace that hit the public share page:
 *
 *   (1) iOS SDK shape — one model-per-span, device.model + device.name + os
 *   (2) Action CI-ingest shape — trace-level gen_ai.request.model, device.label only,
 *       two or more spans sharing a `name` disambiguated by an integer `turn` attr
 *
 * The pre-fix code only understood shape (1), which made shape (2) render as
 * "unknown model on unknown device" plus duplicate span labels. These tests
 * pin the cascade fallbacks (metrics.ts) and the dedupe-aware verdict
 * composer (publicTrace.tsx) so a future refactor can't silently regress.
 */

function iosHeader(): TraceHeader {
  return {
    startedAt: "2026-04-15T12:00:00.000Z",
    endedAt: "2026-04-15T12:00:00.600Z",
    device: { model: "iPhone 15 Pro", name: "Jin's iPhone", os: "iOS 18.2" },
    attributes: {},
  }
}

function actionHeader(): TraceHeader {
  return {
    startedAt: "2026-04-15T12:00:00.000Z",
    endedAt: "2026-04-15T12:00:01.400Z",
    // Action tags the config string as `device.label` — no real device involved.
    device: { label: "whisper-base · threads=4 · beam=5" },
    // Action puts the model at trace level (one model per benchmark run).
    attributes: { "gen_ai.request.model": "whisper-base" },
  }
}

function span(overrides: Partial<SpanLike>): SpanLike {
  return {
    id: "s?",
    parentSpanId: null,
    name: "unnamed",
    kind: "llm",
    startedAt: "2026-04-15T12:00:00.000Z",
    endedAt: "2026-04-15T12:00:00.100Z",
    durationMs: 100,
    status: "ok",
    ...overrides,
  }
}

describe("computeMetrics — model name cascade", () => {
  test("picks up model from span-level gen_ai.request.model (iOS SDK shape)", () => {
    const spans: SpanLike[] = [
      span({
        id: "s1",
        kind: "llm",
        attributes: { "gen_ai.request.model": "llama-3.2-3b" },
      }),
    ]
    const m = computeMetrics(iosHeader(), spans)
    expect(m.modelName).toBe("llama-3.2-3b")
    expect(m.deviceModel).toBe("iPhone 15 Pro")
  })

  test("falls back to trace-level attribute when no span carries the model (Action shape)", () => {
    const spans: SpanLike[] = [
      span({ id: "s1", name: "whisper", kind: "asr", attributes: { turn: 1 } }),
      span({ id: "s2", name: "decode", kind: "llm", attributes: { turn: 1 } }),
    ]
    const m = computeMetrics(actionHeader(), spans)
    expect(m.modelName).toBe("whisper-base")
  })

  test("skips empty-string model attrs and keeps cascading", () => {
    const spans: SpanLike[] = [
      span({ id: "s1", kind: "llm", attributes: { "gen_ai.request.model": "" } }),
    ]
    const h: TraceHeader = {
      ...iosHeader(),
      attributes: { "gen_ai.request.model": "fallback-model" },
    }
    const m = computeMetrics(h, spans)
    expect(m.modelName).toBe("fallback-model")
  })

  test("returns null when neither span nor trace carries a model", () => {
    const spans: SpanLike[] = [span({ id: "s1", kind: "llm" })]
    const m = computeMetrics(iosHeader(), spans)
    expect(m.modelName).toBeNull()
  })
})

describe("computeMetrics — device label cascade", () => {
  test("prefers device.model over device.name and device.label", () => {
    const h: TraceHeader = {
      ...iosHeader(),
      device: { model: "iPhone 15 Pro", name: "Jin's iPhone", label: "ignored" },
    }
    const m = computeMetrics(h, [])
    expect(m.deviceModel).toBe("iPhone 15 Pro")
  })

  test("falls back to device.name when no device.model", () => {
    const h: TraceHeader = {
      ...iosHeader(),
      device: { name: "Jin's iPhone", os: "iOS 18.2" },
    }
    const m = computeMetrics(h, [])
    expect(m.deviceModel).toBe("Jin's iPhone")
  })

  test("falls back to device.label when neither model nor name present (Action shape)", () => {
    const m = computeMetrics(actionHeader(), [])
    expect(m.deviceModel).toBe("whisper-base · threads=4 · beam=5")
  })

  test("returns null when device object is empty", () => {
    const h: TraceHeader = { ...iosHeader(), device: {} }
    const m = computeMetrics(h, [])
    expect(m.deviceModel).toBeNull()
  })
})

describe("computeWaterfall — multi-turn name disambiguation", () => {
  test("appends '· turn N' when two spans share a name and carry a numeric turn", () => {
    const spans: SpanLike[] = [
      span({
        id: "s1",
        name: "whisper",
        kind: "asr",
        startedAt: "2026-04-15T12:00:00.000Z",
        endedAt: "2026-04-15T12:00:00.300Z",
        durationMs: 300,
        attributes: { turn: 1 },
      }),
      span({
        id: "s2",
        name: "whisper",
        kind: "asr",
        startedAt: "2026-04-15T12:00:00.400Z",
        endedAt: "2026-04-15T12:00:00.700Z",
        durationMs: 300,
        attributes: { turn: 2 },
      }),
      span({
        id: "s3",
        name: "decode",
        kind: "llm",
        startedAt: "2026-04-15T12:00:00.700Z",
        endedAt: "2026-04-15T12:00:01.000Z",
        durationMs: 300,
        attributes: { turn: 1 },
      }),
      span({
        id: "s4",
        name: "decode",
        kind: "llm",
        startedAt: "2026-04-15T12:00:01.000Z",
        endedAt: "2026-04-15T12:00:01.300Z",
        durationMs: 300,
        attributes: { turn: 2 },
      }),
    ]
    const { rows } = computeWaterfall(actionHeader(), spans)
    const names = rows.map((r) => r.name)
    expect(names).toEqual([
      "whisper · turn 1",
      "whisper · turn 2",
      "decode · turn 1",
      "decode · turn 2",
    ])
  })

  test("single-span-per-name traces are untouched (iOS SDK 99% case)", () => {
    const spans: SpanLike[] = [
      span({ id: "s1", name: "asr", kind: "asr", attributes: { turn: 1 } }),
      span({ id: "s2", name: "llm", kind: "llm", attributes: { turn: 1 } }),
      span({ id: "s3", name: "tts", kind: "tts", attributes: { turn: 1 } }),
    ]
    const { rows } = computeWaterfall(iosHeader(), spans)
    expect(rows.map((r) => r.name)).toEqual(["asr", "llm", "tts"])
  })

  test("duplicate names without a turn attribute are left alone (we don't invent numbers)", () => {
    const spans: SpanLike[] = [
      span({ id: "s1", name: "whisper", kind: "asr" }),
      span({ id: "s2", name: "whisper", kind: "asr" }),
    ]
    const { rows } = computeWaterfall(iosHeader(), spans)
    // Both still read "whisper" — we don't fabricate a turn number.
    // The reader sees two rows with identical names, which is still better
    // than claiming turn=1 for both.
    expect(rows.map((r) => r.name)).toEqual(["whisper", "whisper"])
  })

  test("non-numeric turn values don't trigger the suffix", () => {
    const spans: SpanLike[] = [
      span({ id: "s1", name: "whisper", attributes: { turn: "one" } }),
      span({ id: "s2", name: "whisper", attributes: { turn: "two" } }),
    ]
    const { rows } = computeWaterfall(iosHeader(), spans)
    expect(rows.map((r) => r.name)).toEqual(["whisper", "whisper"])
  })
})

describe("computeWaterfall — chronological row order", () => {
  test("rows come out sorted by startedAt regardless of input order", () => {
    // Scrambled ingest order: whisper turn 2, decode turn 1, whisper turn 1, decode turn 2.
    // This is the shape the backend actually returns — the iOS SDK emits on
    // span finish, so finish order ≠ start order once spans overlap.
    const spans: SpanLike[] = [
      span({
        id: "s2",
        name: "whisper",
        kind: "asr",
        startedAt: "2026-04-15T12:00:00.400Z",
        endedAt: "2026-04-15T12:00:00.700Z",
        durationMs: 300,
        attributes: { turn: 2 },
      }),
      span({
        id: "s3",
        name: "decode",
        kind: "llm",
        startedAt: "2026-04-15T12:00:00.300Z",
        endedAt: "2026-04-15T12:00:00.600Z",
        durationMs: 300,
        attributes: { turn: 1 },
      }),
      span({
        id: "s1",
        name: "whisper",
        kind: "asr",
        startedAt: "2026-04-15T12:00:00.000Z",
        endedAt: "2026-04-15T12:00:00.300Z",
        durationMs: 300,
        attributes: { turn: 1 },
      }),
      span({
        id: "s4",
        name: "decode",
        kind: "llm",
        startedAt: "2026-04-15T12:00:00.700Z",
        endedAt: "2026-04-15T12:00:01.000Z",
        durationMs: 300,
        attributes: { turn: 2 },
      }),
    ]
    const { rows } = computeWaterfall(actionHeader(), spans)
    expect(rows.map((r) => r.name)).toEqual([
      "whisper · turn 1",
      "decode · turn 1",
      "whisper · turn 2",
      "decode · turn 2",
    ])
  })

  test("same-startedAt spans break ties on id ascending (deterministic output)", () => {
    const spans: SpanLike[] = [
      span({
        id: "zeta",
        name: "b",
        startedAt: "2026-04-15T12:00:00.100Z",
        endedAt: "2026-04-15T12:00:00.200Z",
        durationMs: 100,
      }),
      span({
        id: "alpha",
        name: "a",
        startedAt: "2026-04-15T12:00:00.100Z",
        endedAt: "2026-04-15T12:00:00.200Z",
        durationMs: 100,
      }),
      span({
        id: "mu",
        name: "c",
        startedAt: "2026-04-15T12:00:00.100Z",
        endedAt: "2026-04-15T12:00:00.200Z",
        durationMs: 100,
      }),
    ]
    const { rows } = computeWaterfall(iosHeader(), spans)
    expect(rows.map((r) => r.id)).toEqual(["alpha", "mu", "zeta"])
  })
})

describe("composeVerdict — dedupe-aware H1 composition", () => {
  test("both distinct → 'model on device'", () => {
    expect(composeVerdict("llama-3.2-3b", "iPhone 15 Pro")).toBe(
      "llama-3.2-3b on iPhone 15 Pro",
    )
  })

  test("both equal → single label (Action's same-string-twice case)", () => {
    // When trace-level model == device.label (CI benchmark tags both as the same
    // config string), we render one copy instead of "whisper-base on whisper-base".
    expect(composeVerdict("whisper-base", "whisper-base")).toBe("whisper-base")
  })

  test("only model → model alone", () => {
    expect(composeVerdict("llama-3.2-3b", null)).toBe("llama-3.2-3b")
  })

  test("only device → device alone", () => {
    expect(composeVerdict(null, "iPhone 15 Pro")).toBe("iPhone 15 Pro")
  })

  test("neither → 'Untitled trace' (never 'unknown model on unknown device')", () => {
    expect(composeVerdict(null, null)).toBe("Untitled trace")
    // Hard guard: the old fallback string must never come back.
    expect(composeVerdict(null, null)).not.toContain("unknown")
  })

  test("empty strings count as absent (don't render 'empty on empty')", () => {
    expect(composeVerdict("", "")).toBe("Untitled trace")
    expect(composeVerdict("  ", "iPhone")).toBe("iPhone")
  })
})
