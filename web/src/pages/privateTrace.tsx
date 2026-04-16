/** @jsxImportSource hono/jsx */

import { Layout } from "../components/Layout.tsx"
import { HeroMetrics } from "../components/HeroMetrics.tsx"
import { Waterfall } from "../components/Waterfall.tsx"
import { StatusPill } from "../components/StatusPill.tsx"
import { ContentBlock } from "../components/ContentBlock.tsx"
import type { PrivateTraceResponse } from "../lib/backend.ts"
import { computeMetrics, computeWaterfall, formatMs } from "../lib/metrics.ts"

/**
 * `/app/trace/:id` — authenticated dashboard detail.
 *
 * Differs from the public page by exactly two things:
 *   1. Nav bar is rendered (Layout.publicSurface = false).
 *   2. For each span where `includeContent: true`, a ContentBlock renders
 *      the prompt / completion / transcript text in an inset block.
 *
 * The ContentBlock component is deliberately NOT imported by publicTrace.tsx.
 * That import is the tripwire: anyone refactoring must consciously choose to
 * bring content into the public page, and their PR reviewer will notice.
 */
export function PrivateTracePage({ data, orgId }: { data: PrivateTraceResponse; orgId: string }) {
  const metrics = computeMetrics(data.trace, data.spans)
  const { rows, ticks, totalMs } = computeWaterfall(data.trace, data.spans)

  const deviceLabel = metrics.deviceModel ?? "unknown device"
  const modelLabel = metrics.modelName ?? "unknown model"

  return (
    <Layout
      title={`Trace ${data.trace.id} · EdgeProbe`}
      ogDescription="Authenticated trace detail"
      pageClass="page--wide"
    >
      <header class="section">
        <h1 class="verdict">
          {modelLabel} on {deviceLabel}
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
            <span class="meta-row__label">Trace</span>
            {data.trace.id}
          </div>
          <div class="meta-row__item">
            <span class="meta-row__label">Org</span>
            {orgId}
          </div>
          <div class="meta-row__item">
            <span class="meta-row__label">Project</span>
            {data.trace.projectId}
          </div>
          {data.trace.sessionId && (
            <div class="meta-row__item">
              <span class="meta-row__label">Session</span>
              {data.trace.sessionId}
            </div>
          )}
        </div>
      </header>

      <section class="section" aria-label="Summary metrics">
        <HeroMetrics metrics={metrics} />
      </section>

      <section class="section" aria-label="Span waterfall">
        <h2 class="section-head">Waterfall</h2>
        <Waterfall rows={rows} ticks={ticks} totalMs={totalMs} />
      </section>

      {data.spans
        .filter((s) => s.includeContent)
        .map((s) => (
          <section class="section" aria-label={`Captured content for span ${s.name}`}>
            <h2 class="section-head">
              <span class="mono">{s.name}</span>
            </h2>
            <ContentBlock
              promptText={s.promptText}
              completionText={s.completionText}
              transcriptText={s.transcriptText}
            />
          </section>
        ))}
    </Layout>
  )
}
