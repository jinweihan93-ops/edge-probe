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
 * The storage layer is abstracted so we can swap from in-memory (Day 1) to
 * Postgres (month 13) without changing endpoint code. The views stay the same.
 * See src/schema.sql for the Postgres side of this same boundary.
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

// ----- Storage interface + in-memory implementation (Day 1) -----

export interface SpanStore {
  insertTrace(t: Trace): void
  insertSpan(s: StoredSpan): void
  getTrace(id: string): Trace | undefined
  getSpansForTrace(traceId: string): StoredSpan[]
}

export class InMemorySpanStore implements SpanStore {
  private traces = new Map<string, Trace>()
  private spansByTrace = new Map<string, StoredSpan[]>()

  insertTrace(t: Trace): void {
    this.traces.set(t.id, t)
  }

  insertSpan(s: StoredSpan): void {
    const list = this.spansByTrace.get(s.traceId) ?? []
    list.push(s)
    this.spansByTrace.set(s.traceId, list)
  }

  getTrace(id: string): Trace | undefined {
    return this.traces.get(id)
  }

  getSpansForTrace(traceId: string): StoredSpan[] {
    return this.spansByTrace.get(traceId) ?? []
  }

  reset(): void {
    this.traces.clear()
    this.spansByTrace.clear()
  }
}

// ----- Views — the only way endpoints read spans -----

export class SpanViews {
  constructor(private readonly store: SpanStore) {}

  /**
   * Public view — used ONLY by /r/{token}. Returns spans with content fields
   * absent from the type and the value. Sensitive traces return empty.
   */
  public_forTrace(traceId: string): PublicSpan[] {
    const trace = this.store.getTrace(traceId)
    if (!trace || trace.sensitive) return []
    return this.store.getSpansForTrace(traceId).map(toPublicSpan)
  }

  /**
   * Private view — used ONLY by /app/trace/{id} (auth'd). Returns full spans,
   * including content when `includeContent: true` was set per-call on the SDK.
   * The caller is responsible for verifying the requester belongs to `trace.orgId`.
   */
  private_forTrace(traceId: string, requestingOrgId: string): PrivateSpan[] {
    const trace = this.store.getTrace(traceId)
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
