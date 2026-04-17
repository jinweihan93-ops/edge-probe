/** @jsxImportSource hono/jsx */

import { Layout } from "../components/Layout.tsx"
import type { ProjectSummary } from "../lib/backend.ts"
import { formatRelativeTime } from "../lib/time.ts"

/**
 * `/app` — the home dashboard after auth.
 *
 * Per DESIGN.md §"What we forbid": no card grid, no left sidebar. The
 * shape is a list-row table — one row per project, each row linking to
 * `/app/projects/:projectId`. Dense, scannable, count-first.
 *
 * Empty state: the copy is deliberately dry. "No projects yet" + SDK
 * guidance link — no marketing, no emoji, no encouragement graphic.
 */
export function AppHomePage({
  projects,
  orgId,
}: {
  projects: ProjectSummary[]
  orgId: string
}) {
  return (
    <Layout
      title="Projects · EdgeProbe"
      pageClass="page--wide"
      orgId={orgId}
    >
      <header class="section">
        <h1 class="section-head" style="font-size: 32px; line-height: 38px;">
          Projects
        </h1>
        <div class="meta-row" style="margin-bottom: var(--space-8);">
          <div class="meta-row__item">
            <span class="meta-row__label">Org</span>
            <span class="mono">{orgId}</span>
          </div>
          <div class="meta-row__item">
            <span class="meta-row__label">Count</span>
            <span class="mono">{projects.length}</span>
          </div>
        </div>
      </header>

      {projects.length === 0 ? (
        <ProjectsEmpty orgId={orgId} />
      ) : (
        <ProjectsList projects={projects} orgId={orgId} />
      )}
    </Layout>
  )
}

function ProjectsEmpty({ orgId }: { orgId: string }) {
  return (
    <div class="empty">
      <h2 class="empty__title">No projects yet</h2>
      <p class="empty__body">
        Call <code>EdgeProbe.beginTrace()</code> from your iOS app with
        <code> projectId: "&lt;your-project-id&gt;"</code>. The first ingest lands
        here. Org: <span class="mono">{orgId}</span>.
      </p>
    </div>
  )
}

function ProjectsList({ projects, orgId }: { projects: ProjectSummary[]; orgId: string }) {
  return (
    <table class="list-row-table" aria-label="Projects">
      <thead>
        <tr>
          <th scope="col">Project</th>
          <th scope="col" class="num">Traces</th>
          <th scope="col" class="num">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr>
            <td>
              <a
                class="list-row-table__link"
                href={`/app/projects/${encodeURIComponent(p.projectId)}?org=${encodeURIComponent(orgId)}`}
              >
                {p.projectId}
              </a>
            </td>
            <td class="num mono">{p.traceCount}</td>
            <td class="num mono">
              {p.lastTraceAt ? formatRelativeTime(p.lastTraceAt) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
