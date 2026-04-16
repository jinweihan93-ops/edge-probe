import type { Sql } from "./db.ts"
import type { SpanStore, Trace, StoredSpan } from "./views.ts"

/**
 * `postgres` types sql.json() as strictly JSON-shaped. Our attribute/device
 * bags are Record<string, unknown> because they arrive JSON-parsed from
 * the SDK, so every value is JSON-compatible by construction. This helper
 * makes the cast explicit instead of sprinkling `as any` at call sites.
 */
type JsonBag = Parameters<Sql["json"]>[0]
function asJson(v: Record<string, unknown>): JsonBag {
  return v as unknown as JsonBag
}

/**
 * Postgres-backed SpanStore. Same interface as InMemorySpanStore, just
 * persisted and multi-process-safe.
 *
 * Why this exists:
 * - /ingest survives process restarts instead of losing everything in memory.
 * - Multiple backend replicas can read the same traces (stateless app tier).
 * - Ops can query traces directly for debugging without scraping logs.
 *
 * The FKs on `traces.org_id` require the org row to exist. Rather than force
 * callers to maintain orgs out-of-band (we don't have an org-creation API
 * yet), `insertTrace` auto-upserts the org. Same for api_keys — also TODO.
 * When org management lands we tighten this. For Day 1 the SDK can POST
 * /ingest for a new org and it just works.
 *
 * Date handling: Postgres returns TIMESTAMPTZ columns as `Date` objects; the
 * app contract is ISO-8601 strings. `toIso()` does the round-trip. The SDK
 * emits fractional-second ISO strings; Postgres stores them faithfully.
 */
export class PgSpanStore implements SpanStore {
  constructor(private readonly sql: Sql) {}

  async insertTrace(t: Trace): Promise<void> {
    await this.sql.begin(async (tx) => {
      // Auto-ensure the org row exists. See class doc.
      await tx`
        INSERT INTO orgs (id, name) VALUES (${t.orgId}, ${t.orgId})
        ON CONFLICT (id) DO NOTHING
      `
      await tx`
        INSERT INTO traces (
          id, org_id, project_id, session_id, started_at, ended_at,
          device, attributes, sensitive
        ) VALUES (
          ${t.id}, ${t.orgId}, ${t.projectId}, ${t.sessionId},
          ${t.startedAt}, ${t.endedAt},
          ${this.sql.json(asJson(t.device))}, ${this.sql.json(asJson(t.attributes))}, ${t.sensitive}
        )
        ON CONFLICT (id) DO NOTHING
      `
    })
  }

  async insertSpan(s: StoredSpan): Promise<void> {
    await this.sql`
      INSERT INTO spans (
        id, trace_id, parent_span_id, name, kind, started_at, ended_at,
        duration_ms, status, attributes, include_content, prompt_text,
        completion_text, transcript_text
      ) VALUES (
        ${s.id}, ${s.traceId}, ${s.parentSpanId}, ${s.name}, ${s.kind},
        ${s.startedAt}, ${s.endedAt}, ${s.durationMs}, ${s.status},
        ${this.sql.json(asJson(s.attributes))}, ${s.includeContent}, ${s.promptText},
        ${s.completionText}, ${s.transcriptText}
      )
      ON CONFLICT (id) DO NOTHING
    `
  }

  async getTrace(id: string): Promise<Trace | undefined> {
    const rows = await this.sql<Array<TraceRow>>`
      SELECT id, org_id, project_id, session_id, started_at, ended_at,
             device, attributes, sensitive
      FROM traces
      WHERE id = ${id}
    `
    if (rows.length === 0) return undefined
    const r = rows[0]
    return {
      id: r.id,
      orgId: r.org_id,
      projectId: r.project_id,
      sessionId: r.session_id,
      startedAt: toIso(r.started_at),
      endedAt: r.ended_at ? toIso(r.ended_at) : null,
      device: r.device,
      attributes: r.attributes,
      sensitive: r.sensitive,
    }
  }

  async getSpansForTrace(traceId: string): Promise<StoredSpan[]> {
    const rows = await this.sql<Array<SpanRow>>`
      SELECT id, trace_id, parent_span_id, name, kind, started_at, ended_at,
             duration_ms, status, attributes, include_content, prompt_text,
             completion_text, transcript_text
      FROM spans
      WHERE trace_id = ${traceId}
      ORDER BY started_at
    `
    return rows.map((r) => ({
      id: r.id,
      traceId: r.trace_id,
      parentSpanId: r.parent_span_id,
      name: r.name,
      kind: r.kind,
      startedAt: toIso(r.started_at),
      endedAt: toIso(r.ended_at),
      durationMs: r.duration_ms,
      status: r.status as "ok" | "error",
      attributes: r.attributes as Record<string, unknown>,
      includeContent: r.include_content,
      promptText: r.prompt_text,
      completionText: r.completion_text,
      transcriptText: r.transcript_text,
    }))
  }
}

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : v
}

interface TraceRow {
  id: string
  org_id: string
  project_id: string
  session_id: string | null
  started_at: Date
  ended_at: Date | null
  device: Record<string, unknown>
  attributes: Record<string, unknown>
  sensitive: boolean
}

interface SpanRow {
  id: string
  trace_id: string
  parent_span_id: string | null
  name: string
  kind: string
  started_at: Date
  ended_at: Date
  duration_ms: number
  status: string
  attributes: Record<string, unknown>
  include_content: boolean
  prompt_text: string | null
  completion_text: string | null
  transcript_text: string | null
}
