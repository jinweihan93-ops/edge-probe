/**
 * PII boundary, enforced at the data plane.
 *
 * The whole EdgeProbe product depends on one invariant:
 * prompt/completion text NEVER renders on /r/{token}, even when it was
 * uploaded for the authenticated dashboard.
 *
 * The enforcement is: two read paths. This module is the only place in the
 * backend that touches the raw span store. Anything downstream calls either
 * `publicSpans.forTrace(id)` (for /r/{token}) or `privateSpans.forTrace(id)`
 * (for /app/trace/{id}). The functions return structurally different types —
 * `PublicSpan` has no content fields, `PrivateSpan` has them. TypeScript
 * enforces at compile time that you cannot render a PrivateSpan on a public
 * endpoint and vice versa, because the response types differ.
 *
 * The storage layer is abstracted so we can swap from in-memory (fast tests)
 * to Postgres (production) without changing endpoint code. The views stay
 * the same. See src/pgSpanStore.ts and src/migrations/001_init.sql for the
 * Postgres side of this same boundary.
 */

// ----- Types at the boundary -----

export type SpanKind = "llm" | "asr" | "tts" | string

/** Fields visible on public share URLs (/r/{token}). No content text. Ever. */
export interface PublicSpan {
  id: string
  traceId: string
  parentSpanId: string | null
  name: string
  kind: SpanKind
  startedAt: string // ISO8601
  endedAt: string
  durationMs: number
  status: "ok" | "error"
  attributes: Record<string, unknown> // content.* keys stripped
}

/** Fields visible on authenticated dashboard (/app/trace/{id}). Includes content. */
export interface PrivateSpan extends PublicSpan {
  includeContent: boolean
  promptText: string | null
  completionText: string | null
  transcriptText: string | null
}

/** Internal storage shape. Never returned to endpoints directly. */
export interface StoredSpan extends PrivateSpan {}

export interface Trace {
  id: string
  orgId: string
  projectId: string
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  device: Record<string, unknown>
  attributes: Record<string, unknown>
  sensitive: boolean
}

// ----- Content-stripping (defense in depth) -----

const CONTENT_ATTR_DENYLIST = new Set([
  "content.prompt",
  "content.completion",
  "content.transcript",
  "gen_ai.prompt",
  "gen_ai.completion",
  "user.input",
  "user.output",
])

function stripContentAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) {
    if (CONTENT_ATTR_DENYLIST.has(k)) continue
    if (k.startsWith("content.")) continue
    out[k] = v
  }
  return out
}

/** Projects a stored span down to the public shape. Throws if content would leak. */
function toPublicSpan(stored: StoredSpan): PublicSpan {
  return {
    id: stored.id,
    traceId: stored.traceId,
    parentSpanId: stored.parentSpanId,
    name: stored.name,
    kind: stored.kind,
    startedAt: stored.startedAt,
    endedAt: stored.endedAt,
    durationMs: stored.durationMs,
    status: stored.status,
    attributes: stripContentAttributes(stored.attributes),
  }
}

// ----- Dashboard aggregate types (project + trace lists) -----

/**
 * Row shape for the `/app` home dashboard. Numbers over adjectives — if a
 * field can be counted, we count it. No free-text summaries at this tier.
 */
export interface ProjectSummary {
  projectId: string
  /** Last trace's `started_at` for this project. ISO8601. */
  lastTraceAt: string | null
  /** Total traces stored for this project under the requesting org. */
  traceCount: number
}

/**
 * Row shape for the `/app/projects/:id/traces` list. Keeps the payload
 * small — the detail page is one click away, so we only surface what the
 * row needs: identity, timing, and an at-a-glance device/model label.
 *
 * `modelName` is a best-effort lift from the first LLM span's
 * `gen_ai.request.model`. Could be null for traces that didn't run an LLM
 * span (e.g. ASR-only).
 */
export interface TraceSummary {
  id: string
  projectId: string
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  /** ms between startedAt and endedAt when both set, else null. */
  durationMs: number | null
  status: "ok" | "error"
  sensitive: boolean
  /** `device.model` if the SDK supplied one; null otherwise. */
  deviceModel: string | null
  /** First llm span's `gen_ai.request.model`; null if no llm span. */
  modelName: string | null
  spanCount: number
}

export interface ListTracesOpts {
  /** Default 25, capped at 100. */
  limit?: number
  /** Cursor: only return traces strictly earlier than this ISO8601. */
  before?: string
}

// ----- Storage interface + in-memory implementation -----
//
// `SpanStore` is async because the real implementation (PgSpanStore) needs
// to await I/O. The in-memory version just returns resolved promises — the
// overhead is a microtask per call, negligible.

export interface SpanStore {
  insertTrace(t: Trace): Promise<void>
  insertSpan(s: StoredSpan): Promise<void>
  getTrace(id: string): Promise<Trace | undefined>
  getSpansForTrace(traceId: string): Promise<StoredSpan[]>
  /**
   * Project roll-up for the `/app` home dashboard. Returned newest-first by
   * lastTraceAt. Orgs with zero traces return `[]`.
   */
  listProjects(orgId: string): Promise<ProjectSummary[]>
  /**
   * Trace list for one project. Newest-first by startedAt. Pagination is
   * cursor-based on `startedAt` so new writes don't disturb existing
   * pages. No `offset` because that's a footgun at scale.
   */
  listTraces(orgId: string, projectId: string, opts?: ListTracesOpts): Promise<TraceSummary[]>
}

export class InMemorySpanStore implements SpanStore {
  private traces = new Map<string, Trace>()
  private spansByTrace = new Map<string, StoredSpan[]>()

  async insertTrace(t: Trace): Promise<void> {
    this.traces.set(t.id, t)
  }

  async insertSpan(s: StoredSpan): Promise<void> {
    const list = this.spansByTrace.get(s.traceId) ?? []
    list.push(s)
    this.spansByTrace.set(s.traceId, list)
  }

  async getTrace(id: string): Promise<Trace | undefined> {
    return this.traces.get(id)
  }

  async getSpansForTrace(traceId: string): Promise<StoredSpan[]> {
    return this.spansByTrace.get(traceId) ?? []
  }

  async listProjects(orgId: string): Promise<ProjectSummary[]> {
    const byProject = new Map<string, { lastTraceAt: string | null; count: number }>()
    for (const t of this.traces.values()) {
      if (t.orgId !== orgId) continue
      const existing = byProject.get(t.projectId) ?? { lastTraceAt: null, count: 0 }
      existing.count += 1
      if (!existing.lastTraceAt || t.startedAt > existing.lastTraceAt) {
        existing.lastTraceAt = t.startedAt
      }
      byProject.set(t.projectId, existing)
    }
    const rows: ProjectSummary[] = [...byProject.entries()].map(([projectId, v]) => ({
      projectId,
      lastTraceAt: v.lastTraceAt,
      traceCount: v.count,
    }))
    // Newest-first. Null lastTraceAt (shouldn't happen — every row we saw
    // contributed a started_at) sorts last.
    rows.sort((a, b) => {
      if (!a.lastTraceAt) return 1
      if (!b.lastTraceAt) return -1
      return b.lastTraceAt.localeCompare(a.lastTraceAt)
    })
    return rows
  }

  async listTraces(
    orgId: string,
    projectId: string,
    opts?: ListTracesOpts,
  ): Promise<TraceSummary[]> {
    const limit = clampLimit(opts?.limit)
    const before = opts?.before
    const candidates: Trace[] = []
    for (const t of this.traces.values()) {
      if (t.orgId !== orgId) continue
      if (t.projectId !== projectId) continue
      if (before && !(t.startedAt < before)) continue
      candidates.push(t)
    }
    candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    const page = candidates.slice(0, limit)
    return page.map((t) => this.summarizeTrace(t))
  }

  private summarizeTrace(t: Trace): TraceSummary {
    const spans = this.spansByTrace.get(t.id) ?? []
    let status: "ok" | "error" = "ok"
    let modelName: string | null = null
    for (const s of spans) {
      if (s.status === "error") status = "error"
      if (!modelName && s.kind === "llm") {
        const m = s.attributes["gen_ai.request.model"]
        if (typeof m === "string") modelName = m
      }
    }
    const durationMs = t.endedAt
      ? Math.max(0, Date.parse(t.endedAt) - Date.parse(t.startedAt))
      : null
    const deviceModel = typeof t.device["model"] === "string"
      ? (t.device["model"] as string)
      : null
    return {
      id: t.id,
      projectId: t.projectId,
      sessionId: t.sessionId,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs,
      status,
      sensitive: t.sensitive,
      deviceModel,
      modelName,
      spanCount: spans.length,
    }
  }

  reset(): void {
    this.traces.clear()
    this.spansByTrace.clear()
  }
}

function clampLimit(v: number | undefined): number {
  if (!v || v <= 0) return 25
  return Math.min(Math.floor(v), 100)
}

// ----- Views — the only way endpoints read spans -----

export class SpanViews {
  constructor(private readonly store: SpanStore) {}

  /**
   * Public view — used ONLY by /r/{token}. Returns spans with content fields
   * absent from the type and the value. Sensitive traces return empty.
   */
  async public_forTrace(traceId: string): Promise<PublicSpan[]> {
    const trace = await this.store.getTrace(traceId)
    if (!trace || trace.sensitive) return []
    const spans = await this.store.getSpansForTrace(traceId)
    return spans.map(toPublicSpan)
  }

  /**
   * Private view — used ONLY by /app/trace/{id} (auth'd). Returns full spans,
   * including content when `includeContent: true` was set per-call on the SDK.
   * The caller is responsible for verifying the requester belongs to `trace.orgId`.
   */
  async private_forTrace(traceId: string, requestingOrgId: string): Promise<PrivateSpan[]> {
    const trace = await this.store.getTrace(traceId)
    if (!trace) return []
    if (trace.orgId !== requestingOrgId) {
      // Cross-org isolation: Critical Path #2 (403, not 404 — don't leak existence).
      // The endpoint layer translates this empty list plus the auth check
      // into the 403 response. Never 404.
      return []
    }
    return this.store.getSpansForTrace(traceId)
  }
}
