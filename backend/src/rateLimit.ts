/**
 * Per-org token-bucket rate limiter for the /ingest endpoint.
 *
 * Design choices:
 * - Two orthogonal buckets per org: spans/second and bytes/day. The first
 *   absorbs short bursts (a bad SDK retry loop); the second caps total volume
 *   so one pathological client can't fill a day of storage before anyone
 *   notices.
 * - In-process, Map-backed. Deliberately not Redis for Day 1 — that's a Slice
 *   11+ concern. Single backend instance today is fine; when horizontally
 *   scaled replicas land, this becomes per-replica (N× the nominal limit,
 *   acceptable slack) and we'd swap the Map for a shared store.
 * - Injectable clock so tests can advance time by hand without `sleep`.
 *
 * Returning 429 with `Retry-After` is an explicit non-goal of "try the
 * request and say no in the middle"; the limiter runs BEFORE we spend any
 * I/O on dedup or persistence. Fast reject.
 *
 * The limiter is exclusively a source of drops — it never stores state the
 * rest of the app reads. If it misbehaves the worst case is an over-generous
 * limit. That's an operational bug, not a data-integrity bug.
 */

export interface RateLimiterConfig {
  /**
   * Sustained per-org span rate. Bucket size equals this, so a burst of up
   * to `spansPerSec` can land at once before refill matters.
   */
  spansPerSec: number
  /** Daily byte cap per org. Resets on a rolling 24-hour window. */
  bytesPerDay: number
  /** Clock in ms. Defaults to `Date.now`. Tests swap this out. */
  now?: () => number
}

export type RateLimitReason = "spans_per_sec" | "bytes_per_day"

export interface RateLimitDecision {
  allowed: boolean
  reason?: RateLimitReason
  /** Whole seconds; never 0 — the client must wait at least 1s to be useful. */
  retryAfterSeconds?: number
}

interface OrgState {
  /** Tokens currently available in the spans bucket. */
  spansBucket: number
  /** Epoch-ms at last refill. */
  spansLastRefill: number
  /** Bytes consumed in the current rolling day window. */
  bytesUsedDay: number
  /** Epoch-ms when the current day window opened. */
  bytesDayStartedAt: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export class RateLimiter {
  private readonly cfg: Required<RateLimiterConfig>
  private readonly state = new Map<string, OrgState>()

  constructor(config: RateLimiterConfig) {
    this.cfg = {
      spansPerSec: config.spansPerSec,
      bytesPerDay: config.bytesPerDay,
      now: config.now ?? Date.now,
    }
  }

  /**
   * Atomically decide whether `orgId` may post `spanCount` spans of
   * `byteCount` total bytes, and consume the quota if so.
   *
   * The decision is "all or nothing" per request. We don't partially consume.
   * That keeps the 429 message honest — either every span in this batch
   * landed or none did.
   */
  check(orgId: string, spanCount: number, byteCount: number): RateLimitDecision {
    const now = this.cfg.now()
    let s = this.state.get(orgId)
    if (!s) {
      s = {
        spansBucket: this.cfg.spansPerSec,
        spansLastRefill: now,
        bytesUsedDay: 0,
        bytesDayStartedAt: now,
      }
      this.state.set(orgId, s)
    }

    // Refill spans bucket at config rate, capped at bucket size.
    const elapsedSec = Math.max(0, (now - s.spansLastRefill) / 1000)
    if (elapsedSec > 0) {
      s.spansBucket = Math.min(
        this.cfg.spansPerSec,
        s.spansBucket + elapsedSec * this.cfg.spansPerSec,
      )
      s.spansLastRefill = now
    }

    // Roll daily window.
    if (now - s.bytesDayStartedAt >= DAY_MS) {
      s.bytesUsedDay = 0
      s.bytesDayStartedAt = now
    }

    // Decide without consuming, so we can surface the right Retry-After.
    if (s.spansBucket < spanCount) {
      const deficit = spanCount - s.spansBucket
      const waitSec = Math.ceil(deficit / this.cfg.spansPerSec)
      return {
        allowed: false,
        reason: "spans_per_sec",
        retryAfterSeconds: Math.max(1, waitSec),
      }
    }
    if (s.bytesUsedDay + byteCount > this.cfg.bytesPerDay) {
      const resetMs = DAY_MS - (now - s.bytesDayStartedAt)
      return {
        allowed: false,
        reason: "bytes_per_day",
        retryAfterSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
      }
    }

    // Consume.
    s.spansBucket -= spanCount
    s.bytesUsedDay += byteCount
    return { allowed: true }
  }

  /** For tests and for operator-triggered resets after config changes. */
  reset(): void {
    this.state.clear()
  }

  /** Exposed so `/metrics` can report current occupancy. Copy, not mutable. */
  snapshot(orgId: string): OrgState | undefined {
    const s = this.state.get(orgId)
    return s ? { ...s } : undefined
  }
}
