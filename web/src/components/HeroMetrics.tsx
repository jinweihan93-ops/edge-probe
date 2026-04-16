/** @jsxImportSource hono/jsx */

import type { Metrics } from "../lib/metrics.ts"
import { formatMs } from "../lib/metrics.ts"

/**
 * The 4-up hero metric strip from DESIGN.md.
 *
 * No deltas rendered — we haven't landed baselines yet, and the spec is
 * explicit: "never show a delta without a baseline". The shape is ready for
 * baselines to drop in later.
 */
export function HeroMetrics({ metrics }: { metrics: Metrics }) {
  return (
    <div class="hero-metrics" aria-label="Trace summary metrics">
      <Tile label="Total" value={formatMs(metrics.totalMs)} />
      <Tile label="LLM" value={formatMs(metrics.llmMs)} />
      <Tile label="ASR" value={formatMs(metrics.asrMs)} />
      <Tile label="Spans" value={String(metrics.spanCount)} />
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div class="metric-tile">
      <div class="metric-tile__label">{label}</div>
      <div class="metric-tile__number">{value}</div>
    </div>
  )
}
