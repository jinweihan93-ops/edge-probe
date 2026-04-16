/**
 * Derived metrics for the hero strip and waterfall axis.
 *
 * All inputs come from PublicSpan[] or PrivateSpan[] — the public shape has
 * no content, which means any leak of prompt text into the UI is a type error
 * here, not a runtime one. That's the whole point of the two-type PII boundary.
 *
 * We compute whatever we can from timings + names + kinds + attributes. No
 * baselines yet — baselines ship when we land a project-level "pin this as
 * baseline" action. Until then, every `delta` on a hero tile is absent (per
 * DESIGN.md: "never show a delta without a baseline").
 */

export interface SpanLike {
  id: string
  parentSpanId: string | null
  name: string
  kind: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: "ok" | "error"
}

export interface TraceHeader {
  startedAt: string
  endedAt: string | null
  device: Record<string, unknown>
  attributes: Record<string, unknown>
}

export interface Metrics {
  totalMs: number
  llmMs: number
  asrMs: number
  spanCount: number
  deviceModel: string | null
  modelName: string | null
  status: "ok" | "error"
}

export function computeMetrics(header: TraceHeader, spans: SpanLike[]): Metrics {
  const startMs = Date.parse(header.startedAt)
  const endMs = header.endedAt ? Date.parse(header.endedAt) : maxEndMs(spans, startMs)
  const totalMs = Math.max(0, endMs - startMs)

  let llmMs = 0
  let asrMs = 0
  let errorSeen = false
  let modelName: string | null = null

  for (const s of spans) {
    if (s.kind === "llm") llmMs += s.durationMs
    if (s.kind === "asr") asrMs += s.durationMs
    if (s.status === "error") errorSeen = true
  }

  // gen_ai.request.model is the OTel-ish attribute key the SDK emits.
  // Take the first one we see on an llm span.
  for (const s of spans) {
    if (s.kind !== "llm") continue
    const attrs = (s as unknown as { attributes?: Record<string, unknown> }).attributes
    const m = attrs?.["gen_ai.request.model"]
    if (typeof m === "string") {
      modelName = m
      break
    }
  }

  const deviceModel = typeof header.device["model"] === "string" ? (header.device["model"] as string) : null

  return {
    totalMs,
    llmMs,
    asrMs,
    spanCount: spans.length,
    deviceModel,
    modelName,
    status: errorSeen ? "error" : "ok",
  }
}

function maxEndMs(spans: SpanLike[], fallback: number): number {
  let max = fallback
  for (const s of spans) {
    const e = Date.parse(s.endedAt)
    if (e > max) max = e
  }
  return max
}

/**
 * Waterfall geometry: percent-offset + percent-width for each span, given a
 * common origin (the earliest startedAt of any span, or the trace startedAt
 * if earlier) and a duration envelope (largest endedAt - origin).
 */
export interface WaterfallRow {
  id: string
  name: string
  kind: string
  durationMs: number
  status: "ok" | "error"
  depth: number
  offsetPct: number
  widthPct: number
}

export function computeWaterfall(header: TraceHeader, spans: SpanLike[]): {
  rows: WaterfallRow[]
  totalMs: number
  ticks: number[]
} {
  if (spans.length === 0) {
    return { rows: [], totalMs: 0, ticks: [0] }
  }

  const originMs = Math.min(Date.parse(header.startedAt), ...spans.map((s) => Date.parse(s.startedAt)))
  const totalEnd = Math.max(...spans.map((s) => Date.parse(s.endedAt)))
  const totalMs = Math.max(1, totalEnd - originMs) // avoid div-by-zero

  const depths = depthByParent(spans)

  const rows = spans.map<WaterfallRow>((s) => {
    const startOffset = Date.parse(s.startedAt) - originMs
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      durationMs: s.durationMs,
      status: s.status,
      depth: depths.get(s.id) ?? 0,
      offsetPct: (startOffset / totalMs) * 100,
      widthPct: Math.max(0.5, (s.durationMs / totalMs) * 100),
    }
  })

  return { rows, totalMs, ticks: chooseTicks(totalMs) }
}

function depthByParent(spans: SpanLike[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.id, s]))
  const cache = new Map<string, number>()
  function walk(id: string): number {
    if (cache.has(id)) return cache.get(id)!
    const s = byId.get(id)
    if (!s || !s.parentSpanId) {
      cache.set(id, 0)
      return 0
    }
    const d = walk(s.parentSpanId) + 1
    cache.set(id, d)
    return d
  }
  for (const s of spans) walk(s.id)
  return cache
}

function chooseTicks(totalMs: number): number[] {
  // Pick a tick interval that gives ~4-6 ticks. Round numbers only.
  const candidates = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000]
  const step = candidates.find((c) => totalMs / c <= 6) ?? 10000
  const ticks: number[] = []
  for (let t = 0; t <= totalMs; t += step) ticks.push(t)
  if (ticks[ticks.length - 1] !== totalMs) ticks.push(totalMs)
  return ticks
}

export function formatMs(ms: number): string {
  if (ms < 1) return "<1 ms"
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
