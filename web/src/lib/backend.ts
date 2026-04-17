/**
 * Typed HTTP client for the EdgeProbe backend.
 *
 * Types are imported from the backend package so the web layer cannot drift
 * from the data plane's contract. If a field name changes in backend/src/views.ts,
 * tsc fails here. That's the whole point of a monorepo.
 *
 * Public surface rule: the `/r/:token` path calls `fetchPublic()`, which returns
 * `PublicSpan[]` — a type that DOES NOT contain promptText, completionText, or
 * transcriptText. Any attempt to render content from a public response is a
 * compile error, not a runtime leak.
 */

import type {
  PublicSpan,
  PrivateSpan,
  Trace,
  ProjectSummary,
  TraceSummary,
} from "../../../backend/src/views.ts"

export type { PublicSpan, PrivateSpan, Trace, ProjectSummary, TraceSummary }

/** Subset of Trace that both public and private responses carry safely. */
export interface PublicTraceHeader {
  id: string
  startedAt: string
  endedAt: string | null
  device: Record<string, unknown>
  attributes: Record<string, unknown>
}

export interface PublicTraceResponse {
  trace: PublicTraceHeader
  spans: PublicSpan[]
}

export interface PrivateTraceResponse {
  trace: Trace
  spans: PrivateSpan[]
}

export interface BackendClientConfig {
  baseUrl: string
  /** Per-request fetch implementation (injected for tests). */
  fetchImpl?: typeof fetch
}

export class BackendClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(cfg: BackendClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "")
    this.fetchImpl = cfg.fetchImpl ?? fetch
  }

  /**
   * Hits `/r/:token` on the backend. Returns `null` on any non-200 status.
   * Deliberately opaque — the backend already collapses every failure mode
   * (bad token, expired, missing, sensitive) to 404 for security reasons;
   * we preserve that at this layer by returning null and letting the page
   * handler render a single not-found page.
   */
  async fetchPublic(token: string): Promise<PublicTraceResponse | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/r/${encodeURIComponent(token)}`)
    if (!res.ok) return null
    return (await res.json()) as PublicTraceResponse
  }

  /**
   * Hits `/app/trace/:id` with the dashboard bearer forwarded.
   * Returns the status and parsed body so the page handler can distinguish
   * 401 / 403 / 404 and render the right thing.
   *
   * The bearer — NOT the orgId — is the identity proof. The page handler
   * resolves the user's requested org to a bearer from its own
   * `DASHBOARD_KEYS` config; a user who doesn't have a bearer for an org
   * can't impersonate it just by flipping the URL query param.
   */
  async fetchPrivate(
    id: string,
    bearer: string,
  ): Promise<{ status: number; body: PrivateTraceResponse | null }> {
    const res = await this.fetchImpl(`${this.baseUrl}/app/trace/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (!res.ok) return { status: res.status, body: null }
    return { status: res.status, body: (await res.json()) as PrivateTraceResponse }
  }

  /**
   * Dashboard: list projects for the authed org. Returns `[]` on any
   * non-200 — 401 / 404 / network blip all collapse to empty to match the
   * page handler's "show the empty state" behavior.
   */
  async listProjects(bearer: string): Promise<{ status: number; projects: ProjectSummary[] }> {
    const res = await this.fetchImpl(`${this.baseUrl}/app/projects`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (!res.ok) return { status: res.status, projects: [] }
    const body = (await res.json()) as { projects: ProjectSummary[] }
    return { status: res.status, projects: body.projects }
  }

  /**
   * Dashboard: list recent traces under one project. Same failure posture
   * as listProjects — non-200 → empty. Page handler decides whether an
   * empty list is "the project has no traces yet" or "you don't have access
   * to this org" based on the status code we return.
   */
  async listProjectTraces(
    projectId: string,
    bearer: string,
    opts?: { limit?: number; before?: string },
  ): Promise<{ status: number; traces: TraceSummary[] }> {
    const qs = new URLSearchParams()
    if (opts?.limit) qs.set("limit", String(opts.limit))
    if (opts?.before) qs.set("before", opts.before)
    const url = `${this.baseUrl}/app/projects/${encodeURIComponent(projectId)}/traces${
      qs.size > 0 ? `?${qs.toString()}` : ""
    }`
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    if (!res.ok) return { status: res.status, traces: [] }
    const body = (await res.json()) as { traces: TraceSummary[] }
    return { status: res.status, traces: body.traces }
  }

  /**
   * Fetches an OG card PNG. We proxy through the web layer so that the
   * `<meta property="og:image">` URL shares an origin with the share page —
   * some unfurl bots follow redirects and some don't, and keeping the card
   * on the same host sidesteps the difference. The web layer does not
   * inspect the bytes; it forwards status + `Cache-Control` intact.
   *
   * Returns `null` when the backend is unreachable (network failure). The
   * backend already guarantees a branded fallback PNG with status 404 for
   * every "don't tell me why" failure, so a non-null response is always
   * something safe to pipe through.
   */
  async fetchOgPng(
    filename: string,
  ): Promise<{ status: number; body: Uint8Array; cacheControl: string } | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/og/${encodeURIComponent(filename)}`)
      const body = new Uint8Array(await res.arrayBuffer())
      return {
        status: res.status,
        body,
        cacheControl: res.headers.get("Cache-Control") ?? "public, max-age=300",
      }
    } catch {
      return null
    }
  }
}
