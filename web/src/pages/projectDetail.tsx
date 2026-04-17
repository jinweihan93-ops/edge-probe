/** @jsxImportSource hono/jsx */

import { Layout } from "../components/Layout.tsx"
import { StatusPill } from "../components/StatusPill.tsx"
import type { TraceSummary } from "../lib/backend.ts"
import { formatMs } from "../lib/metrics.ts"
import { formatRelativeTime } from "../lib/time.ts"

/**
 * `/app/projects/:projectId` — recent traces for one project.
 *
 * Same list-row shape as `/app` home. Each row links to the authed detail
 * page. Pagination is intentionally absent from the UI at this slice —
 * cursor-based "before=" is live on the backend, but the first page
 * (default limit 25) carries the demo. A "Load more" button lands the
 * cursor plumbing when anyone hits the cliff.
 */
export function ProjectDetailPage({
  projectId,
  orgId,
  traces,
}: {
  projectId: string
  orgId: string
  traces: TraceSummary[]
}) {
  return (
    <Layout
      title={`${projectId} · EdgeProbe`}
      pageClass="page--wide"
      orgId={orgId}
    >
      <header class="section">
        <div class="meta-row" style="margin-bottom: var(--space-2); font-size: 12px;">
          <div class="meta-row__item">
            <a href={`/app?org=${encodeURIComponent(orgId)}`}>← Projects</a>
          </div>
        </div>
        <h1 class="section-head" style="font-size: 32px; line-height: 38px;">
          {projectId}
        </h1>
        <div class="meta-row" style="margin-bottom: var(--space-8);">
          <div class="meta-row__item">
            <span class="meta-row__label">Org</span>
            <span class="mono">{orgId}</span>
          </div>
          <div class="meta-row__item">
            <span class="meta-row__label">Traces shown</span>
            <span class="mono">{traces.length}</span>
          </div>
        </div>
      </header>

      {traces.length === 0 ? (
        <TracesEmpty projectId={projectId} />
      ) : (
        <TracesList traces={traces} orgId={orgId} />
      )}
    </Layout>
  )
}

function TracesEmpty({ projectId }: { projectId: string }) {
  return (
    <div class="empty">
      <h2 class="empty__title">No traces in this project</h2>
      <p class="empty__body">
        Traces will appear here when the SDK emits a <code>beginTrace</code>
        with <code>projectId: "{projectId}"</code>. See <a href="https://github.com/edgeprobe/edgeprobe#quickstart">the quickstart</a> for wiring.
      </p>
    </div>
  )
}

function TracesList({ traces, orgId }: { traces: TraceSummary[]; orgId: string }) {
  return (
    <table class="list-row-table" aria-label="Recent traces">
      <thead>
        <tr>
          <th scope="col">Trace</th>
          <th scope="col">Model</th>
          <th scope="col">Device</th>
          <th scope="col" class="num">Duration</th>
          <th scope="col" class="num">Spans</th>
          <th scope="col">Status</th>
          <th scope="col" class="num">Started</th>
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => (
          <tr>
            <td>
              <a
                class="list-row-table__link mono"
                href={`/app/trace/${encodeURIComponent(t.id)}?org=${encodeURIComponent(orgId)}`}
              >
                {t.id}
              </a>
              {t.sensitive && <span class="list-row-table__badge" title="Marked sensitive: not shareable publicly">sensitive</span>}
            </td>
            <td class="mono">{t.modelName ?? "—"}</td>
            <td>{t.deviceModel ?? "—"}</td>
            <td class="num mono">{t.durationMs != null ? formatMs(t.durationMs) : "—"}</td>
            <td class="num mono">{t.spanCount}</td>
            <td>
              <StatusPill kind={t.status === "ok" ? "ok" : "bad"}>
                {t.status === "ok" ? "OK" : "Error"}
              </StatusPill>
            </td>
            <td class="num mono">{formatRelativeTime(t.startedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
