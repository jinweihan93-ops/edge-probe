/** @jsxImportSource hono/jsx */

import { Layout } from "../components/Layout.tsx"
import { HeroMetrics } from "../components/HeroMetrics.tsx"
import { Waterfall } from "../components/Waterfall.tsx"
import { StatusPill } from "../components/StatusPill.tsx"
import type { PublicTraceResponse } from "../lib/backend.ts"
import { computeMetrics, computeWaterfall, formatMs } from "../lib/metrics.ts"

/**
 * `/r/:token` — the public share page. Variant A from the approved mockups.
 *
 * This page CANNOT render prompt / completion / transcript text because:
 *   1. The backend's public view strips content columns and denylisted attrs.
 *   2. The `PublicTraceResponse` type has no content fields on spans.
 *   3. This component only imports from `PublicTraceResponse` — never from
 *      `PrivateTraceResponse`.
 *
 * If a future refactor tries to import `ContentBlock` here, it will still
 * fail at runtime because the content fields aren't in the payload — but
 * the type system catches it first. That's the Day 1 invariant.
 */
export function PublicTracePage({
  data,
  ogImageUrl,
}: {
  data: PublicTraceResponse
  /**
   * Absolute URL to the `/og/:token.png` render of this trace. Threaded
   * in by the `/r/:token` handler so it's same-origin with the page.
   * Optional: tests that stub the BackendClient don't always need to
   * synthesize one, and a missing value falls back to the summary card.
   */
  ogImageUrl?: string
}) {
  const metrics = computeMetrics(data.trace, data.spans)
  const { rows, ticks, totalMs } = computeWaterfall(data.trace, data.spans)

  // Verdict H1: numbers over adjectives, matches DESIGN.md voice rules.
  //
  // Three shapes depending on what the trace carries:
  //   (1) both model + device distinct     → `<model> on <device>` (iOS SDK)
  //   (2) only one of them OR they're equal → show the single non-empty string
  //       (CI benchmarks from the Action send the same label twice; an iOS
  //        trace with `device.model` but no `gen_ai.request.model` falls here
  //        too)
  //   (3) neither                           → "Untitled trace"
  const verdict = composeVerdict(metrics.modelName, metrics.deviceModel)

  return (
    <Layout
      title={`${verdict} — ${formatMs(metrics.totalMs)} · EdgeProbe`}
      ogDescription={`${formatMs(metrics.totalMs)} turn, ${metrics.spanCount} spans. Timings only, no prompt text.`}
      ogImage={ogImageUrl}
      publicSurface
    >
      <header class="section">
        <h1 class="verdict">
          {verdict}
          {" — "}
          <span class="mono">{formatMs(metrics.totalMs)}</span>
        </h1>
        <div class="meta-row">
          <div class="meta-row__item">
            <span class="meta-row__label">Status</span>
            <StatusPill kind={metrics.status === "ok" ? "ok" : "bad"}>
              {metrics.status === "ok" ? "OK" : "Error"}
            </StatusPill>
          </div>
          <div class="meta-row__item">
            <span class="meta-row__label">Started</span>
            {data.trace.startedAt}
          </div>
          <div class="meta-row__item">
            <span class="meta-row__label">Trace</span>
            {data.trace.id}
          </div>
        </div>
      </header>

      <section class="section" aria-label="Summary metrics">
        <HeroMetrics metrics={metrics} />
      </section>

      <section class="section" aria-label="Span waterfall">
        <h2 class="section-head">Waterfall</h2>
        <Waterfall rows={rows} ticks={ticks} totalMs={totalMs} />
      </section>

      <footer class="meta-row" style="margin-top: var(--space-12); margin-bottom: 0;">
        <div class="meta-row__item">
          <span class="meta-row__label">Shared by</span>
          EdgeProbe
        </div>
        <div class="meta-row__item">
          <span class="meta-row__label">Scope</span>
          public — no prompt text
        </div>
      </footer>
    </Layout>
  )
}

/**
 * Dedupe-aware composition. Kept close to the page (not in `metrics.ts`)
 * because it's a display concern, not a data transform — `metrics.ts` should
 * stay pure-data.
 */
export function composeVerdict(
  modelName: string | null,
  deviceLabel: string | null,
): string {
  const m = modelName?.trim() || null
  const d = deviceLabel?.trim() || null
  if (m && d && m !== d) return `${m} on ${d}`
  return m || d || "Untitled trace"
}
