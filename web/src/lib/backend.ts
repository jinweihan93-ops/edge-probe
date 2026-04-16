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

import type { PublicSpan, PrivateSpan, Trace } from "../../../backend/src/views.ts"

export type { PublicSpan, PrivateSpan, Trace }

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
}
