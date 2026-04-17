import { describe, test, expect } from "bun:test"
import { RateLimiter } from "../src/rateLimit.ts"

/**
 * Pure unit tests for the token-bucket limiter. No HTTP, no store. The
 * fake clock is the whole point — these must be fully deterministic, no
 * reliance on wall time.
 *
 * Everything the /ingest route does with the limiter (429, Retry-After
 * header, per-reason drop metric) is verified by ingestHardening.test.ts.
 */

function fakeClock() {
  let t = 1_700_000_000_000 // arbitrary epoch-ms anchor
  return {
    now: () => t,
    advanceMs(ms: number) { t += ms },
  }
}

describe("RateLimiter — spans/sec bucket", () => {
  test("first request against a fresh org bucket is allowed", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    const d = rl.check("org_a", 5, 100)
    expect(d.allowed).toBe(true)
  })

  test("exhausting bucket blocks with 429-appropriate reason + retryAfter", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    // Use up 10 tokens.
    expect(rl.check("org_a", 10, 100).allowed).toBe(true)
    // Next span is blocked.
    const d = rl.check("org_a", 1, 10)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("spans_per_sec")
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  test("bucket refills over time and unblocks", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    expect(rl.check("org_a", 10, 100).allowed).toBe(true)
    expect(rl.check("org_a", 1, 10).allowed).toBe(false)

    // After 1 full second, all 10 tokens are back (capped at bucket size).
    clock.advanceMs(1000)
    const d = rl.check("org_a", 10, 100)
    expect(d.allowed).toBe(true)
  })

  test("refill is capped at bucket size (no infinite accrual)", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    // Idle for 10 minutes — then try to spend 11 tokens. Only 10 available.
    clock.advanceMs(10 * 60_000)
    const burst = rl.check("org_a", 11, 100)
    expect(burst.allowed).toBe(false)
    expect(burst.reason).toBe("spans_per_sec")
  })

  test("different orgs have independent buckets", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 5, bytesPerDay: 1e9, now: clock.now })
    expect(rl.check("org_a", 5, 100).allowed).toBe(true)
    // org_a is exhausted; org_b is untouched.
    expect(rl.check("org_a", 1, 10).allowed).toBe(false)
    expect(rl.check("org_b", 5, 100).allowed).toBe(true)
  })

  test("retryAfter is proportional to the deficit", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    expect(rl.check("org_a", 10, 100).allowed).toBe(true)
    // Asking for 20 when bucket is 0 → need 2 full seconds back.
    const d = rl.check("org_a", 20, 100)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(2)
  })
})

describe("RateLimiter — bytes/day bucket", () => {
  test("over-daily-budget blocks with bytes_per_day reason", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 1e6, bytesPerDay: 1000, now: clock.now })
    expect(rl.check("org_a", 1, 900).allowed).toBe(true)
    const d = rl.check("org_a", 1, 200)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("bytes_per_day")
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })

  test("day window rolls after 24h and the bucket resets", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 1e6, bytesPerDay: 1000, now: clock.now })
    expect(rl.check("org_a", 1, 1000).allowed).toBe(true)
    // Same day → still blocked.
    expect(rl.check("org_a", 1, 1).allowed).toBe(false)
    clock.advanceMs(24 * 60 * 60 * 1000 + 1)
    expect(rl.check("org_a", 1, 1000).allowed).toBe(true)
  })
})

describe("RateLimiter — atomic decisions", () => {
  test("denied requests do NOT consume quota (retry after refill works)", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    expect(rl.check("org_a", 10, 100).allowed).toBe(true)
    const d1 = rl.check("org_a", 5, 100)
    expect(d1.allowed).toBe(false)
    // Advance 1s: bucket at +10 tokens, cap 10 → 10 available.
    clock.advanceMs(1000)
    const d2 = rl.check("org_a", 10, 100)
    expect(d2.allowed).toBe(true)
  })

  test("reset() clears all per-org buckets", () => {
    const clock = fakeClock()
    const rl = new RateLimiter({ spansPerSec: 10, bytesPerDay: 1e9, now: clock.now })
    expect(rl.check("org_a", 10, 100).allowed).toBe(true)
    expect(rl.check("org_a", 1, 10).allowed).toBe(false)
    rl.reset()
    expect(rl.check("org_a", 10, 100).allowed).toBe(true)
  })
})
